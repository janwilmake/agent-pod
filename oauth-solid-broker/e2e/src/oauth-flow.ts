type UrlString = string;

export type Env = {
  brokerHost: UrlString;
  oauthHost: UrlString;
  cssHost?: UrlString;
  redirectUri: UrlString;
  codeVerifier?: string;
  verbose?: boolean;
};

export type SeedOut = { clientId: string; clientSecret: string };
export type AuthorizeOut = { backingAuthorizeUrl: UrlString };
export type ApproveOut = { brokerCallbackUrl: UrlString };
export type CallbackOut = { code: string; state?: string };
export type TokenOut = { accessToken: string; idToken: string };
export type UserInfoOut = { sub?: string; webid?: string };

function log(step: string, msg: string, verbose?: boolean) {
  if (!verbose) return;
  console.log(`[${step}] ${msg}`);
}

function toUrl(base: string, path: string): string {
  const u = new URL(path, base.endsWith("/") ? base : base + "/");
  return u.toString().replace(/\/$/, "");
}

async function httpGet(url: string, opts?: { headers?: Record<string, string>; redirect?: RequestRedirect; verbose?: boolean }) {
  log("HTTP", `GET ${url}`, opts?.verbose);
  const res = await fetch(url, { method: "GET", headers: opts?.headers, redirect: opts?.redirect ?? "manual" });
  return res;
}

async function httpPostForm(url: string, form: Record<string, string>, opts?: { headers?: Record<string, string>; redirect?: RequestRedirect; verbose?: boolean }) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) body.set(k, v);
  const headers = { "content-type": "application/x-www-form-urlencoded", ...(opts?.headers ?? {}) };
  log("HTTP", `POST ${url} body=${body.toString()}`, opts?.verbose);
  const res = await fetch(url, { method: "POST", headers, body, redirect: opts?.redirect ?? "manual" });
  return res;
}

function getLocation(res: Response): string | undefined {
  return res.headers.get("location") ?? undefined;
}

function parseQuery(urlStr: string): Record<string, string> {
  const u = new URL(urlStr);
  const out: Record<string, string> = {};
  for (const [k, v] of u.searchParams.entries()) out[k] = v;
  return out;
}

export async function stepDiscovery(env: Env) {
  const url = toUrl(env.brokerHost, "/.well-known/openid-configuration");
  const res = await httpGet(url, { verbose: env.verbose, redirect: "manual" });
  const json = await res.json();
  log("discovery", JSON.stringify(json), env.verbose);
  if (!res.ok) throw new Error(`discovery failed: ${res.status}`);
}

export async function stepSeed(env: Env): Promise<SeedOut> {
  const url = toUrl(env.brokerHost, "/admin/seed-client") + `?redirect_uri=${encodeURIComponent(env.redirectUri)}`;
  const res = await httpGet(url, { verbose: env.verbose, redirect: "manual" });
  if (!res.ok) throw new Error(`seed failed: ${res.status}`);
  const json = await res.json();
  const c = json.client || {};
  return { clientId: String(c.client_id || ""), clientSecret: String(c.client_secret || "") };
}

export async function stepAuthorize(env: Env & SeedOut): Promise<AuthorizeOut> {
  const url = toUrl(env.brokerHost, "/authorize")
    + `?response_type=code&client_id=${encodeURIComponent(env.clientId)}`
    + `&redirect_uri=${encodeURIComponent(env.redirectUri)}`
    + `&scope=${encodeURIComponent("openid webid")}`
    + `&state=test`
    + `&code_challenge=${encodeURIComponent(env.codeVerifier || "abc123xyz")}`
    + `&code_challenge_method=plain`;
  const res = await httpGet(url, { verbose: env.verbose, redirect: "manual" });
  if (res.status !== 302) throw new Error(`authorize expected 302, got ${res.status}`);
  const loc = getLocation(res);
  if (!loc) throw new Error(`authorize missing Location`);
  return { backingAuthorizeUrl: loc };
}

export async function stepApprove(env: Env & AuthorizeOut): Promise<ApproveOut> {
  const qp = parseQuery(env.backingAuthorizeUrl);
  const form = {
    decision: "approve",
    response_type: qp["response_type"] || "code",
    client_id: qp["client_id"] || "",
    redirect_uri: qp["redirect_uri"] || "",
    scope: qp["scope"] || "",
    state: qp["state"] || "",
    code_challenge: qp["code_challenge"] || "",
    code_challenge_method: qp["code_challenge_method"] || "plain",
  };
  const url = toUrl(env.oauthHost, "/authorize/approve");
  const res = await httpPostForm(url, form, { verbose: env.verbose, redirect: "manual" });
  if (res.status !== 302) throw new Error(`approve expected 302, got ${res.status}`);
  const loc = getLocation(res);
  if (!loc) throw new Error(`approve missing Location`);
  return { brokerCallbackUrl: loc };
}

export async function stepCallback(env: Env & ApproveOut): Promise<CallbackOut> {
  const res = await httpGet(env.brokerCallbackUrl, { verbose: env.verbose, redirect: "manual" });
  if (res.status !== 302) throw new Error(`callback expected 302, got ${res.status}`);
  const loc = getLocation(res);
  if (!loc) throw new Error(`callback missing Location`);
  const qp = parseQuery(loc);
  const code = qp["code"] || "";
  const state = qp["state"] || undefined;
  if (!code) throw new Error(`callback missing code`);
  return { code, state };
}

export async function stepToken(env: Env & SeedOut & CallbackOut): Promise<TokenOut> {
  const url = toUrl(env.brokerHost, "/token");
  const form = {
    grant_type: "authorization_code",
    code: env.code,
    redirect_uri: env.redirectUri,
    client_id: env.clientId,
    client_secret: env.clientSecret,
    code_verifier: env.codeVerifier || "abc123xyz",
  };
  const res = await httpPostForm(url, form, { verbose: env.verbose, redirect: "manual" });
  if (!res.ok) {
    let errorDetails = "";
    try {
      const errorBody = await res.text();
      errorDetails = ` - ${errorBody}`;
    } catch {}
    throw new Error(`token failed: ${res.status}${errorDetails}`);
  }
  const json = await res.json();
  const accessToken = String(json.access_token || "");
  const idToken = String(json.id_token || "");
  if (!accessToken) throw new Error(`token missing access_token`);
  return { accessToken, idToken };
}

export async function stepJwks(env: Env) {
  const url = toUrl(env.brokerHost, "/jwks");
  const res = await httpGet(url, { verbose: env.verbose, redirect: "manual" });
  if (!res.ok) throw new Error(`jwks failed: ${res.status}`);
}

export async function stepUserinfo(env: Env & TokenOut): Promise<UserInfoOut> {
  const url = toUrl(env.brokerHost, "/userinfo");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.accessToken}` }, redirect: "manual" });
  if (!res.ok) throw new Error(`userinfo failed: ${res.status}`);
  const json = await res.json();
  return { sub: json.sub, webid: json.webid };
}

export async function stepWebId(env: Env & { sub?: string }) {
  if (!env.sub) return; // optional
  const url = toUrl(env.brokerHost, "/webid/") + encodeURIComponent(env.sub);
  await httpGet(url, { verbose: env.verbose, redirect: "manual" });
}

export async function stepCss(env: Env & TokenOut) {
  if (!env.cssHost) return; // optional
  const res = await fetch(env.cssHost, { headers: { Authorization: `Bearer ${env.accessToken}` }, redirect: "manual" });
  if (![200, 401, 403].includes(res.status)) throw new Error(`css call unexpected status: ${res.status}`);
}

export const defaultEnv: Env = {
  brokerHost: "http://localhost:8789",
  oauthHost: "http://localhost:8799",
  cssHost: "http://localhost:3000",
  redirectUri: "http://localhost:3355/callback",
  codeVerifier: "abc123xyz",
  verbose: false,
};