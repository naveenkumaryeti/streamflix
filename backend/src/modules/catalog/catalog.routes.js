import { Router } from 'express';
import validate from '../../middleware/validate.js';
import { optionalAuth, requireAuth } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import * as controller from './catalog.controller.js';
import {
  listQuerySchema,
  paginationQuerySchema,
  searchQuerySchema,
  slugParamSchema,
  suggestQuerySchema,
  titleIdParamSchema,
} from './catalog.schemas.js';

/**
 * Catalogue reads are public: an anonymous visitor sees the same rows a subscriber does,
 * which is what makes the landing page useful. `optionalAuth` therefore never rejects —
 * it only upgrades the response with per-user extras (my-list flags, continue watching).
 * The subscription gate lives on playback, not on browsing.
 */
const router = Router();

router.get('/browse', optionalAuth, controller.browse);
router.get('/genres', controller.genres);
router.get('/facets', controller.facets);

// Typeahead fires on nearly every keystroke, so it gets its own generous-but-real budget.
router.get(
  '/suggest',
  rateLimit({ name: 'suggest', max: 120, windowSeconds: 60 }),
  validate({ query: suggestQuerySchema }),
  controller.suggest,
);

router.get(
  '/search',
  optionalAuth,
  rateLimit({ name: 'search', max: 60, windowSeconds: 60 }),
  validate({ query: searchQuerySchema }),
  controller.search,
);

router.get('/titles', optionalAuth, validate({ query: listQuerySchema }), controller.listTitles);
// Registered after /titles so the literal path always wins over the slug pattern.
router.get('/titles/:slug', optionalAuth, validate({ params: slugParamSchema }), controller.getTitle);

export default router;

/**
 * Mounted separately at /my-list because it is account data, not catalogue data:
 * every route needs a signed-in user. PUT (not POST) so a double tap is harmless.
 */
export const myListRouter = Router();

myListRouter.use(requireAuth);
myListRouter.get('/', validate({ query: paginationQuerySchema }), controller.myList);
myListRouter.put('/:titleId', validate({ params: titleIdParamSchema }), controller.addToMyList);
myListRouter.delete('/:titleId', validate({ params: titleIdParamSchema }), controller.removeFromMyList);

/** Continue watching is per-user too, and the player polls it on the home screen. */
export const continueWatchingRouter = Router();
continueWatchingRouter.get('/', requireAuth, controller.continueWatching);
