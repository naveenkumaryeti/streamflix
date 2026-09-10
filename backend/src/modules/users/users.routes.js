import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import validate from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import * as usersService from './users.service.js';
import { closeAccountSchema, updateProfileSchema } from './users.schemas.js';

const router = Router();

router.use(requireAuth);

router.get(
  '/me',
  asyncHandler(async (req, res) => {
    res.json(await usersService.getAccount(req.user.id));
  }),
);

router.patch(
  '/me',
  validate({ body: updateProfileSchema }),
  asyncHandler(async (req, res) => {
    const user = await usersService.updateProfile({ userId: req.user.id, ...req.valid.body, ip: req.ip });
    res.json({ user });
  }),
);

router.delete(
  '/me',
  rateLimit({ name: 'close-account', max: 3, windowSeconds: 3600, by: 'user' }),
  validate({ body: closeAccountSchema }),
  asyncHandler(async (req, res) => {
    res.json(await usersService.closeAccount({ userId: req.user.id, ip: req.ip }));
  }),
);

export default router;
