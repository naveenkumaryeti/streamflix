import { z } from 'zod';

export const titleIdParamSchema = z.object({
  titleId: z.string().uuid('That is not a valid title id'),
});

/** The client may reuse a session id across reloads so it keeps its stream slot. */
const sessionId = z.string().uuid().optional();

export const startBodySchema = z.object({
  sessionId,
  // Advisory only: the server never trusts a client-declared quality above the plan ceiling.
  preferredQuality: z.enum(['480p', '720p', '1080p', '4k']).optional(),
});

export const progressBodySchema = z.object({
  positionSeconds: z.coerce.number().min(0).max(24 * 60 * 60),
  durationSeconds: z.coerce.number().min(0).max(24 * 60 * 60).optional(),
  completed: z.coerce.boolean().optional(),
  sessionId,
});

export const stopBodySchema = z.object({
  positionSeconds: z.coerce.number().min(0).max(24 * 60 * 60).optional(),
  durationSeconds: z.coerce.number().min(0).max(24 * 60 * 60).optional(),
  sessionId,
});

export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  includeCompleted: z
    .preprocess((value) => (value === undefined ? undefined : !['0', 'false', 'no'].includes(String(value))), z.boolean())
    .optional(),
});

export default { titleIdParamSchema, startBodySchema, progressBodySchema, stopBodySchema, historyQuerySchema };
