import { command, run, string, boolean } from "@drizzle-team/brocli";

type UrlString = string;

type Env = {
  brokerHost: UrlString;
  oauthHost: UrlString;
  cssHost?: UrlString;
  redirectUri: UrlString;
  codeVerifier?: string;
  verbose?: boolean;
};

type SeedOut = { clientId: string; clientSecret: string };
type AuthorizeOut = { backingAuthorizeUrl: UrlString };
type ApproveOut = { brokerCallbackUrl: UrlString };
type CallbackOut = { code: string; state?: string };
type TokenOut = { accessToken: string; idToken: string };
type UserInfoOut = { sub?: string; webid?: string };

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

// Steps
async function stepDiscovery(env: Env) {
  const url = toUrl(env.brokerHost, "/.well-known/openid-configuration");
  const res = await httpGet(url, { verbose: env.verbose, redirect: "manual" });
  const json = await res.json();
  log("discovery", JSON.stringify(json), env.verbose);
  if (!res.ok) throw new Error(`discovery failed: ${res.status}`);
}

async function stepSeed(env: Env): Promise<SeedOut> {
  const url = toUrl(env.brokerHost, "/admin/seed-client") + `?redirect_uri=${encodeURIComponent(env.redirectUri)}`;
  const res = await httpGet(url, { verbose: env.verbose, redirect: "manual" });
  if (!res.ok) throw new Error(`seed failed: ${res.status}`);
  const json = await res.json();
  const c = json.client || {};
  return { clientId: String(c.client_id || ""), clientSecret: String(c.client_secret || "") };
}

async function stepAuthorize(env: Env & SeedOut): Promise<AuthorizeOut> {
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

async function stepApprove(env: Env & AuthorizeOut): Promise<ApproveOut> {
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

async function stepCallback(env: Env & ApproveOut): Promise<CallbackOut> {
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

async function stepToken(env: Env & SeedOut & CallbackOut): Promise<TokenOut> {
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
  if (!res.ok) throw new Error(`token failed: ${res.status}`);
  const json = await res.json();
  const accessToken = String(json.access_token || "");
  const idToken = String(json.id_token || "");
  if (!accessToken) throw new Error(`token missing access_token`);
  return { accessToken, idToken };
}

async function stepJwks(env: Env) {
  const url = toUrl(env.brokerHost, "/jwks");
  const res = await httpGet(url, { verbose: env.verbose, redirect: "manual" });
  if (!res.ok) throw new Error(`jwks failed: ${res.status}`);
}

async function stepUserinfo(env: Env & TokenOut): Promise<UserInfoOut> {
  const url = toUrl(env.brokerHost, "/userinfo");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.accessToken}` }, redirect: "manual" });
  if (!res.ok) throw new Error(`userinfo failed: ${res.status}`);
  const json = await res.json();
  return { sub: json.sub, webid: json.webid };
}

async function stepWebId(env: Env & { sub?: string }) {
  if (!env.sub) return; // optional
  const url = toUrl(env.brokerHost, "/webid/") + encodeURIComponent(env.sub);
  await httpGet(url, { verbose: env.verbose, redirect: "manual" });
}

async function stepCss(env: Env & TokenOut) {
  if (!env.cssHost) return; // optional
  const res = await fetch(env.cssHost, { headers: { Authorization: `Bearer ${env.accessToken}` }, redirect: "manual" });
  if (![200, 401, 403].includes(res.status)) throw new Error(`css call unexpected status: ${res.status}`);
}

const baseOpts = {
  brokerHost: string().desc("Broker base URL").default("http://localhost:8789"),
  oauthHost: string().desc("Backing OAuth base URL").default("http://localhost:8799"),
  cssHost: string().desc("CSS base URL").default("http://localhost:3000"),
  redirectUri: string().desc("Client redirect URI").default("http://localhost:3355/callback"),
  codeVerifier: string().desc("PKCE code verifier").default("abc123xyz"),
  verbose: boolean().default(false),
};

const discoverCmd = command({ name: "discover", options: baseOpts, handler: async (opts) => { await stepDiscovery(opts); } });
const seedCmd = command({ name: "seed", options: baseOpts, handler: async (opts) => { const out = await stepSeed(opts); console.log(JSON.stringify(out, null, 2)); } });
const authorizeCmd = command({ name: "authorize", options: { ...baseOpts, clientId: string().required() }, handler: async (opts) => { const out = await stepAuthorize(opts as Env & SeedOut); console.log(JSON.stringify(out, null, 2)); } });
const approveCmd = command({ name: "approve", options: { ...baseOpts, backingAuthorizeUrl: string().required() }, handler: async (opts) => { const out = await stepApprove(opts as Env & AuthorizeOut); console.log(JSON.stringify(out, null, 2)); } });
const callbackCmd = command({ name: "callback", options: { ...baseOpts, brokerCallbackUrl: string().required() }, handler: async (opts) => { const out = await stepCallback(opts as Env & ApproveOut); console.log(JSON.stringify(out, null, 2)); } });
const tokenCmd = command({ name: "token", options: { ...baseOpts, clientId: string().required(), clientSecret: string().required(), code: string().required() }, handler: async (opts) => { const out = await stepToken(opts as Env & SeedOut & CallbackOut); console.log(JSON.stringify(out, null, 2)); } });
const jwksCmd = command({ name: "jwks", options: baseOpts, handler: async (opts) => { await stepJwks(opts); } });
const userinfoCmd = command({ name: "userinfo", options: { ...baseOpts, accessToken: string().required() }, handler: async (opts) => { const out = await stepUserinfo(opts as Env & TokenOut); console.log(JSON.stringify(out, null, 2)); } });
const webidCmd = command({ name: "webid", options: { ...baseOpts, sub: string().required() }, handler: async (opts) => { await stepWebId(opts as Env & { sub: string }); } });
const cssCmd = command({ name: "css", options: { ...baseOpts, accessToken: string().required() }, handler: async (opts) => { await stepCss(opts as Env & TokenOut); } });

const allCmd = command({
  name: "all",
  options: baseOpts,
  handler: async (opts) => {
    const env = opts as Env;
    await stepDiscovery(env);
    const seed = await stepSeed(env);
    const auth = await stepAuthorize({ ...env, ...seed });
    const appr = await stepApprove({ ...env, ...auth });
    const cb = await stepCallback({ ...env, ...appr });
    const tok = await stepToken({ ...env, ...seed, ...cb });
    await stepJwks(env);
    const ui = await stepUserinfo({ ...env, ...tok });
    await stepWebId({ ...env, sub: ui.sub });
    await stepCss({ ...env, ...tok });
    console.log(JSON.stringify({ seed, auth, appr, cb, tok, ui }, null, 2));
  },
});

run([discoverCmd, seedCmd, authorizeCmd, approveCmd, callbackCmd, tokenCmd, jwksCmd, userinfoCmd, webidCmd, cssCmd, allCmd], {
  version: "0.1.0",
});

