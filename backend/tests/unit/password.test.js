import '../helpers/setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashPassword, passwordProblems, verifyPassword } from '../../src/utils/password.js';

describe('password hashing', () => {
  it('produces a bcrypt hash that verifies', async () => {
    const hash = await hashPassword('Test@12345');
    assert.match(hash, /^\$2[aby]\$/);
    assert.equal(await verifyPassword('Test@12345', hash), true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('Test@12345');
    assert.equal(await verifyPassword('test@12345', hash), false);
    assert.equal(await verifyPassword('', hash), false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('Test@12345'), hashPassword('Test@12345')]);
    assert.notEqual(a, b);
  });

  it('returns false instead of throwing when a user has no password hash', async () => {
    // Federated or invited accounts can have a null hash; a login attempt must fail
    // cleanly rather than crash bcrypt.
    assert.equal(await verifyPassword('anything', null), false);
    assert.equal(await verifyPassword('anything', undefined), false);
    assert.equal(await verifyPassword('anything', ''), false);
  });
});

describe('passwordProblems', () => {
  it('accepts a password that meets the policy', () => {
    assert.deepEqual(passwordProblems('Test@12345'), []);
    assert.deepEqual(passwordProblems('abcd1234'), []);
  });

  it('lists every unmet requirement at once', () => {
    // One round trip should tell the user everything that is wrong, not just the first thing.
    assert.deepEqual(passwordProblems('abc'), ['at least 8 characters', 'a number']);
    assert.deepEqual(passwordProblems('1234'), ['at least 8 characters', 'a letter']);
    assert.deepEqual(passwordProblems(''), ['at least 8 characters', 'a letter', 'a number']);
  });

  it('requires length, a letter and a digit independently', () => {
    assert.deepEqual(passwordProblems('1234567'), ['at least 8 characters', 'a letter']);
    assert.deepEqual(passwordProblems('abcdefgh'), ['a number']);
    assert.deepEqual(passwordProblems('12345678'), ['a letter']);
  });

  it('does not demand punctuation or mixed case', () => {
    // Deliberate: length and variety beat symbol theatre, and NIST agrees.
    assert.deepEqual(passwordProblems('correcthorse7'), []);
  });

  it('treats a missing argument as empty', () => {
    assert.deepEqual(passwordProblems(), ['at least 8 characters', 'a letter', 'a number']);
  });
});
