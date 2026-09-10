import asyncHandler from '../../utils/asyncHandler.js';
import * as subscriptionsService from './subscriptions.service.js';

export const plans = asyncHandler(async (_req, res) => {
  res.json({ items: await subscriptionsService.listPlans() });
});

export const current = asyncHandler(async (req, res) => {
  res.json(await subscriptionsService.currentFor(req.user.id));
});

export const subscribe = asyncHandler(async (req, res) => {
  const { planCode, card, idempotencyKey } = req.valid.body;
  const result = await subscriptionsService.subscribe({
    userId: req.user.id,
    planCode,
    card,
    // Header wins over body: it is what HTTP clients and retry libraries set automatically.
    idempotencyKey: req.get('Idempotency-Key') || idempotencyKey,
    ip: req.ip,
  });
  res.status(result.replayed ? 200 : 201).json(result);
});

export const cancel = asyncHandler(async (req, res) => {
  res.json(
    await subscriptionsService.cancel({ userId: req.user.id, immediate: req.valid.body.immediate ?? false, ip: req.ip }),
  );
});

export const resume = asyncHandler(async (req, res) => {
  res.json(await subscriptionsService.resume({ userId: req.user.id, ip: req.ip }));
});

export const payments = asyncHandler(async (req, res) => {
  res.json(await subscriptionsService.listPayments({ userId: req.user.id, query: req.valid.query }));
});

/**
 * Webhook endpoint. `express.raw` is mounted on this route only, because the HMAC covers the
 * exact bytes the provider sent — re-serialising a parsed body changes them and every
 * signature check fails in a way that looks like a secret mismatch.
 */
export const webhook = asyncHandler(async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
  const result = await subscriptionsService.handleWebhook({
    header: req.get('X-StreamFlix-Signature') || req.get('Stripe-Signature'),
    rawBody,
  });
  res.json(result);
});
