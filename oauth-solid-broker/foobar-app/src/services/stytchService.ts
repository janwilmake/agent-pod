import { z } from 'zod';
import { resolveStytchBaseUrl } from '../config/env';
import type { AppEnv } from '../config/env';
import type { PasswordAuthRequest } from '../schemas/authSchema';
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

const stytchEmailSchema = z.object({
  email: z.string().email(),
  email_id: z.string(),
  verified: z.boolean(),
});

const stytchNameSchema = z
  .object({
    first_name: z.string().optional().default(''),
    last_name: z.string().optional().default(''),
    middle_name: z.string().optional().default(''),
  })
  .passthrough();

const stytchUserSchema = z
  .object({
    user_id: z.string(),
    name: stytchNameSchema.optional(),
    emails: z.array(stytchEmailSchema).optional(),
    trusted_metadata: z.record(z.unknown()).optional(),
    untrusted_metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

const stytchSessionSchema = z
  .object({
    session_id: z.string(),
    user_id: z.string(),
    started_at: z.string().optional(),
    last_accessed_at: z.string().optional(),
    expires_at: z.string(),
    attributes: z.record(z.unknown()).optional(),
    authentication_factors: z.array(z.record(z.unknown())).optional(),
  })
  .passthrough();

const stytchCreateUserResponseSchema = z
  .object({
    user_id: z.string(),
    user: stytchUserSchema.optional(),
  })
  .passthrough();

const stytchPasswordCreateResponseSchema = z
  .object({
    request_id: z.string(),
    status_code: z.number(),
    email_id: z.string(),
    session_token: z.string().nullable().optional(),
    session_jwt: z.string().nullable().optional(),
    session: stytchSessionSchema.nullable().optional(),
    user_id: z.string(),
    user: stytchUserSchema,
  })
  .passthrough();

const stytchPasswordAuthenticateResponseSchema = z
  .object({
    request_id: z.string(),
    status_code: z.number(),
    session_token: z.string(),
    session_jwt: z.string(),
    session: stytchSessionSchema,
    user_id: z.string(),
    user: stytchUserSchema,
  })
  .passthrough();

const stytchSessionAuthenticateResponseSchema = z
  .object({
    request_id: z.string(),
    session: stytchSessionSchema.nullable().optional(),
    session_jwt: z.string().optional().nullable(),
    session_token: z.string().optional().nullable(),
    user: stytchUserSchema,
    user_id: z.string().optional(),
  })
  .passthrough();

export type StytchUserProfile = z.infer<typeof stytchUserSchema>;
export type StytchSession = z.infer<typeof stytchSessionSchema>;

export type SessionCredential = {
  session_jwt?: string;
  session_token?: string;
};

export type PasswordAuthenticationResult = {
  sessionToken: string;
  sessionJwt: string;
  session: StytchSession;
  user: StytchUserProfile;
};

export type SessionAuthenticationResult = {
  session: StytchSession;
  user: StytchUserProfile;
  sessionToken?: string;
  sessionJwt?: string;
};

type ParsedName = {
  first_name?: string;
  last_name?: string;
};

export class StytchService {
  constructor(private readonly config: AppEnv) {}

  async createUser(input: CreateUserRequest): Promise<{ user_id: string }> {
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
      await this.updateUserName(baseUrl, credentials, user_id, name);
    }

    return { user_id };
  }

  async authenticatePassword(input: PasswordAuthRequest): Promise<PasswordAuthenticationResult> {
    const baseUrl = resolveStytchBaseUrl(this.config);
    const credentials = buildBasicAuth(this.config);

    const payload = {
      email: input.email,
      password: input.password,
      session_duration_minutes: input.sessionDurationMinutes ?? 60,
    };

    const response = await this.request(`${baseUrl}/passwords/authenticate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: credentials,
      },
      body: JSON.stringify(payload),
    });

    const result = stytchPasswordAuthenticateResponseSchema.safeParse(response);
    if (!result.success) {
      throw new AppError('Unexpected response from Stytch while authenticating password', 502, {
        response,
        error: result.error.flatten(),
      });
    }

    return {
      sessionToken: result.data.session_token,
      sessionJwt: result.data.session_jwt,
      session: result.data.session,
      user: result.data.user,
    };
  }

  async authenticateSession(credential: SessionCredential): Promise<SessionAuthenticationResult> {
    if (!credential.session_jwt && !credential.session_token) {
      throw new AppError('Missing session credential', 401);
    }

    const baseUrl = resolveStytchBaseUrl(this.config);
    const credentials = buildBasicAuth(this.config);
    const body = credential.session_jwt
      ? { session_jwt: credential.session_jwt }
      : { session_token: credential.session_token };

    const response = await this.request(`${baseUrl}/sessions/authenticate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: credentials,
      },
      body: JSON.stringify(body),
    });

    const result = stytchSessionAuthenticateResponseSchema.safeParse(response);
    if (!result.success) {
      throw new AppError('Unexpected response from Stytch while authenticating session', 502, {
        response,
        error: result.error.flatten(),
      });
    }

    if (!result.data.session) {
      throw new AppError('Stytch session authentication succeeded without session payload', 502, {
        response,
      });
    }

    return {
      session: result.data.session,
      user: result.data.user,
      sessionJwt: result.data.session_jwt ?? undefined,
      sessionToken: result.data.session_token ?? undefined,
    };
  }

  private async updateUserName(
    baseUrl: string,
    credentials: string,
    userId: string,
    name: ParsedName,
  ): Promise<void> {
    const updateResponse = await this.request(
      `${baseUrl}/users/${encodeURIComponent(userId)}`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: credentials,
        },
        body: JSON.stringify({ name }),
      },
    );

    const updateResult = stytchCreateUserResponseSchema.safeParse(updateResponse);
    if (!updateResult.success) {
      throw new AppError('Unexpected response from Stytch while updating user name', 502, {
        response: updateResponse,
        error: updateResult.error.flatten(),
      });
    }
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
