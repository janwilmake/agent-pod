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
  const publicFileUrl = 'http://localhost:3000/public/test-file.txt';
  const publicFileContent = `Hello from Foobar public file!\nUpdated at: ${new Date().toISOString()}`;

  let privateFileUrl: string;
  let privateFileContent: string;
  let privateFileAclUrl: string;

  const putFile = async (url: string, body: string, contentType: string) => {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${context.accessToken}`,
        'Content-Type': contentType
      },
      body
    });

    if (![200, 201, 202, 204, 205].includes(response.status)) {
      const error = await response.text();
      throw new Error(`Failed to seed CSS file at ${url}: ${response.status} ${error}`);
    }
  };

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

    privateFileUrl = `http://localhost:3000/private/${context.sub}/profile.ttl`;
    privateFileAclUrl = `${privateFileUrl}.acl`;
    privateFileContent = `@prefix foaf: <http://xmlns.com/foaf/0.1/> .\n@prefix solid: <http://www.w3.org/ns/solid/terms#> .\n\n<#me> a foaf:Person ;\n  foaf:name "Foobar Test User" ;\n  solid:oidcIssuer <http://localhost:8789> .\n`;

    // Seed CSS with known resources we can assert against
    await putFile(publicFileUrl, publicFileContent, 'text/plain');
    await putFile(privateFileUrl, privateFileContent, 'text/turtle');
    await putFile(privateFileAclUrl,
      `@prefix acl: <http://www.w3.org/ns/auth/acl#> .\n\n<#owner> a acl:Authorization ;\n  acl:agent <${context.webid}> ;\n  acl:accessTo <${privateFileUrl}> ;\n  acl:mode acl:Read, acl:Write, acl:Append, acl:Control .\n`,
      'text/turtle');
  });

  it('should read a public test file from Community Server', async () => {
    const response = await fetch(publicFileUrl, {
      headers: {
        'Authorization': `Bearer ${context.accessToken}`
      }
    });

    console.log(`Reading public file: ${publicFileUrl} -> ${response.status}`);

    expect(response.status).toBe(200);
    const content = await response.text();
    expect(content).toBe(publicFileContent);
  });

  it('should access private file with proper WebID authorization', async () => {
    const unauthorizedResponse = await fetch(privateFileUrl, {
      headers: {
        'Accept': 'text/turtle'
      }
    });

    console.log(`Reading private file without auth: ${privateFileUrl} -> ${unauthorizedResponse.status}`);
    expect([401, 403]).toContain(unauthorizedResponse.status);

    const response = await fetch(privateFileUrl, {
      headers: {
        'Authorization': `Bearer ${context.accessToken}`,
        'Accept': 'text/turtle'
      }
    });

    console.log(`Reading private file: ${privateFileUrl} -> ${response.status}`);

    expect(response.status).toBe(200);
    const content = await response.text();
    expect(content).toBe(privateFileContent);
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

    expect([200, 201, 202, 204, 205]).toContain(response.status);

    // If successful, verify we can read it back
    const readResponse = await fetch(newFileUrl, {
      headers: {
        'Authorization': `Bearer ${context.accessToken}`
      }
    });

    expect(readResponse.status).toBe(200);
    const readContent = await readResponse.text();
    expect(readContent).toBe(fileContent);
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
    const testUrl = 'http://localhost:3000/';
    const response = await fetch(testUrl, {
      headers: {
        'Authorization': `Bearer ${context.accessToken}`
      }
    });

    console.log(`CSS token validation test: ${testUrl} -> ${response.status}`);

    expect(response.status).toBe(200);
  });
});
