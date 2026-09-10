import { z } from 'zod';

const digits = (value) => String(value ?? '').replace(/\D/g, '');
const currentYear = new Date().getFullYear();

/**
 * Card fields are validated but never stored — the service passes them straight to the
 * provider and keeps only the brand and last four. Validating here means an obvious typo
 * costs a 422 instead of a decline on the customer's statement.
 */
const cardSchema = z
  .object({
    number: z
      .string()
      .transform(digits)
      .refine((value) => value.length >= 12 && value.length <= 19, 'Check the card number'),
    name: z.string().trim().min(2, 'Name on the card is needed').max(120),
    expMonth: z.coerce.number().int().min(1).max(12),
    expYear: z.coerce.number().int().min(currentYear).max(currentYear + 25),
    cvc: z
      .string()
      .transform(digits)
      .refine((value) => value.length >= 3 && value.length <= 4, 'Check the security code'),
  })
  .refine(
    (card) => {
      const now = new Date();
      const lastDay = new Date(card.expYear, card.expMonth, 0, 23, 59, 59);
      return lastDay >= now;
    },
    { message: 'That card has expired', path: ['expYear'] },
  );

export const subscribeSchema = z.object({
  planCode: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{2,40}$/, 'That is not a valid plan'),
  card: cardSchema,
  // Client-supplied so a retry of the *same* attempt is recognised as a retry.
  idempotencyKey: z.string().trim().min(8).max(80).optional(),
});

export const cancelSchema = z.object({
  immediate: z.coerce.boolean().optional(),
  reason: z.string().trim().max(240).optional(),
});

export const paymentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export default { subscribeSchema, cancelSchema, paymentsQuerySchema };
