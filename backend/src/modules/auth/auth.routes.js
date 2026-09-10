import { Router } from 'express';
import validate from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { authRateLimit, rateLimit } from '../../middleware/rateLimit.js';
import * as controller from './auth.controller.js';
import {
  changePasswordSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
} from './auth.schemas.js';

const router = Router();

// Credential endpoints are rate limited per IP *and* per email — an attacker spreading a
// password-spray across many accounts is throttled by the first, and a single account
// under brute force is protected by the second.
router.post('/register', authRateLimit(), validate({ body: registerSchema }), controller.register);
router.post('/login', authRateLimit(), validate({ body: loginSchema }), controller.login);

router.post(
  '/refresh',
  rateLimit({ name: 'refresh', max: 60, windowSeconds: 300 }),
  validate({ body: refreshSchema }),
  controller.refresh,
);

router.post('/logout', requireAuth, validate({ body: logoutSchema }), controller.logout);
router.get('/me', requireAuth, controller.me);
router.get('/sessions', requireAuth, controller.sessions);
router.post(
  '/password',
  requireAuth,
  rateLimit({ name: 'password-change', max: 5, windowSeconds: 900, by: 'user' }),
  validate({ body: changePasswordSchema }),
  controller.changePassword,
);

export default router;
