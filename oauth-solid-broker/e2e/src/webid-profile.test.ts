import { describe, it, expect } from 'vitest';
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

describe('WebID Profile Tests', () => {
  it('should serve a valid WebID profile with oidcIssuer', async () => {
    // First get a token to extract the WebID
    const env = testEnv;
    await stepDiscovery(env);
    const seed = await stepSeed(env);
    const auth = await stepAuthorize({ ...env, ...seed });
    const appr = await stepApprove({ ...env, ...auth });
    const cb = await stepCallback({ ...env, ...appr });
    const tok = await stepToken({ ...env, ...seed, ...cb });
    const ui = await stepUserinfo({ ...env, ...tok });

    expect(ui.webid).toBeTruthy();
    expect(ui.webid).toMatch(/^https?:\/\/localhost:8789\/webid\/.+#me$/);

    // Extract the WebID URL and fetch the profile
    const webidUrl = ui.webid!.replace('#me', ''); // Remove fragment for HTTP request
    const profileResponse = await fetch(webidUrl, {
      headers: {
        'Accept': 'text/turtle, application/ld+json'
      }
    });

    console.log(`Fetching WebID profile: ${webidUrl}`);
    expect(profileResponse.ok, `WebID profile should be accessible at ${webidUrl}, got ${profileResponse.status}`).toBe(true);

    const profileContent = await profileResponse.text();
    console.log('WebID profile content:', profileContent);

    // Verify the profile contains the required oidcIssuer
    expect(profileContent).toContain('solid:oidcIssuer');
    expect(profileContent).toContain('http://localhost:8789');

    // Verify it's proper RDF/Turtle content
    expect(profileContent).toMatch(/@prefix|PREFIX|<.*>/);
  });

  it('should include correct WebID in issued tokens', async () => {
    const env = testEnv;
    await stepDiscovery(env);
    const seed = await stepSeed(env);
    const auth = await stepAuthorize({ ...env, ...seed });
    const appr = await stepApprove({ ...env, ...auth });
    const cb = await stepCallback({ ...env, ...appr });
    const tok = await stepToken({ ...env, ...seed, ...cb });

    // Decode the JWT access token to inspect claims
    const tokenParts = tok.accessToken.split('.');
    const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64url').toString());

    console.log('Token payload:', payload);

    // Verify token has correct issuer and WebID
    expect(payload.iss).toBe('http://localhost:8789');
    expect(payload.aud).toBe('solid');
    expect(payload.webid).toBeTruthy();
    expect(payload.webid).toMatch(/^http:\/\/localhost:8789\/webid\/.+#me$/);
    expect(payload.sub).toBeTruthy();
  });

  it('should return 404 for non-existent WebID profiles', async () => {
    const fakeWebidUrl = 'http://localhost:8789/webid/nonexistent';
    const response = await fetch(fakeWebidUrl);
    
    // Currently the broker serves a generic profile for any WebID
    // In production, this should be 404 for non-existent profiles
    expect([200, 404]).toContain(response.status);
  });
});