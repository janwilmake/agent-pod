import { z } from 'zod';

const passwordRegex = {
  upper: /[A-Z]/,
  lower: /[a-z]/,
  digit: /\d/,
  special: /[^A-Za-z0-9]/,
};

export const createUserRequestSchema = z
  .object({
    email: z.string().email(),
    name: z
      .string()
      .min(1, 'name is required')
      .transform((value) => value.trim())
      .refine((value) => value.length > 0, 'name is required'),
    password: z
      .string()
      .min(10, 'password must be at least 10 characters long')
      .max(128, 'password must be less than 129 characters')
      .superRefine((value, ctx) => {
        if (!passwordRegex.upper.test(value)) {
          ctx.addIssue({ code: 'custom', message: 'password must include an uppercase letter' });
        }
        if (!passwordRegex.lower.test(value)) {
          ctx.addIssue({ code: 'custom', message: 'password must include a lowercase letter' });
        }
        if (!passwordRegex.digit.test(value)) {
          ctx.addIssue({ code: 'custom', message: 'password must include a digit' });
        }
        if (!passwordRegex.special.test(value)) {
          ctx.addIssue({ code: 'custom', message: 'password must include a special character' });
        }
      }),
  })
  .transform((payload) => ({
    ...payload,
    name: normalizeWhitespace(payload.name),
  }));

export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

export const userRecordSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  stytchUserId: z.string(),
  createdAt: z.string().datetime(),
});

export type UserRecord = z.infer<typeof userRecordSchema>;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
