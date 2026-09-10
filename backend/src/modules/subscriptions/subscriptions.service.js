import crypto from 'node:crypto';
import config from '../../config/env.js';
import logger from '../../config/logger.js';
import AppError from '../../utils/AppError.js';
import { withTransaction } from '../../db/postgres.js';
import { remember } from '../../db/redis.js';
import cacheKeys from '../../utils/cacheKeys.js';
import { paginated, parsePagination } from '../../utils/pagination.js';
import * as auditRepo from '../audit/audit.repository.js';
import * as plansRepo from './plans.repository.js';
import * as subscriptionsRepo from './subscriptions.repository.js';
import * as paymentsRepo from './payments.repository.js';
import { getEntitlement, refreshEntitlement } from './entitlements.js';
import provider from './providers/index.js';

const PLANS_TTL = 300;
const PERIOD_DAYS = 30;

export function listPlans() {
  return remember(cacheKeys.plans(), PLANS_TTL, () => plansRepo.listActive());
}

export async function currentFor(userId) {
  const [subscription, entitlement, history] = await Promise.all([
    subscriptionsRepo.findLatest(userId),
    getEntitlement(userId),
    subscriptionsRepo.historyFor(userId, 10),
  ]);
  return { subscription, entitlement, history };
}

/** Receipts are exactly what the ledger says; nothing is recomputed for display. */
export async function listPayments({ userId, query }) {
  const { page, limit, offset } = parsePagination(query, { defaultLimit: 10, maxLimit: 50 });
  const { rows, total } = await paymentsRepo.listFor(userId, { limit, offset });
  return paginated(rows, { total, page, limit });
}

/**
 * Subscribe or change plan.
 *
 * The order of operations is the part worth reading: charge first, then write. If the write
 * fails after a successful charge we have a `succeeded` payment row with no subscription —
 * visible, reconcilable, and refundable. The reverse order would hand out entitlement for
 * money we never took, which is the failure nobody notices until the audit.
 *
 * `idempotencyKey` makes the whole operation replay-safe: a double-clicked button, a mobile
 * retry after a dropped connection and a webhook retry all land on the same payment row.
 */
export async function subscribe({ userId, planCode, card, idempotencyKey = crypto.randomUUID(), ip }) {
  const plan = await plansRepo.findByCode(planCode);
  if (!plan) throw AppError.notFound('That plan is not available', 'PLAN_NOT_FOUND');

  const existing = await paymentsRepo.findByIdempotencyKey(idempotencyKey);
  if (existing) {
    // Replay: return the original outcome rather than charging again.
    if (existing.status === 'failed') {
      throw AppError.payment(existing.failureReason ?? 'That payment did not go through');
    }
    return {
      replayed: true,
      payment: existing,
      subscription: await subscriptionsRepo.findLive(userId),
      entitlement: await getEntitlement(userId),
    };
  }

  const live = await subscriptionsRepo.findLive(userId);
  if (live && live.planId === plan.id && !live.cancelAtPeriodEnd) {
    throw AppError.conflict(`You are already on the ${plan.name} plan`, 'ALREADY_SUBSCRIBED');
  }

  const outcome = await provider.charge({
    amountCents: plan.priceCents,
    currency: plan.currency,
    card,
    idempotencyKey,
    description: `StreamFlix ${plan.name}`,
  });

  if (outcome.status !== 'succeeded') {
    await paymentsRepo.create({
      userId,
      planId: plan.id,
      subscriptionId: live?.id ?? null,
      amountCents: plan.priceCents,
      currency: plan.currency,
      status: 'failed',
      provider: provider.name,
      providerPaymentId: outcome.providerPaymentId,
      idempotencyKey,
      methodBrand: outcome.brand,
      methodLast4: outcome.last4,
      failureReason: outcome.failureReason,
    });
    auditRepo.record({ actorId: userId, action: 'payment_failed', entityType: 'plan', entityId: plan.code, ip });
    throw AppError.payment(outcome.failureReason ?? 'That payment did not go through');
  }

  // One transaction: the subscription and its receipt commit together or not at all.
  const result = await withTransaction(async (client) => {
    const subscription = live
      ? await subscriptionsRepo.changePlan(live.id, plan.id, client)
      : await subscriptionsRepo.create({ userId, planId: plan.id, periodDays: PERIOD_DAYS }, client);

    const payment = await paymentsRepo.create(
      {
        userId,
        subscriptionId: subscription.id,
        planId: plan.id,
        amountCents: plan.priceCents,
        currency: plan.currency,
        status: 'succeeded',
        provider: provider.name,
        providerPaymentId: outcome.providerPaymentId,
        idempotencyKey,
        methodBrand: outcome.brand,
        methodLast4: outcome.last4,
      },
      client,
    );

    return { subscription, payment };
  });

  const entitlement = await refreshEntitlement(userId);
  auditRepo.record({
    actorId: userId,
    action: live ? 'subscription_changed' : 'subscription_started',
    entityType: 'subscription',
    entityId: result.subscription.id,
    metadata: { planCode: plan.code, amountCents: plan.priceCents },
    ip,
  });

  logger.info({ userId, planCode: plan.code, changed: Boolean(live) }, 'subscription active');
  return { ...result, entitlement, replayed: false };
}

/**
 * Cancelling defaults to end-of-period, because the customer already paid for it. Immediate
 * cancellation is offered separately (account closure uses it) and forfeits the remainder.
 */
export async function cancel({ userId, immediate = false, ip }) {
  const live = await subscriptionsRepo.findLive(userId);
  if (!live) throw AppError.notFound('There is no active plan to cancel', 'NO_ACTIVE_SUBSCRIPTION');

  const subscription = immediate
    ? await subscriptionsRepo.markStatus(live.id, 'canceled').then(() => subscriptionsRepo.findById(live.id))
    : await subscriptionsRepo.setCancelAtPeriodEnd(live.id, true);

  const entitlement = await refreshEntitlement(userId);
  auditRepo.record({
    actorId: userId,
    action: immediate ? 'subscription_canceled_now' : 'subscription_cancel_scheduled',
    entityType: 'subscription',
    entityId: live.id,
    ip,
  });

  return { subscription, entitlement };
}

/** Undo a scheduled cancellation while the period is still running. */
export async function resume({ userId, ip }) {
  const live = await subscriptionsRepo.findLive(userId);
  if (!live) throw AppError.notFound('There is no plan to resume', 'NO_ACTIVE_SUBSCRIPTION');
  if (!live.cancelAtPeriodEnd) return { subscription: live, entitlement: await getEntitlement(userId) };

  const subscription = await subscriptionsRepo.setCancelAtPeriodEnd(live.id, false);
  auditRepo.record({ actorId: userId, action: 'subscription_resumed', entityType: 'subscription', entityId: live.id, ip });
  return { subscription, entitlement: await refreshEntitlement(userId) };
}

/**
 * Provider webhook. Real gateways settle asynchronously and retry aggressively, so this
 * handler is signature-verified, idempotent, and always answers 200 once the signature is
 * good — a 500 to a gateway means the same event arrives again in a minute, forever.
 */
export async function handleWebhook({ header, rawBody }) {
  const verified = provider.verifyWebhook({ header, rawBody });
  if (!verified.ok) throw AppError.badRequest(`Webhook rejected: ${verified.reason}`, 'WEBHOOK_INVALID');

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw AppError.badRequest('Webhook body is not valid JSON');
  }

  const handled = await applyWebhookEvent(event);
  auditRepo.record({ action: `webhook_${event.type ?? 'unknown'}`, entityType: 'payment', entityId: event.data?.paymentId, metadata: handled });
  return { received: true, ...handled };
}

async function applyWebhookEvent(event) {
  const paymentId = event.data?.providerPaymentId ?? event.data?.paymentId ?? null;
  const payment = paymentId
    ? (await paymentsRepo.findByProviderPaymentId(paymentId)) ?? (await paymentsRepo.findById(paymentId).catch(() => null))
    : null;

  switch (event.type) {
    case 'payment.succeeded': {
      if (!payment) return { ignored: 'unknown payment' };
      if (payment.status === 'succeeded') return { idempotent: true }; // retry of an event we already applied
      await paymentsRepo.markStatus(payment.id, 'succeeded');
      if (payment.subscriptionId) {
        await subscriptionsRepo.renew(payment.subscriptionId, PERIOD_DAYS);
        await refreshEntitlement(payment.userId);
      }
      return { applied: 'payment.succeeded', paymentId: payment.id };
    }

    case 'payment.failed': {
      if (!payment) return { ignored: 'unknown payment' };
      await paymentsRepo.markStatus(payment.id, 'failed', { failureReason: event.data?.reason ?? 'Payment failed' });
      // Grace period rather than immediate lockout: dunning is a retry, not a punishment.
      if (payment.subscriptionId) {
        await subscriptionsRepo.markStatus(payment.subscriptionId, 'past_due');
        await refreshEntitlement(payment.userId);
      }
      return { applied: 'payment.failed', paymentId: payment.id };
    }

    case 'subscription.canceled': {
      const subscriptionId = event.data?.subscriptionId;
      if (!subscriptionId) return { ignored: 'no subscription id' };
      const subscription = await subscriptionsRepo.findById(subscriptionId);
      if (!subscription) return { ignored: 'unknown subscription' };
      await subscriptionsRepo.markStatus(subscriptionId, 'canceled');
      await refreshEntitlement(subscription.userId);
      return { applied: 'subscription.canceled', subscriptionId };
    }

    default:
      logger.warn({ type: event.type }, 'unhandled webhook event');
      return { ignored: `unhandled type ${event.type ?? 'missing'}` };
  }
}

/**
 * Worker sweep, run every few minutes: end periods that have elapsed and drop the cached
 * entitlement for everyone affected so the next request sees the truth.
 */
export async function sweepExpired() {
  const ended = await subscriptionsRepo.expireEnded();
  await Promise.all(ended.map((row) => refreshEntitlement(row.userId)));
  if (ended.length) logger.info({ count: ended.length }, 'subscriptions swept');
  return ended;
}

/** Small helper for the frontend: what the checkout form should show before charging. */
export function quote(plan) {
  return {
    planCode: plan.code,
    amountCents: plan.priceCents,
    currency: plan.currency ?? config.payments.currency,
    interval: plan.billingInterval ?? 'month',
    renewsInDays: PERIOD_DAYS,
  };
}
