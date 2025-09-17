import { describe, it, expect } from 'vitest';
import {
  stepDiscovery,
  stepSeed,
  stepAuthorize,
  stepApprove,
  stepCallback,
  stepToken,
  stepJwks,
  stepUserinfo,
  stepWebId,
  stepCss,
  defaultEnv,
  type Env,
} from './oauth-flow.js';

const testEnv: Env = {
  ...defaultEnv,
  verbose: process.env.VERBOSE === 'true',
};

describe('OAuth Flow Individual Steps', () => {
  it('discovery endpoint should work', async () => {
    await expect(stepDiscovery(testEnv)).resolves.not.toThrow();
  });

  it('seed client should work', async () => {
    const result = await stepSeed(testEnv);
    expect(result).toHaveProperty('clientId');
    expect(result).toHaveProperty('clientSecret');
    expect(result.clientId).toBeTruthy();
    expect(result.clientSecret).toBeTruthy();
  });

  it('jwks endpoint should work', async () => {
    await expect(stepJwks(testEnv)).resolves.not.toThrow();
  });
});

describe('OAuth Flow Complete', () => {
  it('should complete full OAuth flow', async () => {
    const env = testEnv;
    
    // Discovery
    await stepDiscovery(env);
    
    // Seed client
    const seed = await stepSeed(env);
    expect(seed.clientId).toBeTruthy();
    expect(seed.clientSecret).toBeTruthy();
    
    // Authorize
    const auth = await stepAuthorize({ ...env, ...seed });
    expect(auth.backingAuthorizeUrl).toBeTruthy();
    expect(auth.backingAuthorizeUrl).toMatch(/^https?:\/\//);
    
    // Approve
    const appr = await stepApprove({ ...env, ...auth });
    expect(appr.brokerCallbackUrl).toBeTruthy();
    expect(appr.brokerCallbackUrl).toMatch(/^https?:\/\//);
    
    // Callback
    const cb = await stepCallback({ ...env, ...appr });
    expect(cb.code).toBeTruthy();
    
    // Token
    const tok = await stepToken({ ...env, ...seed, ...cb });
    expect(tok.accessToken).toBeTruthy();
    expect(tok.idToken).toBeTruthy();
    
    // JWKS
    await stepJwks(env);
    
    // Userinfo
    const ui = await stepUserinfo({ ...env, ...tok });
    expect(ui).toHaveProperty('sub');
    
    // WebID (optional)
    await stepWebId({ ...env, sub: ui.sub });
    
    // CSS (optional)
    await stepCss({ ...env, ...tok });
    
    console.log('Full flow completed successfully:', { seed, auth, appr, cb, tok, ui });
  });
});

describe('OAuth Flow with Custom Environment', () => {
  it('should accept custom broker host', async () => {
    const customEnv = {
      ...testEnv,
      brokerHost: 'http://localhost:8790',
    };
    
    // This will likely fail unless you have a server on 8790, but shows how to customize
    await expect(stepDiscovery(customEnv)).rejects.toThrow();
  });
});