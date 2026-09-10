import crypto from 'node:crypto';
import config from '../../../config/env.js';
import logger from '../../../config/logger.js';

/**
 * Mock payment provider.
 *
 * It stands in for Stripe/Razorpay and deliberately keeps their two hard parts, because
 * those are the parts that break in production:
 *
 *   1. Idempotency — the caller supplies a key and a retry returns the first outcome.
 *   2. Signed webhooks — asynchronous settlement is verified with an HMAC over
 *      `<timestamp>.<raw body>`, and stale timestamps are rejected to stop replays.
 *
 * Swapping in a real gateway means implementing `charge` and `verifyWebhook` against their
 * SDK; nothing outside this file knows which provider is in use.
 */
export const name = 'mock';

const WEBHOOK_TOLERANCE_SECONDS = 300;

// Test cards follow the conventions people already know from Stripe.
const DECLINES = {
  '4000000000000002': 'Your bank declined the card',
  '4000000000009995': 'The card has insufficient funds',
  '4000000000000069': 'That card has expired',
};

const BRANDS = [
  [/^4/, 'visa'],
  [/^5[1-5]/, 'mastercard'],
  [/^3[47]/, 'amex'],
  [/^6(?:0|5)/, 'rupay'],
];

const digitsOnly = (value) => String(value ?? '').replace(/\D/g, '');

export function detectBrand(cardNumber) {
  const digits = digitsOnly(cardNumber);
  return BRANDS.find(([pattern]) => pattern.test(digits))?.[1] ?? 'card';
}

/** Luhn — the same check a real gateway runs before it ever contacts the network. */
export function luhnValid(cardNumber) {
  const digits = digitsOnly(cardNumber);
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = Number(digits[i]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Charges a card. Returns an outcome object rather than throwing on decline: a declined
 * card is a normal business result that must still be recorded in the ledger.
 */
export async function charge({ amountCents, currency = config.payments.currency, card = {}, idempotencyKey }) {
  const digits = digitsOnly(card.number);
  const last4 = digits.slice(-4);
  const brand = detectBrand(digits);
  const providerPaymentId = `mock_pay_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

  // Simulated network latency, so the frontend's pending state is exercised in development.
  await new Promise((resolve) => setTimeout(resolve, 120));

  if (!luhnValid(digits)) {
    return { status: 'failed', providerPaymentId, brand, last4, failureReason: 'That card number is not valid' };
  }

  const declined = DECLINES[digits];
  if (declined) {
    return { status: 'failed', providerPaymentId, brand, last4, failureReason: declined };
  }

  logger.info({ amountCents, currency, brand, idempotencyKey }, 'mock payment authorised');
  return { status: 'succeeded', providerPaymentId, brand, last4, failureReason: null };
}

export async function refund({ providerPaymentId, amountCents }) {
  logger.info({ providerPaymentId, amountCents }, 'mock refund issued');
  return { status: 'refunded', providerRefundId: `mock_re_${crypto.randomUUID().slice(0, 12)}` };
}

const hmac = (payload) =>
  crypto.createHmac('sha256', config.payments.webhookSecret).update(payload).digest('hex');

/** Exposed so tests and `docs/API.md` can produce a valid header without duplicating logic. */
export function signWebhook(rawBody, timestamp = Math.floor(Date.now() / 1000)) {
  return { timestamp, signature: hmac(`${timestamp}.${rawBody}`), header: `t=${timestamp},v1=${hmac(`${timestamp}.${rawBody}`)}` };
}

function parseHeader(header) {
  const parts = String(header ?? '')
    .split(',')
    .map((part) => part.split('='));
  return {
    timestamp: Number(parts.find(([k]) => k === 't')?.[1] ?? 0),
    signature: parts.find(([k]) => k === 'v1')?.[1] ?? '',
  };
}

/**
 * Verifies a webhook. Constant-time comparison, and a timestamp window so a captured
 * request cannot be replayed tomorrow.
 */
export function verifyWebhook({ header, rawBody }) {
  const { timestamp, signature } = parseHeader(header);
  if (!timestamp || !signature) return { ok: false, reason: 'missing signature header' };

  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, reason: 'signature timestamp is too old' };

  const expected = hmac(`${timestamp}.${rawBody}`);
  const provided = Buffer.from(signature, 'utf8');
  const computed = Buffer.from(expected, 'utf8');
  if (provided.length !== computed.length || !crypto.timingSafeEqual(provided, computed)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}

export default { name, charge, refund, verifyWebhook, signWebhook, detectBrand, luhnValid };
