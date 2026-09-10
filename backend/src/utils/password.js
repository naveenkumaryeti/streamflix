import bcrypt from 'bcryptjs';
import config from '../config/env.js';

// 12 rounds is the current sensible default for bcrypt; tests drop to 4 to stay fast.
const ROUNDS = config.isTest ? 4 : 12;

export function hashPassword(plain) {
  return bcrypt.hash(plain, ROUNDS);
}

export function verifyPassword(plain, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(plain, hash);
}

/**
 * Password policy, enforced in one place so the API and the seed script agree.
 * Returns the list of unmet requirements (empty means acceptable).
 */
export function passwordProblems(password = '') {
  const problems = [];
  if (password.length < 8) problems.push('at least 8 characters');
  if (!/[A-Za-z]/.test(password)) problems.push('a letter');
  if (!/\d/.test(password)) problems.push('a number');
  return problems;
}
