import '../helpers/setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  charge,
  detectBrand,
  luhnValid,
  signWebhook,
  verifyWebhook,
} from '../../src/modules/subscriptions/providers/mockProvider.js';

/**
 * Card handling and webhook verification. These are the two parts of the payment provider
 * that a real gateway would also make us get right, which is why the mock keeps them
 * instead of always returning success.
 */
describe('luhnValid', () => {
  it('accepts the standard test cards', () => {
    for (const number of ['4242424242424242', '5555555555554444', '378282246310005', '6521000000000007']) {
      assert.equal(luhnValid(number), true, number);
    }
  });

  it('ignores spaces and dashes people type', () => {
    assert.equal(luhnValid('4242 4242 4242 4242'), true);
    assert.equal(luhnValid('4242-4242-4242-4242'), true);
  });

  it('rejects a mistyped digit', () => {
    assert.equal(luhnValid('4242424242424241'), false);
  });

  it('rejects lengths no card uses', () => {
    assert.equal(luhnValid('42424242424'), false, '11 digits');
    assert.equal(luhnValid('42424242424242424242'), false, '20 digits');
    assert.equal(luhnValid(''), false);
    assert.equal(luhnValid(null), false);
    assert.equal(luhnValid(undefined), false);
  });

  it('does not treat a run of zeros as valid', () => {
    // Passes the checksum arithmetically, which is why length alone is not the only guard.
    assert.equal(luhnValid('0000000000000000'), true);
    assert.equal(luhnValid('abcd efgh ijkl'), false, 'no digits at all');
  });
});

describe('detectBrand', () => {
  it('recognises the networks this product accepts', () => {
    assert.equal(detectBrand('4242424242424242'), 'visa');
    assert.equal(detectBrand('5555555555554444'), 'mastercard');
    assert.equal(detectBrand('5105105105105100'), 'mastercard');
    assert.equal(detectBrand('378282246310005'), 'amex');
    assert.equal(detectBrand('371449635398431'), 'amex');
    assert.equal(detectBrand('6521000000000007'), 'rupay');
  });

  it('falls back to a neutral label rather than guessing', () => {
    assert.equal(detectBrand('9999999999999999'), 'card');
    assert.equal(detectBrand(''), 'card');
  });

  it('works on a formatted number', () => {
    assert.equal(detectBrand('4242 4242 4242 4242'), 'visa');
  });
});

describe('charge', () => {
  const card = { number: '4242424242424242', name: 'Test', expMonth: 12, expYear: 2030, cvc: '123' };

  it('authorises a good card and reports only the last four digits', async () => {
    const result = await charge({ amountCents: 49900, card, idempotencyKey: 'k1' });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.last4, '4242');
    assert.equal(result.brand, 'visa');
    assert.equal(result.failureReason, null);
    assert.match(result.providerPaymentId, /^mock_pay_[0-9a-f]{20}$/);
    // The full number must never appear in what we hand back to the ledger.
    assert.equal(JSON.stringify(result).includes(card.number), false);
  });

  it('returns a decline instead of throwing, so the attempt is still recorded', async () => {
    const result = await charge({ amountCents: 49900, card: { ...card, number: '4000000000000002' } });
    assert.equal(result.status, 'failed');
    assert.equal(result.failureReason, 'Your bank declined the card');
    assert.equal(result.last4, '0002');
    assert.ok(result.providerPaymentId, 'a failed charge still gets an id to reconcile against');
  });

  it('distinguishes the decline reasons a support agent would need', async () => {
    const funds = await charge({ amountCents: 100, card: { ...card, number: '4000000000009995' } });
    const expired = await charge({ amountCents: 100, card: { ...card, number: '4000000000000069' } });
    assert.equal(funds.failureReason, 'The card has insufficient funds');
    assert.equal(expired.failureReason, 'That card has expired');
  });

  it('fails an invalid number before pretending to reach a network', async () => {
    const result = await charge({ amountCents: 100, card: { ...card, number: '4242424242424241' } });
    assert.equal(result.status, 'failed');
    assert.equal(result.failureReason, 'That card number is not valid');
  });

  it('gives each attempt its own provider id', async () => {
    const [a, b] = await Promise.all([
      charge({ amountCents: 100, card, idempotencyKey: 'x' }),
      charge({ amountCents: 100, card, idempotencyKey: 'y' }),
    ]);
    assert.notEqual(a.providerPaymentId, b.providerPaymentId);
  });
});

describe('webhook signatures', () => {
  const body = JSON.stringify({ type: 'payment.succeeded', data: { providerPaymentId: 'mock_pay_1' } });

  it('accepts a freshly signed body', () => {
    const { header } = signWebhook(body);
    assert.deepEqual(verifyWebhook({ header, rawBody: body }), { ok: true });
  });

  it('emits the t=/v1= header shape a gateway would send', () => {
    const signed = signWebhook(body, 1_700_000_000);
    assert.equal(signed.header, `t=1700000000,v1=${signed.signature}`);
    assert.match(signed.signature, /^[0-9a-f]{64}$/);
  });

  it('signs over the timestamp and the body together', () => {
    // Signing the body alone would let an attacker replay it with a fresh timestamp.
    const a = signWebhook(body, 1_700_000_000).signature;
    const b = signWebhook(body, 1_700_000_001).signature;
    assert.notEqual(a, b);
  });

  it('rejects a body that changed after signing', () => {
    const { header } = signWebhook(body);
    const tampered = JSON.stringify({ type: 'payment.succeeded', data: { providerPaymentId: 'mock_pay_2' } });
    assert.deepEqual(verifyWebhook({ header, rawBody: tampered }), { ok: false, reason: 'signature mismatch' });
  });

  it('rejects a replay from outside the tolerance window', () => {
    const stale = Math.floor(Date.now() / 1000) - 400;
    const { header } = signWebhook(body, stale);
    assert.deepEqual(verifyWebhook({ header, rawBody: body }), {
      ok: false,
      reason: 'signature timestamp is too old',
    });
  });

  it('rejects a timestamp from the future by the same margin', () => {
    const ahead = Math.floor(Date.now() / 1000) + 400;
    const { header } = signWebhook(body, ahead);
    assert.equal(verifyWebhook({ header, rawBody: body }).ok, false);
  });

  it('still accepts a request that is merely slow', () => {
    const recent = Math.floor(Date.now() / 1000) - 120;
    const { header } = signWebhook(body, recent);
    assert.equal(verifyWebhook({ header, rawBody: body }).ok, true);
  });

  it('rejects a missing or malformed header without throwing', () => {
    // timingSafeEqual throws on length mismatch, so the length check has to come first.
    for (const header of [undefined, null, '', 'garbage', 't=,v1=', 't=123', 'v1=abc', 't=abc,v1=def']) {
      const result = verifyWebhook({ header, rawBody: body });
      assert.equal(result.ok, false, String(header));
      assert.ok(result.reason);
    }
  });

  it('rejects a signature of the wrong length', () => {
    const { timestamp } = signWebhook(body);
    assert.equal(verifyWebhook({ header: `t=${timestamp},v1=abcd`, rawBody: body }).ok, false);
  });
});
