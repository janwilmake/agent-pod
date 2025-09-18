import { describe, it, expect } from 'vitest';

const apiBaseUrl = 'http://localhost:8791';

async function createUser(email: string, password: string) {
  const response = await fetch(`${apiBaseUrl}/api/users`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email,
      name: 'Foobar Test User',
      password,
    }),
  });

  const payload = await response.json().catch(async () => ({ error: await response.text() }));

  if (response.status !== 201) {
    throw new Error(`create user failed: ${response.status} ${JSON.stringify(payload)}`);
  }

  return payload.data as { id: string; email: string; name: string; stytchUserId: string; createdAt: string };
}

async function authenticateUser(email: string, password: string) {
  const response = await fetch(`${apiBaseUrl}/api/auth/password`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email,
      password,
    }),
  });

  const payload = await response.json().catch(async () => ({ error: await response.text() }));

  if (!response.ok) {
    throw new Error(`authenticate failed: ${response.status} ${JSON.stringify(payload)}`);
  }

  return payload.data as {
    sessionJwt: string;
    sessionToken: string;
    sessionExpiresAt: string;
    userId: string;
  };
}

describe('Foobar API user lifecycle', () => {
  it('creates a user, authenticates, and accesses protected posts', async () => {
    const uniqueSuffix = Math.random().toString(36).slice(2);
    const email = `foobar.e2e+${Date.now()}-${uniqueSuffix}@example.com`;
    const password = 'testPa55w0rd!1';

    const user = await createUser(email, password);
    expect(user.email).toBe(email);
    expect(user.id).toBeTruthy();
    expect(user.stytchUserId).toBeTruthy();

    const auth = await authenticateUser(email, password);
    expect(auth.sessionJwt).toBeTruthy();
    expect(auth.userId).toBe(user.stytchUserId);

    const publicResponse = await fetch(`${apiBaseUrl}/api/posts/public`);
    expect(publicResponse.status).toBe(200);
    const publicPayload = await publicResponse.json();
    expect(Array.isArray(publicPayload.data)).toBe(true);
    expect(publicPayload.data).toHaveLength(1);

    const unauthorizedPosts = await fetch(`${apiBaseUrl}/api/posts`);
    expect(unauthorizedPosts.status).toBe(401);

    const postsResponse = await fetch(`${apiBaseUrl}/api/posts`, {
      headers: {
        Authorization: `Bearer ${auth.sessionJwt}`,
      },
    });
    expect(postsResponse.status).toBe(200);

    const postsPayload = await postsResponse.json();
    expect(Array.isArray(postsPayload.data)).toBe(true);
    expect(postsPayload.data.length).toBeGreaterThan(0);

    const firstPost = postsPayload.data[0];
    expect(firstPost.ownerId).toBe(auth.userId);
  }, 60_000);
});
