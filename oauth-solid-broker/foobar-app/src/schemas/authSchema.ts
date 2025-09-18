import { z } from 'zod';
import { passwordSchema } from './userSchema';

export const passwordAuthRequestSchema = z.object({
  email: z.string().email(),
  password: passwordSchema,
  sessionDurationMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .optional(),
});

export type PasswordAuthRequest = z.infer<typeof passwordAuthRequestSchema>;

export const passwordAuthResponseSchema = z.object({
  sessionToken: z.string(),
  sessionJwt: z.string(),
  userId: z.string(),
  sessionExpiresAt: z.string().datetime(),
});

export type PasswordAuthResponse = z.infer<typeof passwordAuthResponseSchema>;
