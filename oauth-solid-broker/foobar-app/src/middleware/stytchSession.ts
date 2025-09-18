import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppContext } from '../types/app';
import { AppError } from '../utils/errors';
import type { SessionCredential } from '../services/stytchService';

export type SessionAuthOptions = {
  getCredential?: (c: Context<AppContext>) => SessionCredential | null | undefined;
  onError?: (c: Context<AppContext>, error: Error) => Response | void | Promise<Response | void>;
};

export function authenticateSession(options?: SessionAuthOptions): MiddlewareHandler<AppContext> {
  const getCredential = options?.getCredential ?? defaultCredentialExtractor;

  return async (c, next) => {
    try {
      const credential = getCredential(c);
      if (!credential || (!credential.session_jwt && !credential.session_token)) {
        throw new HTTPException(toStatus(401), { message: 'Unauthorized' });
      }

      const stytchService = c.get('stytchService');
      const result = await stytchService.authenticateSession(credential);

      c.set('stytchSession', result.session);
      c.set('stytchUser', result.user);

      await next();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      if (options?.onError) {
        const maybeResponse = await options.onError(c, err);
        if (maybeResponse instanceof Response) {
          return maybeResponse;
        }
      }

      if (err instanceof HTTPException) {
        throw err;
      }

      if (err instanceof AppError) {
        throw new HTTPException(toStatus(err.status || 401), { message: err.message });
      }

      throw new HTTPException(toStatus(401), { message: 'Unauthorized' });
    }
  };
}

export function getStytchSession(c: Context<AppContext>) {
  const session = c.get('stytchSession');
  if (!session) {
    throw new HTTPException(toStatus(500), { message: 'Stytch session not available in context' });
  }
  return session;
}

export function getStytchUser(c: Context<AppContext>) {
  const user = c.get('stytchUser');
  if (!user) {
    throw new HTTPException(toStatus(500), { message: 'Stytch user not available in context' });
  }
  return user;
}

function defaultCredentialExtractor(c: Context<AppContext>): SessionCredential | null {
  const authorization = c.req.header('authorization');
  if (authorization && authorization.toLowerCase().startsWith('bearer ')) {
    return { session_jwt: authorization.slice(7).trim() };
  }

  const cookieToken = getCookie(c, 'stytch_session_jwt');
  if (cookieToken) {
    return { session_jwt: cookieToken };
  }

  return null;
}

function toStatus(code: number): ContentfulStatusCode {
  return code as ContentfulStatusCode;
}
