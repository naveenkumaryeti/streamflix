import { z } from 'zod';
import { passwordProblems } from '../../utils/password.js';

const email = z
  .string()
  .trim()
  .min(3, 'Enter your email address')
  .max(320)
  .email('That does not look like an email address')
  .transform((value) => value.toLowerCase());

// Password rules live in one function so the API and the UI can never disagree.
const password = z.string().superRefine((value, ctx) => {
  for (const problem of passwordProblems(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Password needs ${problem}` });
  }
});

export const registerSchema = z.object({
  email,
  password,
  fullName: z.string().trim().min(2, 'Tell us your name').max(120),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(20, 'Missing refresh token').optional(),
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(20).optional(),
  everywhere: z.boolean().optional().default(false),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: password,
});

export default { registerSchema, loginSchema, refreshSchema, logoutSchema, changePasswordSchema };
