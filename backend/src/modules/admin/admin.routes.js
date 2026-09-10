import { Router } from 'express';
import multer from 'multer';
import config from '../../config/env.js';
import AppError from '../../utils/AppError.js';
import validate from '../../middleware/validate.js';
import { requireAdmin } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import * as controller from './admin.controller.js';
import {
  artworkKindParamSchema,
  auditQuerySchema,
  createTitleSchema,
  paymentsQuerySchema,
  registerSourceSchema,
  titleIdParamSchema,
  titleListQuerySchema,
  unpublishSchema,
  updateTitleSchema,
  uploadKeyQuerySchema,
  uploadUrlSchema,
  userIdParamSchema,
  userListQuerySchema,
  userRoleSchema,
  userStatusSchema,
} from './admin.schemas.js';

/**
 * Everything below the mount point is admin-only, enforced once by the router rather than
 * repeated per route — the pattern that makes a forgotten guard impossible.
 */
const router = Router();

router.use(requireAdmin);
router.use(rateLimit({ name: 'admin', max: 240, windowSeconds: 60, by: 'user' }));

/** Artwork is small and goes through the API; video never does. */
const artwork = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, done) =>
    /^image\/(jpeg|png|webp)$/.test(file.mimetype)
      ? done(null, true)
      : done(AppError.badRequest('Artwork must be a JPEG, PNG or WebP image', 'UNSUPPORTED_IMAGE')),
});

/**
 * Content-Length is a claim, not a guarantee, but rejecting an oversized upload before a
 * single byte is written is worth the one-line check. The storage driver is the backstop.
 */
function guardUploadSize(req, _res, next) {
  const declared = Number(req.get('content-length') ?? 0);
  if (declared > config.media.maxUploadBytes) {
    const gb = (config.media.maxUploadBytes / 1024 ** 3).toFixed(1);
    return next(new AppError(413, 'FILE_TOO_LARGE', `That file is larger than the ${gb} GB limit`));
  }
  return next();
}

router.get('/dashboard', controller.dashboard);
router.get('/options', controller.options);

/**
 * The local-mode upload receiver, mounted before `/titles/:id` so its own `:key` query is not
 * confused with a title route. PUT is what the browser sends against a presigned S3 URL, and
 * POST is accepted too so the same client code works with either driver.
 */
router.put('/media/upload', guardUploadSize, validate({ query: uploadKeyQuerySchema }), controller.uploadObject);
router.post('/media/upload', guardUploadSize, validate({ query: uploadKeyQuerySchema }), controller.uploadObject);

router.get('/titles', validate({ query: titleListQuerySchema }), controller.listTitles);
router.post('/titles', validate({ body: createTitleSchema }), controller.createTitle);

router.get('/titles/:id', validate({ params: titleIdParamSchema }), controller.getTitle);
router.patch(
  '/titles/:id',
  validate({ params: titleIdParamSchema, body: updateTitleSchema }),
  controller.updateTitle,
);
router.delete('/titles/:id', validate({ params: titleIdParamSchema }), controller.deleteTitle);

router.post(
  '/titles/:id/upload-url',
  validate({ params: titleIdParamSchema, body: uploadUrlSchema }),
  controller.uploadTarget,
);
router.post(
  '/titles/:id/source',
  validate({ params: titleIdParamSchema, body: registerSourceSchema }),
  controller.registerSource,
);
router.post('/titles/:id/transcode', validate({ params: titleIdParamSchema }), controller.startTranscode);
router.get('/titles/:id/media', validate({ params: titleIdParamSchema }), controller.media);

router.post(
  '/titles/:id/artwork/:kind',
  artwork.single('file'),
  validate({ params: artworkKindParamSchema }),
  controller.uploadArtwork,
);

router.post('/titles/:id/publish', validate({ params: titleIdParamSchema }), controller.publishTitle);
router.post(
  '/titles/:id/unpublish',
  validate({ params: titleIdParamSchema, body: unpublishSchema }),
  controller.unpublishTitle,
);

router.get('/users', validate({ query: userListQuerySchema }), controller.listUsers);
router.patch(
  '/users/:id/status',
  validate({ params: userIdParamSchema, body: userStatusSchema }),
  controller.setUserStatus,
);
router.patch('/users/:id/role', validate({ params: userIdParamSchema, body: userRoleSchema }), controller.setUserRole);

router.get('/payments', validate({ query: paymentsQuerySchema }), controller.listPayments);
router.get('/audit', validate({ query: auditQuerySchema }), controller.listAudit);

export default router;
