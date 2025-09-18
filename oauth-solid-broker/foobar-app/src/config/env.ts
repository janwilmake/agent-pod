import { z } from 'zod';

const envSchema = z.object({
  STYTCH_PROJECT_ID: z.string().min(1, 'STYTCH_PROJECT_ID is required'),
  STYTCH_SECRET: z.string().min(1, 'STYTCH_SECRET is required'),
  STYTCH_ENV: z.enum(['test', 'live']).default('test'),
  STYTCH_BASE_URL: z.string().url().optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadConfig(bindings: Record<string, string | undefined>): AppEnv {
  return envSchema.parse(bindings);
}

export function resolveStytchBaseUrl(config: AppEnv): string {
  if (config.STYTCH_BASE_URL) {
    return config.STYTCH_BASE_URL.replace(/\/$/, '');
  }

  return config.STYTCH_ENV === 'live'
    ? 'https://api.stytch.com/v1'
    : 'https://test.stytch.com/v1';
}
