import { z } from 'zod';
import { resolveStytchBaseUrl } from '../config/env';
import type { AppEnv } from '../config/env';
import type { CreateUserRequest } from '../schemas/userSchema';
import { AppError } from '../utils/errors';

declare const Buffer:
  | undefined
  | {
      from(data: string, encoding: string): { toString(encoding: string): string };
    };

const stytchErrorSchema = z
  .object({
    status_code: z.number().optional(),
    request_id: z.string().optional(),
    error_type: z.string().optional(),
    error_message: z.string().optional(),
    error_description: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

const stytchPasswordCreateResponseSchema = z
  .object({
    status_code: z.number(),
    email_id: z.string(),
    user_id: z.string(),
    user: z
      .object({
        user_id: z.string(),
        name: z
          .object({
            first_name: z.string().optional().default(''),
            last_name: z.string().optional().default(''),
            middle_name: z.string().optional().default(''),
          })
          .passthrough(),
        emails: z
          .array(
            z.object({
              email: z.string().email(),
              email_id: z.string(),
              verified: z.boolean(),
            }),
          )
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

const stytchUpdateUserResponseSchema = z
  .object({
    user_id: z.string(),
    user: z
      .object({
        user_id: z.string(),
        name: z
          .object({
            first_name: z.string().optional().default(''),
            last_name: z.string().optional().default(''),
            middle_name: z.string().optional().default(''),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export type StytchUser = {
  user_id: string;
};

type ParsedName = {
  first_name?: string;
  last_name?: string;
};

export class StytchService {
  constructor(private readonly config: AppEnv) {}

  async createUser(input: CreateUserRequest): Promise<StytchUser> {
    const baseUrl = resolveStytchBaseUrl(this.config);
    const credentials = buildBasicAuth(this.config);

    const passwordResponse = await this.request(
      `${baseUrl}/passwords`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: credentials,
        },
        body: JSON.stringify({
          email: input.email,
          password: input.password,
        }),
      },
    );

    const passwordResult = stytchPasswordCreateResponseSchema.safeParse(passwordResponse);
    if (!passwordResult.success) {
      throw new AppError('Unexpected response from Stytch while creating user password', 502, {
        response: passwordResponse,
        error: passwordResult.error.flatten(),
      });
    }

    const { user_id } = passwordResult.data;
    const name = parseName(input.name);

    if (name) {
      const updateResponse = await this.request(
        `${baseUrl}/users/${encodeURIComponent(user_id)}`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            authorization: credentials,
          },
          body: JSON.stringify({ name }),
        },
      );

      const updateResult = stytchUpdateUserResponseSchema.safeParse(updateResponse);
      if (!updateResult.success) {
        throw new AppError('Unexpected response from Stytch while updating user name', 502, {
          response: updateResponse,
          error: updateResult.error.flatten(),
        });
      }
    }

    return { user_id };
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(url, init);
    const parsed = await this.safeJson(response);

    if (!response.ok) {
      const stytchError = stytchErrorSchema.safeParse(parsed);
      const reason =
        stytchError.success &&
        (stytchError.data.error_description ||
          stytchError.data.error_message ||
          stytchError.data.message ||
          stytchError.data.error_type);

      throw new AppError(reason || 'Stytch API request failed', response.status as number, parsed);
    }

    return parsed;
  }

  private async safeJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }
}

function buildBasicAuth(config: AppEnv): string {
  const value = `${config.STYTCH_PROJECT_ID}:${config.STYTCH_SECRET}`;
  const encoded = encodeBase64(value);
  return `Basic ${encoded}`;
}

function parseName(fullName: string): ParsedName | null {
  const parts = fullName
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.length) {
    return null;
  }

  const [first, ...rest] = parts;
  const last = rest.join(' ');

  return {
    first_name: first,
    ...(last ? { last_name: last } : {}),
  } satisfies ParsedName;
}

function encodeBase64(value: string): string {
  if (typeof btoa === 'function') {
    return btoa(value);
  }

  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);

  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }

  if (typeof Buffer !== 'undefined') {
    // Buffer may exist when running under wrangler dev (Node.js)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return Buffer.from(value, 'utf-8').toString('base64');
  }

  // Polyfill for environments without Buffer/btoa
  const base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let result = '';
  let i = 0;

  while (i < binary.length) {
    const chr1 = binary.charCodeAt(i++);
    const chr2 = binary.charCodeAt(i++);
    const chr3 = binary.charCodeAt(i++);

    const enc1 = chr1 >> 2;
    const enc2 = ((chr1 & 3) << 4) | (chr2 >> 4);
    const enc3 = ((chr2 & 15) << 2) | (chr3 >> 6);
    const enc4 = chr3 & 63;

    if (Number.isNaN(chr2)) {
      result += `${base64Chars.charAt(enc1)}${base64Chars.charAt(enc2)}==`;
    } else if (Number.isNaN(chr3)) {
      result += `${base64Chars.charAt(enc1)}${base64Chars.charAt(enc2)}${base64Chars.charAt(enc3)}=`;
    } else {
      result +=
        base64Chars.charAt(enc1) +
        base64Chars.charAt(enc2) +
        base64Chars.charAt(enc3) +
        base64Chars.charAt(enc4);
    }
  }

  return result;
}
