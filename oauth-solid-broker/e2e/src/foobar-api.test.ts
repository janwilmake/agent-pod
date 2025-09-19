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

  return payload.data as { id: string; email: string; name: string | null; authId: string; createdAt: string };
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
    expect(user.authId).toBeTruthy();

    const auth = await authenticateUser(email, password);
    expect(auth.sessionJwt).toBeTruthy();
    expect(auth.userId).toBe(user.authId);

    const publicResponse = await fetch(`${apiBaseUrl}/api/posts/public`);
    expect(publicResponse.status).toBe(200);
    const publicPayload = await publicResponse.json();
    expect(Array.isArray(publicPayload.data)).toBe(true);
    expect(publicPayload.data).toHaveLength(1);

    const unauthorizedPosts = await fetch(`${apiBaseUrl}/api/posts`);
    expect(unauthorizedPosts.status).toBe(401);

    const createResponse = await fetch(`${apiBaseUrl}/api/posts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.sessionJwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: 'My first post',
        content: 'Hello world from Foobar API tests.',
      }),
    });
    expect(createResponse.status).toBe(201);
    const createdPayload = await createResponse.json();
    expect(createdPayload.data.ownerId).toBe(auth.userId);
    const postId = createdPayload.data.id;

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
    expect(firstPost.id).toBe(postId);

    const getResponse = await fetch(`${apiBaseUrl}/api/posts/${postId}`, {
      headers: {
        Authorization: `Bearer ${auth.sessionJwt}`,
      },
    });
    expect(getResponse.status).toBe(200);
    const getPayload = await getResponse.json();
    expect(getPayload.data.id).toBe(postId);
    expect(getPayload.data.ownerId).toBe(auth.userId);

    const updateResponse = await fetch(`${apiBaseUrl}/api/posts/${postId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${auth.sessionJwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Updated title',
      }),
    });
    expect(updateResponse.status).toBe(200);
    const updatePayload = await updateResponse.json();
    expect(updatePayload.data.title).toBe('Updated title');

    const deleteResponse = await fetch(`${apiBaseUrl}/api/posts/${postId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${auth.sessionJwt}`,
      },
    });
    expect(deleteResponse.status).toBe(204);

    const afterDeleteResponse = await fetch(`${apiBaseUrl}/api/posts/${postId}`, {
      headers: {
        Authorization: `Bearer ${auth.sessionJwt}`,
      },
    });
    expect(afterDeleteResponse.status).toBe(404);
  }, 60_000);
});
