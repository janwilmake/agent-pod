import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createUserRequestSchema } from '../schemas/userSchema';
import type { AppContext } from '../types/app';

const users = new Hono<AppContext>();

users.post('/', async (c) => {
  const payload = await c.req
    .json()
    .catch(() => {
      throw new HTTPException(400, {
        message: 'Request body must be valid JSON',
      });
    })
    .then((body) => createUserRequestSchema.parse(body));

  const service = c.get('userService');
  const user = await service.createUser(payload);

  return c.json({ data: user }, 201);
});

export default users;
