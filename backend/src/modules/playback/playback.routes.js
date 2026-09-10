import { Router } from 'express';
import validate from '../../middleware/validate.js';
import { requireActiveSubscription, requireAuth } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import * as controller from './playback.controller.js';
import {
  historyQuerySchema,
  progressBodySchema,
  startBodySchema,
  stopBodySchema,
  titleIdParamSchema,
} from './playback.schemas.js';

const router = Router();

router.use(requireAuth);

// Reading your own history needs an account but not a live plan — a lapsed subscriber
// should still see where they left off, which is exactly what wins them back.
router.get('/history', validate({ query: historyQuerySchema }), controller.history);
router.get('/streams', controller.activeStreams);
router.delete('/progress/:titleId', validate({ params: titleIdParamSchema }), controller.forget);

/**
 * Starting a stream is the one endpoint that checks entitlement *and* stream count, so it
 * is also the one worth rate limiting: a client looping /start would otherwise churn
 * signature generation and slot bookkeeping.
 */
router.post(
  '/:titleId/start',
  requireActiveSubscription,
  rateLimit({ name: 'playback-start', max: 30, windowSeconds: 60, by: 'user' }),
  validate({ params: titleIdParamSchema, body: startBodySchema }),
  controller.start,
);

// Pings arrive every ~30s per stream; the ceiling is generous but not unbounded.
router.post(
  '/:titleId/progress',
  rateLimit({ name: 'playback-progress', max: 120, windowSeconds: 60, by: 'user' }),
  validate({ params: titleIdParamSchema, body: progressBodySchema }),
  controller.ping,
);

router.post('/:titleId/stop', validate({ params: titleIdParamSchema, body: stopBodySchema }), controller.stop);

export default router;
