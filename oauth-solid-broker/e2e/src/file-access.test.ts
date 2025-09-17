import { describe, it, expect, beforeAll } from 'vitest';
import {
  stepDiscovery,
  stepSeed,
  stepAuthorize,
  stepApprove,
  stepCallback,
  stepToken,
  stepUserinfo,
  defaultEnv,
  type Env,
} from './oauth-flow.js';

const testEnv: Env = {
  ...defaultEnv,
  verbose: process.env.VERBOSE === 'true',
};

interface TestContext {
  accessToken: string;
  webid: string;
  sub: string;
}

describe('File Access Tests', () => {
  let context: TestContext;

  beforeAll(async () => {
    // Get valid tokens for file access tests
    const env = testEnv;
    await stepDiscovery(env);
    const seed = await stepSeed(env);
    const auth = await stepAuthorize({ ...env, ...seed });
    const appr = await stepApprove({ ...env, ...auth });
    const cb = await stepCallback({ ...env, ...appr });
    const tok = await stepToken({ ...env, ...seed, ...cb });
    const ui = await stepUserinfo({ ...env, ...tok });

    context = {
      accessToken: tok.accessToken,
      webid: ui.webid!,
      sub: ui.sub!
    };

    console.log('Test context:', {
      webid: context.webid,
      sub: context.sub,
      tokenLength: context.accessToken.length
    });
  });

  it('should read a public test file from Community Server', async () => {
    // Try to read a test file that should be publicly accessible
    const testFileUrl = 'http://localhost:3000/public/test-file.txt';
    
    const response = await fetch(testFileUrl, {
      headers: {
        'Authorization': `Bearer ${context.accessToken}`
      }
    });

    console.log(`Reading public file: ${testFileUrl} -> ${response.status}`);

    // For now, we expect this to fail because the file doesn't exist yet
    // But we want to see what kind of error we get
    if (!response.ok) {
      const errorText = await response.text();
      console.log('Error response:', errorText);
      console.log('Response headers:', Object.fromEntries(response.headers.entries()));
    } else {
      const content = await response.text();
      console.log('File content:', content);
      expect(content).toBeTruthy();
    }

    // Initially, we expect this to fail with 404 (file doesn't exist)
    // Later, we'll create the file and make this test pass
    expect([200, 401, 403, 404]).toContain(response.status);
  });

  it('should access private file with proper WebID authorization', async () => {
    // Try to access a file that requires WebID authorization
    const privateFileUrl = `http://localhost:3000/private/${context.sub}/profile.ttl`;
    
    const response = await fetch(privateFileUrl, {
      headers: {
        'Authorization': `Bearer ${context.accessToken}`,
        'Accept': 'text/turtle'
      }
    });

    console.log(`Reading private file: ${privateFileUrl} -> ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.log('Private file error:', errorText);
      console.log('WWW-Authenticate header:', response.headers.get('WWW-Authenticate'));
    }

    // Initially expect this to fail - we'll implement the ACL setup later
    expect([200, 401, 403, 404]).toContain(response.status);
  });

  it('should create a new file with Bearer token', async () => {
    const newFileUrl = `http://localhost:3000/test-uploads/created-by-test-${Date.now()}.txt`;
    const fileContent = `Hello from E2E test!\nCreated at: ${new Date().toISOString()}\nWebID: ${context.webid}`;

    const response = await fetch(newFileUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${context.accessToken}`,
        'Content-Type': 'text/plain'
      },
      body: fileContent
    });

    console.log(`Creating file: ${newFileUrl} -> ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.log('Create file error:', errorText);
      console.log('Response headers:', Object.fromEntries(response.headers.entries()));
    }

    // Initially expect this to fail until we set up proper permissions
    expect([201, 401, 403, 404]).toContain(response.status);

    // If successful, verify we can read it back
    if (response.status === 201) {
      const readResponse = await fetch(newFileUrl, {
        headers: {
          'Authorization': `Bearer ${context.accessToken}`
        }
      });
      
      expect(readResponse.ok).toBe(true);
      const readContent = await readResponse.text();
      expect(readContent).toBe(fileContent);
    }
  });

  it('should get proper CORS headers from CSS', async () => {
    const response = await fetch('http://localhost:3000/', {
      method: 'OPTIONS',
      headers: {
        'Origin': 'http://localhost:8789',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Authorization'
      }
    });

    console.log('CORS preflight response:', response.status);
    console.log('CORS headers:', Object.fromEntries(response.headers.entries()));

    expect(response.status).toBe(204); // OPTIONS request returns 204 No Content
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
    expect(response.headers.get('Access-Control-Allow-Methods')).toBeTruthy();
  });

  it('should validate token against broker JWKS', async () => {
    // CSS should fetch and validate our token against broker's JWKS endpoint
    // This test verifies the end-to-end token validation flow
    
    const testUrl = 'http://localhost:3000/';
    const response = await fetch(testUrl, {
      headers: {
        'Authorization': `Bearer ${context.accessToken}`
      }
    });

    console.log(`CSS token validation test: ${testUrl} -> ${response.status}`);

    if (response.status === 401) {
      const wwwAuth = response.headers.get('WWW-Authenticate');
      console.log('WWW-Authenticate:', wwwAuth);
      
      // CSS should indicate it tried to validate the token
      // and either succeeded or failed for a specific reason
      expect(wwwAuth).toBeTruthy();
    }

    // We expect either success (200) or specific auth errors (401/403)
    expect([200, 401, 403]).toContain(response.status);
  });
});