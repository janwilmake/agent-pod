import { describe, it, expect, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";
import { createHash, randomBytes } from "node:crypto";

// Test RSA key pair (for testing only)
const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKB
xhQnhcZHjVBUMbVFMlliTj4hOCfFb0qD0i7d7EBxOcAr5PSzSdUqq3EBMjnKYdS2
cIEpF6EtOEBHVbzCvJqzqB0hJ1q7YcKzk6Yh6n8WsWTsHjJ4x5qNOuF5mGYJ8T2h
nN9VBaFz8T8xDm6b3k5V5MvGsF6xRqKjZBHn1V7FbMOqZg5qqxBj7V6x2n6J4OKv
6Lk3dBjN6qxp6mO6H8FLLCqT6x6PgDJb1FCj6p8W8j8G1vZmNvG5QdF4OqF6dN5L
qYvO4O4QqF6X3qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6xqF
AgMBAAECggEBAK3eqBmNaCmKGgb5NmpLjnBbUbz7E1ZSjBmJZVZUt8t6xq5Kk7r8
ZV8v6nD9JXGqF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6
x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF
6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6q
F6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6
qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x
6qF6x6qF6x6qECgYEA6cVwFJ8K2d8GqF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x
6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6
x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF
6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6q
ECgYEAzjIb8L4F6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF
6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6q
F6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6
qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x
6qF6x6qF6x6qF6wKBgA3n9VF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF
6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6q
F6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6
qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x6qF6x
6qF6x6qF6x6qF6x
-----END PRIVATE KEY-----`;

function b64url(input: ArrayBuffer | string): string {
  let buffer: ArrayBuffer;
  if (typeof input === "string") {
    buffer = new TextEncoder().encode(input).buffer;
  } else {
    buffer = input;
  }
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function sha256b64url(s: string): string {
  const hash = createHash("sha256").update(s).digest();
  return b64url(hash.buffer);
}

// Mock backing provider responses
function mockBackingProvider() {
  const originalFetch = globalThis.fetch;
  
  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    setupMock: () => {
      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = url.toString();
        
        // Mock token exchange with backing provider
        if (urlStr.includes("/oauth/token") && urlStr.includes("localhost:8799")) {
          const formData = new URLSearchParams(init?.body as string);
          const grantType = formData.get("grant_type");
          const code = formData.get("code");
          
          if (grantType === "authorization_code" && code === "test-backing-code") {
            return new Response(JSON.stringify({
              access_token: "test-access-token",
              token_type: "Bearer",
              id_token: "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJhdWQiOiJ0ZXN0IiwiaXNzIjoidGVzdCIsImV4cCI6OTk5OTk5OTk5OX0.test"
            }), {
              status: 200,
              headers: { "Content-Type": "application/json" }
            });
          }
          
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        }
        
        // Mock userinfo endpoint
        if (urlStr.includes("/api/whoami") && urlStr.includes("localhost:8799")) {
          return new Response(JSON.stringify({
            sub: "test-user",
            username: "Test User",
            userId: "user-123"
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        
        // Fall back to original fetch for other URLs
        return originalFetch(url as RequestInfo, init);
      };
    }
  };
}

async function createTestClient(redirectUri: string = "https://example.com/callback") {
  const resp = await SELF.fetch("http://test/admin/seed-client?redirect_uri=" + encodeURIComponent(redirectUri));
  expect(resp.status).toBe(200);
  const json = await resp.json() as any;
  expect(json.ok).toBe(true);
  expect(json.client).toBeTruthy();
  return json.client;
}

describe("Solid Broker", () => {
  const mockProvider = mockBackingProvider();
  
  beforeAll(() => {
    mockProvider.setupMock();
  });

  describe("Discovery endpoints", () => {
    it("serves OpenID configuration", async () => {
      const resp = await SELF.fetch("http://test/.well-known/openid-configuration");
      expect(resp.status).toBe(200);
      
      const config = await resp.json() as any;
      expect(config.issuer).toBe("http://localhost:8789");
      expect(config.authorization_endpoint).toBe("http://localhost:8789/authorize");
      expect(config.token_endpoint).toBe("http://localhost:8789/token");
      expect(config.jwks_uri).toBe("http://localhost:8789/jwks");
      expect(config.response_types_supported).toContain("code");
      expect(config.scopes_supported).toContain("openid");
      expect(config.scopes_supported).toContain("webid");
    });

    it("serves JWKS endpoint", async () => {
      const resp = await SELF.fetch("http://test/jwks");
      expect(resp.status).toBe(200);
      
      const jwks = await resp.json() as any;
      expect(jwks.keys).toBeTruthy();
      expect(Array.isArray(jwks.keys)).toBe(true);
      expect(jwks.keys.length).toBeGreaterThan(0);
      
      const key = jwks.keys[0];
      expect(key.kty).toBe("RSA");
      expect(key.alg).toBe("RS256");
      expect(key.use).toBe("sig");
      expect(key.n).toBeTruthy();
      expect(key.e).toBeTruthy();
    });
  });

  describe("Client management", () => {
    it("creates a client via admin endpoint", async () => {
      const redirectUri = "https://example.com/callback";
      const client = await createTestClient(redirectUri);
      
      expect(client.client_id).toBeTruthy();
      expect(client.client_secret).toBeTruthy();
      expect(client.redirect_uris).toContain(redirectUri);
      expect(client.client_name).toBe("Demo Client");
    });

    it("requires redirect_uri parameter", async () => {
      const resp = await SELF.fetch("http://test/admin/seed-client");
      expect(resp.status).toBe(400);
      
      const json = await resp.json() as any;
      expect(json.error).toBe("missing redirect_uri");
    });
  });

  describe("Authorization flow", () => {
    it("starts authorization flow", async () => {
      const redirectUri = "https://example.com/callback";
      const client = await createTestClient(redirectUri);
      const state = "test-state";
      const scope = "openid webid";
      const codeChallenge = "test-challenge";
      
      const authUrl = new URL("http://test/authorize");
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", client.client_id);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("scope", scope);
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      
      const resp = await SELF.fetch(authUrl.toString(), { redirect: "manual" });
      expect(resp.status).toBe(302);
      
      const location = resp.headers.get("location");
      expect(location).toBeTruthy();
      
      const locationUrl = new URL(location!);
      expect(locationUrl.hostname).toBe("localhost");
      expect(locationUrl.port).toBe("8799");
      expect(locationUrl.pathname).toBe("/authorize");
      expect(locationUrl.searchParams.get("response_type")).toBe("code");
      expect(locationUrl.searchParams.get("client_id")).toBe("replace-me");
      expect(locationUrl.searchParams.get("scope")).toBe("openid profile email");
      
      const stateParam = locationUrl.searchParams.get("state");
      expect(stateParam).toBeTruthy();
      const parsedState = JSON.parse(stateParam!);
      expect(parsedState.client_state).toBe(state);
      expect(parsedState.internal_state).toBeTruthy();
    });

    it("rejects unknown client_id", async () => {
      const authUrl = new URL("http://test/authorize");
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", "unknown-client");
      authUrl.searchParams.set("redirect_uri", "https://example.com/callback");
      
      const resp = await SELF.fetch(authUrl.toString());
      expect(resp.status).toBe(400);
      
      const json = await resp.json() as any;
      expect(json.error).toBe("unauthorized_client");
    });

    it("rejects invalid redirect_uri", async () => {
      const client = await createTestClient("https://example.com/callback");
      
      const authUrl = new URL("http://test/authorize");
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", client.client_id);
      authUrl.searchParams.set("redirect_uri", "https://evil.com/callback");
      
      const resp = await SELF.fetch(authUrl.toString());
      expect(resp.status).toBe(400);
      
      const json = await resp.json() as any;
      expect(json.error).toBe("invalid_redirect_uri");
    });

    it("rejects unsupported response_type", async () => {
      const client = await createTestClient("https://example.com/callback");
      
      const authUrl = new URL("http://test/authorize");
      authUrl.searchParams.set("response_type", "token");
      authUrl.searchParams.set("client_id", client.client_id);
      authUrl.searchParams.set("redirect_uri", "https://example.com/callback");
      
      const resp = await SELF.fetch(authUrl.toString());
      expect(resp.status).toBe(400);
      
      const json = await resp.json() as any;
      expect(json.error).toBe("unsupported_response_type");
    });
  });

  describe("Callback handling", () => {
    it("handles callback with valid code", async () => {
      // First create client and start auth flow to get internal state
      const redirectUri = "https://example.com/callback";
      const client = await createTestClient(redirectUri);
      
      const authUrl = new URL("http://test/authorize");
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", client.client_id);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("scope", "openid webid");
      authUrl.searchParams.set("state", "original-state");
      
      const authResp = await SELF.fetch(authUrl.toString(), { redirect: "manual" });
      const location = authResp.headers.get("location")!;
      const locationUrl = new URL(location);
      const stateParam = locationUrl.searchParams.get("state")!;
      
      // Now simulate callback
      const callbackUrl = new URL("http://test/callback");
      callbackUrl.searchParams.set("code", "test-backing-code");
      callbackUrl.searchParams.set("state", stateParam);
      
      const callbackResp = await SELF.fetch(callbackUrl.toString(), { redirect: "manual" });
      expect(callbackResp.status).toBe(302);
      
      const callbackLocation = callbackResp.headers.get("location");
      expect(callbackLocation).toBeTruthy();
      
      const callbackLocationUrl = new URL(callbackLocation!);
      expect(callbackLocationUrl.origin + callbackLocationUrl.pathname).toBe(redirectUri);
      expect(callbackLocationUrl.searchParams.get("code")).toBeTruthy();
      expect(callbackLocationUrl.searchParams.get("state")).toBe("original-state");
    });

    it("rejects callback without code", async () => {
      const callbackUrl = new URL("http://test/callback");
      callbackUrl.searchParams.set("state", JSON.stringify({ internal_state: "test", client_state: null }));
      
      const resp = await SELF.fetch(callbackUrl.toString());
      expect(resp.status).toBe(400);
      expect(await resp.text()).toBe("Invalid callback");
    });

    it("rejects callback with invalid state", async () => {
      const callbackUrl = new URL("http://test/callback");
      callbackUrl.searchParams.set("code", "test-code");
      callbackUrl.searchParams.set("state", "invalid-json");
      
      const resp = await SELF.fetch(callbackUrl.toString());
      expect(resp.status).toBe(400);
      expect(await resp.text()).toBe("Invalid state");
    });
  });

  describe("Token endpoint", () => {
    async function completeAuthFlow(options: {
      redirectUri?: string;
      scope?: string;
      state?: string;
      codeChallenge?: string;
      codeChallengeMethod?: string;
    } = {}) {
      const {
        redirectUri = "https://example.com/callback",
        scope = "openid webid",
        state = "test-state",
        codeChallenge,
        codeChallengeMethod = "S256"
      } = options;

      const client = await createTestClient(redirectUri);
      
      // Start auth flow
      const authUrl = new URL("http://test/authorize");
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", client.client_id);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("scope", scope);
      authUrl.searchParams.set("state", state);
      if (codeChallenge) {
        authUrl.searchParams.set("code_challenge", codeChallenge);
        authUrl.searchParams.set("code_challenge_method", codeChallengeMethod);
      }
      
      const authResp = await SELF.fetch(authUrl.toString(), { redirect: "manual" });
      const location = authResp.headers.get("location")!;
      const locationUrl = new URL(location);
      const stateParam = locationUrl.searchParams.get("state")!;
      
      // Callback
      const callbackUrl = new URL("http://test/callback");
      callbackUrl.searchParams.set("code", "test-backing-code");
      callbackUrl.searchParams.set("state", stateParam);
      
      const callbackResp = await SELF.fetch(callbackUrl.toString(), { redirect: "manual" });
      const callbackLocation = callbackResp.headers.get("location")!;
      const callbackLocationUrl = new URL(callbackLocation);
      const brokerCode = callbackLocationUrl.searchParams.get("code")!;
      
      return { client, brokerCode };
    }

    it("exchanges authorization code for tokens", async () => {
      const { client, brokerCode } = await completeAuthFlow();
      
      const tokenForm = new URLSearchParams();
      tokenForm.set("grant_type", "authorization_code");
      tokenForm.set("code", brokerCode);
      tokenForm.set("redirect_uri", "https://example.com/callback");
      tokenForm.set("client_id", client.client_id);
      tokenForm.set("client_secret", client.client_secret);
      
      const tokenResp = await SELF.fetch("http://test/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenForm.toString()
      });
      
      expect(tokenResp.status).toBe(200);
      const tokens = await tokenResp.json() as any;
      
      expect(tokens.token_type).toBe("Bearer");
      expect(tokens.access_token).toBeTruthy();
      expect(tokens.id_token).toBeTruthy();
      expect(tokens.expires_in).toBe(300);
      expect(tokens.scope).toBe("openid webid");
      
      // Verify token structure (basic JWT structure check)
      expect(tokens.access_token.split(".")).toHaveLength(3);
      expect(tokens.id_token.split(".")).toHaveLength(3);
    });

    it("supports PKCE S256", async () => {
      const codeVerifier = b64url(randomBytes(32));
      const codeChallenge = sha256b64url(codeVerifier);
      
      const { client, brokerCode } = await completeAuthFlow({ 
        codeChallenge, 
        codeChallengeMethod: "S256" 
      });
      
      const tokenForm = new URLSearchParams();
      tokenForm.set("grant_type", "authorization_code");
      tokenForm.set("code", brokerCode);
      tokenForm.set("redirect_uri", "https://example.com/callback");
      tokenForm.set("client_id", client.client_id);
      tokenForm.set("client_secret", client.client_secret);
      tokenForm.set("code_verifier", codeVerifier);
      
      const tokenResp = await SELF.fetch("http://test/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenForm.toString()
      });
      
      expect(tokenResp.status).toBe(200);
    });

    it("rejects invalid grant_type", async () => {
      const tokenForm = new URLSearchParams();
      tokenForm.set("grant_type", "client_credentials");
      
      const tokenResp = await SELF.fetch("http://test/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenForm.toString()
      });
      
      expect(tokenResp.status).toBe(400);
      const json = await tokenResp.json() as any;
      expect(json.error).toBe("unsupported_grant_type");
    });

    it("rejects invalid client credentials", async () => {
      const { brokerCode } = await completeAuthFlow();
      
      const tokenForm = new URLSearchParams();
      tokenForm.set("grant_type", "authorization_code");
      tokenForm.set("code", brokerCode);
      tokenForm.set("redirect_uri", "https://example.com/callback");
      tokenForm.set("client_id", "invalid-client");
      tokenForm.set("client_secret", "invalid-secret");
      
      const tokenResp = await SELF.fetch("http://test/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenForm.toString()
      });
      
      expect(tokenResp.status).toBe(401);
      const json = await tokenResp.json() as any;
      expect(json.error).toBe("invalid_client");
    });

    it("rejects invalid authorization code", async () => {
      const client = await createTestClient();
      
      const tokenForm = new URLSearchParams();
      tokenForm.set("grant_type", "authorization_code");
      tokenForm.set("code", "invalid-code");
      tokenForm.set("redirect_uri", "https://example.com/callback");
      tokenForm.set("client_id", client.client_id);
      tokenForm.set("client_secret", client.client_secret);
      
      const tokenResp = await SELF.fetch("http://test/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenForm.toString()
      });
      
      expect(tokenResp.status).toBe(400);
      const json = await tokenResp.json() as any;
      expect(json.error).toBe("invalid_grant");
    });
  });
});