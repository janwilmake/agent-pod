import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import { loadConfig } from './config/env';
import { getPrismaClient } from './db';
import usersRoutes from './routes/users';
import authRoutes from './routes/auth';
import postsRoutes from './routes/posts';
import { PostRepository } from './repositories/postRepository';
import { StytchService } from './services/stytchService';
import { buildPostService } from './services/postService';
import { buildUserService } from './services/userService';
import type { AppContext } from './types/app';
import { AppError } from './utils/errors';

const app = new Hono<AppContext>();

app.use('*', async (c, next) => {
  const config = loadConfig(c.env);
  const prisma = getPrismaClient(config.DATABASE_URL);
  const stytchService = new StytchService(config);
  const { userService, userRepository } = buildUserService(prisma, stytchService);
  const postService = buildPostService(new PostRepository(prisma), userRepository);

  c.set('config', config);
  c.set('prisma', prisma);
  c.set('stytchService', stytchService);
  c.set('userService', userService);
  c.set('postService', postService);
  await next();
});

app.get('/', (c) =>
  c.json({
    name: 'Foobar API',
    version: 'v1',
  }),
);

app.get('/health', (c) => c.json({ status: 'ok' }));

app.route('/api/users', usersRoutes);
app.route('/api/auth', authRoutes);
app.route('/api/posts', postsRoutes);

app.notFound((c) => c.json({ error: 'Not Found' }, asStatus(404)));

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  if (err instanceof AppError) {
    return c.json(
      {
        error: err.message,
        details: err.details,
      },
      asStatus(err.status ?? 500),
    );
  }

  if (err instanceof ZodError) {
    return c.json(
      {
        error: 'Validation failed',
        details: err.errors,
      },
      asStatus(422),
    );
  }

  console.error(err);

  return c.json({ error: 'Internal Server Error' }, asStatus(500));
});

function asStatus(code: number): ContentfulStatusCode {
  return code as ContentfulStatusCode;
}

export default app;
