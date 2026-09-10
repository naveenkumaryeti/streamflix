import { Router } from 'express';
import authRoutes from './modules/auth/auth.routes.js';
import usersRoutes from './modules/users/users.routes.js';
import catalogRoutes, { continueWatchingRouter, myListRouter } from './modules/catalog/catalog.routes.js';
import playbackRoutes from './modules/playback/playback.routes.js';
import subscriptionsRoutes from './modules/subscriptions/subscriptions.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';

/**
 * The versioned API surface, in one place.
 *
 * Two conventions worth knowing when reading the frontend against this:
 *
 *  - Catalogue routes sit at the prefix root (`/api/v1/browse`, `/api/v1/titles/:slug`)
 *    rather than under `/catalog`, because browsing *is* the product; the noun would add
 *    nothing but length to every URL a customer's browser requests.
 *  - Anything that belongs to one account gets its own mount (`/my-list`,
 *    `/continue-watching`, `/playback`), so the authentication requirement is visible from
 *    the path instead of buried in a per-route guard.
 *
 * Mount order matters exactly once: `/titles` is registered inside the catalogue router
 * before `/titles/:slug`, which is why the literal path always wins.
 */
const router = Router();

router.get('/', (_req, res) => {
  res.json({
    service: 'streamflix-api',
    resources: [
      'auth',
      'users',
      'browse',
      'titles',
      'search',
      'genres',
      'my-list',
      'continue-watching',
      'playback',
      'subscriptions',
      'admin',
    ],
  });
});

router.use('/auth', authRoutes);
router.use('/users', usersRoutes);

router.use('/', catalogRoutes);
router.use('/my-list', myListRouter);
router.use('/continue-watching', continueWatchingRouter);

router.use('/playback', playbackRoutes);
router.use('/subscriptions', subscriptionsRoutes);
router.use('/admin', adminRoutes);

export default router;
