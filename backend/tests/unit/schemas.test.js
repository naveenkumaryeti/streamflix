import '../helpers/setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changePasswordSchema, loginSchema, registerSchema } from '../../src/modules/auth/auth.schemas.js';
import { subscribeSchema } from '../../src/modules/subscriptions/subscriptions.schemas.js';
import { progressBodySchema, startBodySchema } from '../../src/modules/playback/playback.schemas.js';

/**
 * Request schemas, tested directly. They do more than reject bad input — the email
 * normalisation and card digit-stripping change what reaches the database and the payment
 * provider, so the transforms matter as much as the refusals.
 */
const problems = (schema, value) => {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

const validRegistration = { email: 'Viewer@Example.COM ', password: 'Test@12345', fullName: '  Asha Menon  ' };

describe('registerSchema', () => {
  it('lowercases and trims the email, so one person cannot register twice', () => {
    // The unique index is on the stored value; without this transform "A@b.com" and
    // "a@b.com" would be two accounts.
    const parsed = registerSchema.parse(validRegistration);
    assert.equal(parsed.email, 'viewer@example.com');
    assert.equal(parsed.fullName, 'Asha Menon');
  });

  it('rejects an address that is not an email', () => {
    assert.deepEqual(problems(registerSchema, { ...validRegistration, email: 'viewer@' }), [
      'That does not look like an email address',
    ]);
  });

  it('explains every password requirement it fails', () => {
    // The policy lives in passwordProblems; this asserts the schema surfaces all of it.
    assert.deepEqual(problems(registerSchema, { ...validRegistration, password: 'abc' }), [
      'Password needs at least 8 characters',
      'Password needs a number',
    ]);
  });

  it('needs a name of at least two characters', () => {
    assert.deepEqual(problems(registerSchema, { ...validRegistration, fullName: 'A' }), ['Tell us your name']);
    assert.deepEqual(problems(registerSchema, { ...validRegistration, fullName: '   ' }), ['Tell us your name']);
  });

  it('rejects missing fields rather than defaulting them', () => {
    assert.equal(problems(registerSchema, {}).length, 3);
  });
});

describe('loginSchema', () => {
  it('normalises the email the same way registration does', () => {
    assert.equal(loginSchema.parse({ email: ' USER@Example.com', password: 'x' }).email, 'user@example.com');
  });

  it('does not apply the password policy to a login attempt', () => {
    // An account created before a policy change must still be able to sign in — and telling
    // an attacker that a password is too short to be correct leaks information.
    assert.deepEqual(problems(loginSchema, { email: 'a@b.co', password: 'old' }), []);
  });

  it('still requires a password to be present', () => {
    assert.deepEqual(problems(loginSchema, { email: 'a@b.co', password: '' }), ['Enter your password']);
  });
});

describe('changePasswordSchema', () => {
  it('applies the policy to the new password only', () => {
    assert.deepEqual(problems(changePasswordSchema, { currentPassword: 'anything', newPassword: 'Test@12345' }), []);
    assert.deepEqual(problems(changePasswordSchema, { currentPassword: 'anything', newPassword: 'short' }), [
      'Password needs at least 8 characters',
      'Password needs a number',
    ]);
  });

  it('requires the current password, which is what stops a stolen access token', () => {
    assert.deepEqual(problems(changePasswordSchema, { currentPassword: '', newPassword: 'Test@12345' }), [
      'Enter your current password',
    ]);
  });
});

describe('subscribeSchema', () => {
  const card = { number: '4242 4242 4242 4242', name: 'Asha Menon', expMonth: '12', expYear: `${new Date().getFullYear() + 2}`, cvc: '123' };

  it('strips formatting from the card number and coerces the expiry', () => {
    const parsed = subscribeSchema.parse({ planCode: 'standard', card });
    assert.equal(parsed.card.number, '4242424242424242');
    assert.equal(parsed.card.expMonth, 12);
    assert.equal(typeof parsed.card.expYear, 'number');
  });

  it('rejects a card that has already expired', () => {
    const expired = { ...card, expMonth: 1, expYear: new Date().getFullYear() - 1 };
    assert.ok(problems(subscribeSchema, { planCode: 'standard', card: expired }).length > 0);
  });

  it('accepts a card that expires later this month', () => {
    // Cards are valid through the last day of their expiry month; rejecting on the 1st
    // would decline a perfectly good card.
    const now = new Date();
    const thisMonth = { ...card, expMonth: now.getMonth() + 1, expYear: now.getFullYear() };
    assert.deepEqual(problems(subscribeSchema, { planCode: 'standard', card: thisMonth }), []);
  });

  it('checks the obvious typos before the money moves', () => {
    assert.deepEqual(problems(subscribeSchema, { planCode: 'standard', card: { ...card, number: '4242' } }), [
      'Check the card number',
    ]);
    assert.deepEqual(problems(subscribeSchema, { planCode: 'standard', card: { ...card, cvc: '1' } }), [
      'Check the security code',
    ]);
    assert.ok(problems(subscribeSchema, { planCode: 'standard', card: { ...card, expMonth: 13 } }).length > 0);
  });

  it('constrains the plan code to the shape the seed uses', () => {
    for (const planCode of ['mobile', 'standard', 'premium', 'annual-2026']) {
      assert.deepEqual(problems(subscribeSchema, { planCode, card }), [], planCode);
    }
    assert.deepEqual(problems(subscribeSchema, { planCode: 'Premium; DROP TABLE', card }), [
      'That is not a valid plan',
    ]);
  });

  it('treats the idempotency key as optional', () => {
    assert.deepEqual(problems(subscribeSchema, { planCode: 'mobile', card }), []);
    assert.deepEqual(problems(subscribeSchema, { planCode: 'mobile', card, idempotencyKey: 'a'.repeat(12) }), []);
    assert.ok(problems(subscribeSchema, { planCode: 'mobile', card, idempotencyKey: 'short' }).length > 0);
  });

  it('never lets an unknown field through to the provider', () => {
    const parsed = subscribeSchema.parse({ planCode: 'mobile', card: { ...card, pin: '1234' } });
    assert.equal('pin' in parsed.card, false);
  });
});

describe('playback schemas', () => {
  it('accepts an empty start body', () => {
    // The first request from a fresh player has neither a session id nor a preference.
    assert.deepEqual(problems(startBodySchema, {}), []);
  });

  it('requires a position on a progress ping', () => {
    assert.deepEqual(problems(progressBodySchema, { positionSeconds: 42 }), []);
    assert.ok(problems(progressBodySchema, {}).length > 0);
    assert.ok(problems(progressBodySchema, { positionSeconds: -5 }).length > 0);
  });
});
