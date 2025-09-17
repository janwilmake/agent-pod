import { Hono } from "hono";
import type { Env } from "./types";

const HTML_HEADERS = { "content-type": "text/html; charset=UTF-8" } as const;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      :root { color-scheme: light dark; }
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 2rem auto; padding: 0 1rem; max-width: 720px; }
      header { margin-bottom: 1.5rem; }
      h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
      .box { border: 1px solid #8884; border-radius: 8px; padding: 1rem; }
      .row { margin: .5rem 0; }
      .actions { display: flex; gap: .75rem; margin-top: 1rem; }
      button, .btn { appearance: none; border: 1px solid #8886; background: #eee; color: inherit; padding: .5rem .75rem; border-radius: 6px; cursor: pointer; text-decoration: none; display: inline-block; }
      button.primary, .btn.primary { background: #2d6cdf; color: white; border-color: #2d6cdf; }
      code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      dl { display: grid; grid-template-columns: 10rem 1fr; gap: .5rem 1rem; }
      dt { font-weight: 600; }
      dd { margin: 0; }
      small { color: #888; }
    </style>
  </head>
  <body>
    <header>
      <h1>${title}</h1>
      <div><small>Cloudflare OAuth2 mock server</small></div>
    </header>
    <main>${body}</main>
  </body>
</html>`;
}

function homePage(): string {
  return layout(
    "OAuth2 Mock Server",
    `
    <div class="box">
      <p>This server implements an OAuth 2.1 provider suitable for local testing using Workers KV.</p>
      <ul>
        <li>Authorization endpoint: <code>/authorize</code></li>
        <li>Token endpoint: <code>/oauth/token</code></li>
        <li>Client registration: <code>/oauth/register</code></li>
        <li>Discovery: <code>/.well-known/oauth-authorization-server</code></li>
        <li>Test API: <code>/api/whoami</code></li>
      </ul>
    </div>
  `);
}

function hiddenField(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>\"]/g, (ch: string) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[ch] as string));
}

function renderAuthorizePage(info: any, client: any): string {
  const scopeStr = Array.isArray(info.scope) ? info.scope.join(" ") : (info.scope || "");
  const requestedScopes = scopeStr.split(/\s+/).filter(Boolean);
  return layout(
    "Authorize Access",
    `
    <div class="box">
      <p><strong>${client?.client_name || "An application"}</strong> is requesting access.</p>
      <dl>
        <dt>Client</dt><dd>${client?.client_name || info.clientId}</dd>
        <dt>Redirect URI</dt><dd><code>${info.redirectUri}</code></dd>
        <dt>Response Type</dt><dd><code>${info.responseType}</code></dd>
        <dt>Scopes</dt><dd>${requestedScopes.map((s: string) => `<code>${s}</code>`).join(" ") || "<em>none</em>"}</dd>
      </dl>
      <form method="post" action="/authorize/approve">
        ${hiddenField("response_type", info.responseType)}
        ${hiddenField("client_id", info.clientId)}
        ${hiddenField("redirect_uri", info.redirectUri)}
        ${hiddenField("scope", scopeStr)}
        ${hiddenField("state", info.state || "")}
        ${hiddenField("code_challenge", info.codeChallenge || "")}
        ${hiddenField("code_challenge_method", info.codeChallengeMethod || "")}
        <div class="actions">
          <button class="primary" type="submit" name="decision" value="approve">Approve</button>
          <button type="submit" name="decision" value="deny">Deny</button>
        </div>
      </form>
    </div>
  `);
}

export function buildUiApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/", async (c) => c.html(homePage(), 200, HTML_HEADERS));

  app.get("/health", async (c) => c.text("ok"));

  app.get("/authorize", async (c) => {
    const info = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    const clientInfo = await c.env.OAUTH_PROVIDER.lookupClient(info.clientId);
    return c.html(renderAuthorizePage(info, clientInfo), 200, HTML_HEADERS);
  });

  app.post("/authorize/approve", async (c) => {
    const form = await c.req.formData();
    const decision = String(form.get("decision") || "");
    if (decision === "deny") {
      const redirectUri = String(form.get("redirect_uri") || "");
      const state = String(form.get("state") || "");
      const sep = redirectUri.includes("?") ? "&" : "?";
      const location = `${redirectUri}${sep}error=access_denied&state=${encodeURIComponent(state)}`;
      return c.redirect(location, 302);
    }

    const authReq = {
      responseType: String(form.get("response_type") || ""),
      clientId: String(form.get("client_id") || ""),
      redirectUri: String(form.get("redirect_uri") || ""),
      scope: String(form.get("scope") || ""),
      state: String(form.get("state") || ""),
      codeChallenge: String(form.get("code_challenge") || ""),
      codeChallengeMethod: String(form.get("code_challenge_method") || ""),
    };

    const requestedScopes = (authReq.scope || "").split(/\s+/).filter(Boolean);
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: authReq,
      userId: "user-1234",
      metadata: { note: "demo grant" },
      scope: requestedScopes,
      props: { userId: "user-1234", username: "Demo User" },
    });
    return c.redirect(redirectTo, 302);
  });

  return app;
}

