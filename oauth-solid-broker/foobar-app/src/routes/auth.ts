import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { passwordAuthRequestSchema, passwordAuthResponseSchema } from '../schemas/authSchema';
import type { AppContext } from '../types/app';

const auth = new Hono<AppContext>();

auth.post('/password', async (c) => {
  const payload = await c.req
    .json()
    .catch(() => {
      throw new HTTPException(400, {
        message: 'Request body must be valid JSON',
      });
    })
    .then((body) => passwordAuthRequestSchema.parse(body));

  const stytchService = c.get('stytchService');
  const authResult = await stytchService.authenticatePassword(payload);

  const response = passwordAuthResponseSchema.parse({
    sessionToken: authResult.sessionToken,
    sessionJwt: authResult.sessionJwt,
    userId: authResult.user.user_id,
    sessionExpiresAt: authResult.session.expires_at,
  });

  return c.json({ data: response });
});

export default auth;
