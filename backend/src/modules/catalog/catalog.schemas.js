import { z } from 'zod';

const trimmed = (max) => z.string().trim().max(max);

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(60).optional(),
  genre: trimmed(60).optional(),
  type: z.enum(['movie', 'series']).optional(),
  language: trimmed(12).optional(),
  year: z.coerce.number().int().min(1888).max(2100).optional(),
  sort: z.enum(['popular', 'newest', 'rating', 'title', 'year']).optional(),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1, 'Type something to search for').max(80),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(60).optional(),
});

export const suggestQuerySchema = z.object({
  q: z.string().trim().min(1).max(80),
  limit: z.coerce.number().int().min(1).max(15).optional(),
});

export const slugParamSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{1,120}$/, 'That is not a valid title address'),
});

export const titleIdParamSchema = z.object({
  titleId: z.string().uuid('That is not a valid title id'),
});

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(60).optional(),
});

export default {
  listQuerySchema,
  searchQuerySchema,
  suggestQuerySchema,
  slugParamSchema,
  titleIdParamSchema,
  paginationQuerySchema,
};
