import { z } from 'zod';

export const updateProfileSchema = z
  .object({
    fullName: z.string().trim().min(2, 'Tell us your name').max(120).optional(),
    email: z.string().trim().email('That does not look like an email address').max(320).toLowerCase().optional(),
  })
  .refine((body) => body.fullName !== undefined || body.email !== undefined, {
    message: 'Nothing to update',
  });

export const closeAccountSchema = z.object({
  confirm: z.literal(true, { errorMap: () => ({ message: 'Confirm that you want to close the account' }) }),
});

export default { updateProfileSchema, closeAccountSchema };
