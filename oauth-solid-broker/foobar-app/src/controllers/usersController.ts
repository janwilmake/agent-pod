import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createUserRequestSchema } from '../schemas/userSchema';
import type { AppContext } from '../types/app';

const usersController = new Hono<AppContext>();

usersController.post('/', async (c) => {
  const rawBody = await c.req
    .json()
    .catch(() => {
      throw new HTTPException(400, {
        message: 'Request body must be valid JSON',
      });
    });

  const payload = createUserRequestSchema.parse(rawBody);
  const service = c.get('userService');
  const user = await service.createUser(payload);

  return c.json({ data: user }, 201);
});

export default usersController;
