import express, { Router } from 'express';
import validate from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import * as controller from './subscriptions.controller.js';
import { cancelSchema, paymentsQuerySchema, subscribeSchema } from './subscriptions.schemas.js';

const router = Router();

/**
 * The plans list is public on purpose: pricing is a marketing page, and the signup flow
 * shows it before an account exists.
 */
router.get('/plans', controller.plans);

/**
 * Webhook first, and with its own body parser: it must be reachable without a session and
 * must see the unparsed bytes. Mounted before requireAuth so the router order does the
 * enforcing rather than a per-route exception.
 */
router.post('/webhook', express.raw({ type: '*/*', limit: '256kb' }), controller.webhook);

router.use(requireAuth);

router.get('/me', controller.current);
router.get('/payments', validate({ query: paymentsQuerySchema }), controller.payments);

// Card attempts are the classic target for enumeration, so the ceiling here is deliberately low.
router.post(
  '/',
  rateLimit({ name: 'subscribe', max: 8, windowSeconds: 600, by: 'user', message: 'Too many payment attempts — wait a few minutes' }),
  validate({ body: subscribeSchema }),
  controller.subscribe,
);

router.post('/cancel', validate({ body: cancelSchema }), controller.cancel);
router.post('/resume', controller.resume);

export default router;
