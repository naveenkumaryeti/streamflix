import { z } from 'zod';

/**
 * Admin request shapes.
 *
 * These are stricter than the customer-facing schemas on purpose. An admin payload writes to
 * the catalogue, so anything unrecognised is rejected here (`.strict()`) and, if it somehow
 * got past, the repository's column allowlist would drop it anyway — two locks, one door.
 */
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,120}$/, 'Use lowercase letters, numbers and hyphens, e.g. "inception"');

const shortText = (max) => z.string().trim().max(max);
const people = z.array(z.string().trim().min(1).max(120)).max(40);
const url = z.string().trim().url('That does not look like a URL').max(600);
const nullableUrl = z.union([url, z.literal('')]).transform((value) => value || null);

const CURRENT_YEAR = new Date().getFullYear();

/** Shared between create and update; create marks its own required fields below. */
const titleFields = {
  slug,
  title: shortText(200).min(1, 'A title is required'),
  synopsis: shortText(4000).optional(),
  type: z.enum(['movie', 'series']).optional(),
  releaseYear: z.coerce.number().int().min(1888).max(CURRENT_YEAR + 5).optional(),
  runtimeSeconds: z.coerce.number().int().min(0).max(24 * 3600).optional(),
  maturityRating: shortText(12).optional(),
  language: shortText(12).optional(),
  country: shortText(60).optional(),
  director: shortText(160).optional(),
  cast: people.optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(40).optional(),
  genres: z.array(z.string().trim().min(1).max(60)).max(12).optional(),
  posterUrl: nullableUrl.optional(),
  backdropUrl: nullableUrl.optional(),
  trailerUrl: nullableUrl.optional(),
  demoManifestUrl: nullableUrl.optional(),
  isFeatured: z.coerce.boolean().optional(),
};

export const createTitleSchema = z.object(titleFields).strict();

/** Every field optional, but not *no* fields — an empty PATCH is a mistake worth reporting. */
export const updateTitleSchema = z
  .object({ ...titleFields, slug: slug.optional(), title: shortText(200).min(1).optional() })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Nothing to update' });

export const titleIdParamSchema = z.object({ id: z.string().uuid('That is not a valid title id') });
export const userIdParamSchema = z.object({ id: z.string().uuid('That is not a valid user id') });

export const titleListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(60).optional(),
  search: shortText(120).optional(),
  status: z.enum(['draft', 'uploading', 'processing', 'ready', 'published', 'failed', 'archived']).optional(),
  type: z.enum(['movie', 'series']).optional(),
});

export const userListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(60).optional(),
  search: shortText(120).optional(),
  role: z.enum(['user', 'admin']).optional(),
  status: z.enum(['active', 'suspended', 'deleted']).optional(),
});

export const auditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  action: shortText(60).optional(),
  actorId: z.string().uuid().optional(),
});

export const paymentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(60).optional(),
  status: z.enum(['pending', 'succeeded', 'failed', 'refunded']).optional(),
});

/**
 * Only the filename and content type come from the client — the storage key is derived from
 * the title id, so a crafted name cannot place an object anywhere but this title's prefix.
 */
export const uploadUrlSchema = z
  .object({
    filename: z.string().trim().min(1, 'A filename is needed').max(255),
    contentType: shortText(120).optional(),
    sizeBytes: z.coerce.number().int().positive().optional(),
  })
  .strict();

export const registerSourceSchema = z
  .object({ key: z.string().trim().max(512).optional() })
  .strict();

export const uploadKeyQuerySchema = z.object({
  key: z.string().trim().min(1).max(512),
});

export const unpublishSchema = z
  .object({ status: z.enum(['ready', 'archived', 'draft']).optional() })
  .strict();

export const userStatusSchema = z.object({ status: z.enum(['active', 'suspended']) }).strict();
export const userRoleSchema = z.object({ role: z.enum(['user', 'admin']) }).strict();

export const artworkKindParamSchema = z.object({
  id: z.string().uuid('That is not a valid title id'),
  kind: z.enum(['poster', 'backdrop']),
});

export default {
  createTitleSchema,
  updateTitleSchema,
  titleIdParamSchema,
  userIdParamSchema,
  titleListQuerySchema,
  userListQuerySchema,
  auditQuerySchema,
  paymentsQuerySchema,
  uploadUrlSchema,
  registerSourceSchema,
  uploadKeyQuerySchema,
  unpublishSchema,
  userStatusSchema,
  userRoleSchema,
  artworkKindParamSchema,
};
