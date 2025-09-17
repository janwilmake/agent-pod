import { Hono } from "hono";
import { Env, AuthRequest, Client, StoredAuth, CodeRecord } from "./types";
import { makeSigner } from "./jwt";

const app = new Hono<{ Bindings: Env }>();

// Utilities
function nowSec() { return Math.floor(Date.now() / 1000); }
function randomId(prefix = ""): string { return prefix + crypto.randomUUID().replace(/-/g, ""); }
function parseUrl(base: string, path: string): string { return new URL(path, base.endsWith("/") ? base : base + "/").toString().replace(/\/$/, ""); }

function parseScopes(s?: string): string[] { return (s || "").split(/\s+/).filter(Boolean); }

function buildWebId(env: Env, sub: string): string {
  const frag = env.WEBID_FRAGMENT ?? "#me";
  if (env.WEBID_HOST === "self") {
    return `${env.BROKER_ISSUER.replace(/\/$/, "")}/webid/${encodeURIComponent(sub)}${frag}`;
  }
  const path = env.WEBID_PATH ?? "";
  const normalizedPath = path && !path.startsWith("/") ? `/${path}` : path;
  return `https://${env.WEBID_HOST}/${encodeURIComponent(sub)}${normalizedPath}${frag}`;
}

async function getClient(env: Env, clientId: string): Promise<Client | null> {
  const raw = await env.BROKER_KV.get(`client:${clientId}`, { type: "json" });
  return (raw as Client) || null;
}

async function saveClient(env: Env, client: Client) {
  await env.BROKER_KV.put(`client:${client.client_id}`, JSON.stringify(client));
}

function verifyRedirectUri(client: Client, redirectUri: string): boolean {
  return client.redirect_uris.includes(redirectUri);
}

async function exchangeCodeAtBacking(env: Env, code: string, redirectUri: string) {
  const tokenUrl = parseUrl(env.BACKING_ISSUER, env.BACKING_TOKEN_PATH || "/oauth/token");
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", redirectUri);

  // Authenticate to the backing provider using HTTP Basic (recommended by RFC 6749)
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const creds = btoa(`${env.BACKING_CLIENT_ID}:${env.BACKING_CLIENT_SECRET}`);
  headers["authorization"] = `Basic ${creds}`;

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers,
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`backing token error ${res.status}`);
  return res.json();
}

async function getBackingSubject(env: Env, backingTokens: any): Promise<{ sub: string; user?: any }> {
  // Prefer id_token if present
  if (backingTokens.id_token) {
    const payload = JSON.parse(atob(backingTokens.id_token.split(".")[1]));
    return { sub: payload.sub || payload.userId || payload.preferred_username || "user", user: payload };
  }
  // Fallback to userinfo
  if (env.BACKING_USERINFO_PATH) {
    const userinfoUrl = parseUrl(env.BACKING_ISSUER, env.BACKING_USERINFO_PATH);
    const res = await fetch(userinfoUrl, { headers: { Authorization: `Bearer ${backingTokens.access_token}` } });
    if (res.ok) {
      const data = await res.json();
      const sub = data.sub || data.userId || data.id || "user";
      return { sub, user: data };
    }
  }
  // As a last resort, hash the access token (not ideal; for MVP fallback only)
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(backingTokens.access_token || randomId("u_")));
  const sub = Array.from(new Uint8Array(hash)).slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
  return { sub };
}

// Discovery
app.get("/.well-known/openid-configuration", async (c) => {
  const env = c.env;
  const issuer = env.BROKER_ISSUER;
  const authorization_endpoint = parseUrl(issuer, "/authorize");
  const token_endpoint = parseUrl(issuer, "/token");
  const jwks_uri = parseUrl(issuer, "/jwks");
  return c.json({
    issuer,
    authorization_endpoint,
    token_endpoint,
    jwks_uri,
    userinfo_endpoint: parseUrl(issuer, "/userinfo"),
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256", "plain"],
    scopes_supported: ["openid", "webid"],
    claims_supported: ["iss", "sub", "aud", "azp", "webid", "exp", "iat"],
    grant_types_supported: ["authorization_code"],
  });
});

// JWKS
app.get("/jwks", async (c) => {
  const env = c.env;
  const { jwk } = await makeSigner(env);
  return c.json({ keys: [jwk] });
});

// Admin: seed a client (demo)
app.get("/admin/seed-client", async (c) => {
  const env = c.env;
  const redirect_uri = c.req.query("redirect_uri");
  if (!redirect_uri) return c.json({ error: "missing redirect_uri" }, 400);
  const client_id = randomId("client_");
  const client_secret = randomId("secret_");
  const client: Client = { client_id, client_secret, redirect_uris: [redirect_uri], client_name: "Demo Client" };
  await saveClient(env, client);
  return c.json({ ok: true, client });
});

// Authorize: start flow by redirecting to backing provider
app.get("/authorize", async (c) => {
  const env = c.env;
  const q = c.req.query();
  const req: AuthRequest = {
    response_type: (q.response_type as any) || "code",
    client_id: q.client_id || "",
    redirect_uri: q.redirect_uri || "",
    scope: q.scope,
    state: q.state,
    code_challenge: q.code_challenge,
    code_challenge_method: (q.code_challenge_method as any) || undefined,
  };
  if (req.response_type !== "code") return c.json({ error: "unsupported_response_type" }, 400);
  const client = await getClient(env, req.client_id);
  if (!client) return c.json({ error: "unauthorized_client" }, 400);
  if (!verifyRedirectUri(client, req.redirect_uri)) return c.json({ error: "invalid_redirect_uri" }, 400);

  // Persist the inbound request keyed by an internal state
  const internal_state = randomId("st_");
  const stored: StoredAuth = { ...req, created: Date.now(), internal_state };
  await env.BROKER_KV.put(`auth:${internal_state}`, JSON.stringify(stored), { expirationTtl: 600 });

  // Redirect to backing provider authorize endpoint
  const authUrl = new URL(env.BACKING_AUTH_PATH || "/authorize", env.BACKING_ISSUER);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", env.BACKING_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", parseUrl(env.BROKER_ISSUER, "/callback"));
  authUrl.searchParams.set("scope", "openid profile email");
  // Carry through state to correlate back to the original request
  const combinedState = JSON.stringify({ internal_state, client_state: req.state || null });
  authUrl.searchParams.set("state", combinedState);

  return c.redirect(authUrl.toString(), 302);
});

// Callback: backing provider returns here. Exchange code, mint our auth code, and redirect to client
app.get("/callback", async (c) => {
  const env = c.env;
  const url = new URL(c.req.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  if (!code || !stateParam) return c.text("Invalid callback", 400);
  let state: { internal_state: string; client_state?: string | null };
  try {
    state = JSON.parse(stateParam);
  } catch {
    return c.text("Invalid state", 400);
  }
  const storedRaw = await env.BROKER_KV.get(`auth:${state.internal_state}`, { type: "json" });
  if (!storedRaw) return c.text("Session expired", 400);
  const stored = storedRaw as StoredAuth;

  // Exchange code at backing provider
  const backingTokens = await exchangeCodeAtBacking(env, code, parseUrl(env.BROKER_ISSUER, "/callback"));
  const { sub } = await getBackingSubject(env, backingTokens);

  const webid = buildWebId(env, sub);
  const scope = parseScopes(stored.scope);
  const ttlSec = Number(env.TOKEN_TTL_SECONDS || 300);
  const rec: CodeRecord = {
    client_id: stored.client_id,
    redirect_uri: stored.redirect_uri,
    scope,
    sub,
    webid,
    created: Date.now(),
    expires_at: Date.now() + ttlSec * 1000,
    code_challenge: stored.code_challenge,
    code_challenge_method: stored.code_challenge_method,
  };
  const ourCode = randomId("code_");
  await env.BROKER_KV.put(`code:${ourCode}`, JSON.stringify(rec), { expirationTtl: ttlSec + 300 });

  const redirectUri = new URL(stored.redirect_uri);
  redirectUri.searchParams.set("code", ourCode);
  if (stored.state) redirectUri.searchParams.set("state", stored.state);
  return c.redirect(redirectUri.toString(), 302);
});

// Token endpoint: exchange our authorization code for tokens
app.post("/token", async (c) => {
  const env = c.env;
  const form = await c.req.parseBody();
  const grant_type = (form["grant_type"] as string) || "";
  if (grant_type !== "authorization_code") return c.json({ error: "unsupported_grant_type" }, 400);
  const code = (form["code"] as string) || "";
  const redirect_uri = (form["redirect_uri"] as string) || "";
  const client_id = (form["client_id"] as string) || "";
  const client_secret = (form["client_secret"] as string) || "";
  const code_verifier = (form["code_verifier"] as string) || undefined;

  const client = await getClient(env, client_id);
  if (!client) return c.json({ error: "invalid_client" }, 401);
  if (client.client_secret && client.client_secret !== client_secret) return c.json({ error: "invalid_client" }, 401);

  const recRaw = await env.BROKER_KV.get(`code:${code}`, { type: "json" });
  if (!recRaw) return c.json({ error: "invalid_grant" }, 400);
  const rec = recRaw as CodeRecord;
  if (rec.client_id !== client_id) return c.json({ error: "invalid_grant" }, 400);
  if (rec.redirect_uri !== redirect_uri) return c.json({ error: "invalid_grant" }, 400);
  if (Date.now() > rec.expires_at) return c.json({ error: "invalid_grant" }, 400);

  // PKCE verify if applicable
  if (rec.code_challenge) {
    if (!code_verifier) return c.json({ error: "invalid_request", error_description: "missing code_verifier" }, 400);
    const method = rec.code_challenge_method || "plain";
    if (method === "S256") {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code_verifier));
      const b64 = btoa(String.fromCharCode(...Array.from(new Uint8Array(digest))))
        .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      if (b64 !== rec.code_challenge) return c.json({ error: "invalid_grant" }, 400);
    } else {
      if (code_verifier !== rec.code_challenge) return c.json({ error: "invalid_grant" }, 400);
    }
  }

  // One-time use: delete code
  await c.env.BROKER_KV.delete(`code:${code}`);

  const signer = await makeSigner(env);
  const ttlSec = Number(env.TOKEN_TTL_SECONDS || 300);
  const iat = nowSec();
  const exp = iat + ttlSec;

  // ID Token
  const idTokenPayload = {
    iss: env.BROKER_ISSUER,
    aud: ["solid", client_id],
    azp: client_id,
    sub: rec.sub,
    webid: rec.webid,
    iat,
    exp,
  } as const;
  const id_token = await signer.sign(idTokenPayload);

  // Access Token
  const accessTokenPayload = {
    iss: env.BROKER_ISSUER,
    aud: "solid",
    sub: rec.sub,
    webid: rec.webid,
    scope: rec.scope.join(" "),
    iat,
    exp,
  } as const;
  const access_token = await signer.sign(accessTokenPayload);

  return c.json({
    token_type: "Bearer",
    expires_in: ttlSec,
    access_token,
    id_token,
    scope: rec.scope.join(" "),
  });
});

// Minimal userinfo (optional). Returns sub and webid based on the token.
app.get("/userinfo", async (c) => {
  const auth = c.req.header("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return c.json({ error: "invalid_token" }, 401);
  try {
    // Decode payload without verification for MVP.
    const payload = JSON.parse(atob(m[1].split(".")[1])) || {};
    return c.json({ sub: payload.sub, webid: payload.webid });
  } catch {
    return c.json({ error: "invalid_token" }, 401);
  }
});

// Serve minimal WebID profiles when WEBID_HOST = "self"
app.get("/webid/:sub", async (c) => {
  const env = c.env;
  if (env.WEBID_HOST !== "self") return c.text("Not found", 404);
  const sub = c.req.param("sub");
  const webid = buildWebId(env, sub);
  const ttl = 60;
  const turtle = `@prefix foaf: <http://xmlns.com/foaf/0.1/> .\n@prefix solid: <http://www.w3.org/ns/solid/terms#> .\n\n<#me> a foaf:Person ;\n  solid:oidcIssuer <${env.BROKER_ISSUER}> .\n`;
  return new Response(turtle, { status: 200, headers: { "content-type": "text/turtle", "cache-control": `max-age=${ttl}` } });
});

export default app;
