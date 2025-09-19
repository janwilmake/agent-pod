import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppContext } from '../types/app';
import { authenticateSession, getStytchSession } from '../middleware/stytchSession';

const posts = new Hono<AppContext>();

posts.get('/public', (c) => {
  return c.json({
    data: [
      {
        id: 'post-public-1',
        title: 'Welcome to Foobar',
        content: 'This is a public announcement that does not require authentication.',
      },
    ],
  });
});

posts.use('*', authenticateSession());

posts.get('/', async (c) => {
  const session = getStytchSession(c);
  const postService = c.get('postService');
  const posts = await postService.listForAuthUser(session.user_id);
  return c.json({ data: posts });
});

posts.post('/', async (c) => {
  const session = getStytchSession(c);
  const postService = c.get('postService');
  const payload = await c.req
    .json()
    .catch(() => {
      throw new HTTPException(400, { message: 'Request body must be valid JSON' });
    });

  const post = await postService.createForAuthUser(session.user_id, payload);
  return c.json({ data: post }, 201);
});

posts.get('/:id', async (c) => {
  const session = getStytchSession(c);
  const postService = c.get('postService');
  const post = await postService.getForAuthUser(session.user_id, c.req.param('id'));
  return c.json({ data: post });
});

posts.patch('/:id', async (c) => {
  const session = getStytchSession(c);
  const postService = c.get('postService');
  const payload = await c.req
    .json()
    .catch(() => {
      throw new HTTPException(400, { message: 'Request body must be valid JSON' });
    });

  const post = await postService.updateForAuthUser(session.user_id, c.req.param('id'), payload);
  return c.json({ data: post });
});

posts.delete('/:id', async (c) => {
  const session = getStytchSession(c);
  const postService = c.get('postService');
  await postService.deleteForAuthUser(session.user_id, c.req.param('id'));
  return c.body(null, 204);
});

export default posts;
