import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { createHash, randomBytes } from "node:crypto";

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function sha256b64url(s) {
  return createHash("sha256").update(s).digest("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function registerClient(redirect_uri) {
  const payload = {
    client_name: "Test Client",
    redirect_uris: [redirect_uri],
    token_endpoint_auth_method: "client_secret_post",
  };
  const resp = await SELF.fetch("http://test/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  expect(resp.status).toBe(201);
  const json = await resp.json();
  expect(json.client_id).toBeTruthy();
  expect(json.client_secret).toBeTruthy();
  return { client_id: json.client_id, client_secret: json.client_secret };
}

async function approveAuth({ client_id, redirect_uri, scope, state, code_challenge }) {
  const form = new URLSearchParams();
  form.set("decision", "approve");
  form.set("response_type", "code");
  form.set("client_id", client_id);
  form.set("redirect_uri", redirect_uri);
  form.set("scope", scope);
  form.set("state", state);
  form.set("code_challenge", code_challenge);
  form.set("code_challenge_method", "S256");

  const resp = await SELF.fetch("http://test/authorize/approve", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  });
  expect(resp.status).toBe(302);
  const location = resp.headers.get("location");
  expect(location).toBeTruthy();
  const u = new URL(location);
  expect(u.origin + u.pathname).toBe(redirect_uri);
  expect(u.searchParams.get("state")).toBe(state);
  const code = u.searchParams.get("code");
  expect(code).toBeTruthy();
  return code;
}

async function exchangeCode({ client_id, client_secret, code, redirect_uri, code_verifier }) {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", redirect_uri);
  body.set("client_id", client_id);
  body.set("code_verifier", code_verifier);

  const resp = await SELF.fetch("http://test/oauth/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: (() => { body.set("client_secret", client_secret); return body.toString(); })(),
  });
  expect(resp.status).toBe(200);
  const json = await resp.json();
  expect(json).toHaveProperty("access_token");
  expect(json.token_type).toBe("bearer");
  return json;
}

describe("OAuth2 Authorization Code + PKCE flow", () => {
  it("completes end-to-end and calls protected API", async () => {
    const redirect_uri = "https://example.com/callback";
    const { client_id, client_secret } = await registerClient(redirect_uri);

    // PKCE
    const code_verifier = b64url(randomBytes(32));
    const code_challenge = sha256b64url(code_verifier);
    const state = "state-xyz";
    const scope = "profile email";

    const code = await approveAuth({ client_id, redirect_uri, scope, state, code_challenge });

    const tokens = await exchangeCode({ client_id, client_secret, code, redirect_uri, code_verifier });
    expect(typeof tokens.access_token).toBe("string");

    const who = await SELF.fetch("http://test/api/whoami", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(who.status).toBe(200);
    const body = await who.json();
    expect(body.ok).toBe(true);
    expect(body.props?.username).toBe("Demo User");
    expect(body.props?.userId).toBe("user-1234");
  });

  it("returns access_denied when user denies consent", async () => {
    const redirect_uri = "https://example.com/callback";
    const { client_id } = await registerClient(redirect_uri);
    const state = "deny-state";

    const form = new URLSearchParams();
    form.set("decision", "deny");
    form.set("response_type", "code");
    form.set("client_id", client_id);
    form.set("redirect_uri", redirect_uri);
    form.set("scope", "");
    form.set("state", state);

    const resp = await SELF.fetch("http://test/authorize/approve", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
    expect(resp.status).toBe(302);
    const location = resp.headers.get("location");
    const u = new URL(location);
    expect(u.origin + u.pathname).toBe(redirect_uri);
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("state")).toBe(state);
  });

  it("rejects access without Authorization header", async () => {
    const resp = await SELF.fetch("http://test/api/whoami");
    expect(resp.status).toBe(401);
  });

  it("rejects access with invalid token", async () => {
    const resp = await SELF.fetch("http://test/api/whoami", {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(resp.status).toBe(401);
  });
});
