import { Hono } from 'hono';
import type { AppContext } from '../types/app';
import { authenticateSession, getStytchUser } from '../middleware/stytchSession';

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

posts.get('/', authenticateSession(), (c) => {
  const user = getStytchUser(c);
  return c.json({
    data: [
      {
        id: 'post-private-1',
        title: 'Your private post',
        ownerId: user.user_id,
        summary: 'Personalized content visible only to authenticated users.',
      },
    ],
  });
});

export default posts;
