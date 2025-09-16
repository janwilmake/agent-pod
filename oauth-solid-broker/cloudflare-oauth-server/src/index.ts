import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";

type Env = {
  OAUTH_KV: KVNamespace;
  // Helper API injected by OAuthProvider. Using any for loose typing.
  OAUTH_PROVIDER: any;
};

const HTML_HEADERS = { "content-type": "text/html; charset=UTF-8" };

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
    <div class="box" style="margin-top:1rem;">
      <h2 style="margin-top:0">Admin Utilities</h2>
      <p>Create a demo client (confidential) for quick testing:</p>
      <form method="get" action="/admin/seed-client">
        <div class="row">
          <label>
            Redirect URI:&nbsp;
            <input name="redirect_uri" type="url" placeholder="http://localhost:8787/callback" style="width: min(480px, 100%)" required />
          </label>
        </div>
        <div class="row">
          <button class="primary" type="submit">Create Client</button>
        </div>
      </form>
      <p><small>Use the returned <code>client_id</code> and <code>client_secret</code> with your test OAuth client.</small></p>
    </div>
  `);
}

function renderAuthorizePage(info: any, client: any): string {
  const requestedScopes = (info.scope || "").split(/\s+/).filter(Boolean);
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
        ${hiddenField("scope", info.scope || "")}
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

function hiddenField(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${escapeHtml(value || "")}">`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch: string) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[ch]);
}

function parseForm(req: Request): Promise<URLSearchParams> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    return req.text().then((t) => new URLSearchParams(t));
  }
  return req.formData().then((fd) => new URLSearchParams([...fd.entries()] as any));
}

export default new OAuthProvider<Env>({
  // All routes under /api/ require a valid access token and are sent to ApiHandler.
  apiRoute: "/api/",
  apiHandler: class ApiHandler extends WorkerEntrypoint<Env> {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") {
        // this.ctx.props were set when the grant was approved
        const props = (this.ctx as any).props || {};
        return new Response(JSON.stringify({ ok: true, props }), {
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("Not found", { status: 404 });
    }
  },

  // Non-API routes (including authorize UI) are handled here.
  defaultHandler: {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname === "/" && request.method === "GET") {
        return new Response(homePage(), { headers: HTML_HEADERS });
      }

      if (url.pathname === "/health") {
        return new Response("ok");
      }

      // Simple admin endpoint to create a demo client.
      if (url.pathname === "/admin/seed-client" && request.method === "GET") {
        const redirectUri = url.searchParams.get("redirect_uri");
        if (!redirectUri) {
          return new Response(layout("Missing redirect_uri", `<p>Please provide a <code>redirect_uri</code> query param.</p>`), { headers: HTML_HEADERS, status: 400 });
        }
        const client = await env.OAUTH_PROVIDER.createClient({
          client_name: "Demo Client",
          redirect_uris: [redirectUri],
        });
        const body = layout(
          "Client Created",
          `
          <div class="box">
            <p>Use these credentials with your test client:</p>
            <dl>
              <dt>client_id</dt><dd><code>${client.client_id}</code></dd>
              <dt>client_secret</dt><dd><code>${client.client_secret}</code></dd>
              <dt>redirect_uris</dt><dd><code>${client.redirect_uris?.join(', ')}</code></dd>
            </dl>
            <p><small>Store the secret securely; you cannot retrieve it later.</small></p>
          </div>
        `);
        return new Response(body, { headers: HTML_HEADERS });
      }

      if (url.pathname === "/admin/list-clients" && request.method === "GET") {
        // For debugging/testing only: list registered clients (metadata only; secrets are never returned)
        const list = await env.OAUTH_PROVIDER.listClients?.();
        return new Response(JSON.stringify(list || []), { headers: { "content-type": "application/json" } });
      }

      if (url.pathname === "/admin/check-client" && request.method === "GET") {
        const id = url.searchParams.get("id");
        if (!id) return new Response("Missing id", { status: 400 });
        try {
          const info = await env.OAUTH_PROVIDER.lookupClient(id);
          return new Response(JSON.stringify({ found: !!info, info }), { headers: { "content-type": "application/json" } });
        } catch (e) {
          return new Response(JSON.stringify({ found: false }), { headers: { "content-type": "application/json" }, status: 404 });
        }
      }

      // Render authorization consent UI.
      if (url.pathname === "/authorize" && request.method === "GET") {
        const info = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        const clientInfo = await env.OAUTH_PROVIDER.lookupClient(info.clientId);
        return new Response(renderAuthorizePage(info, clientInfo), { headers: HTML_HEADERS });
      }

      // Handle approve/deny from the consent form.
      if (url.pathname === "/authorize/approve" && request.method === "POST") {
        const form = await parseForm(request);
        const decision = form.get("decision");
        if (decision === "deny") {
          // Per RFC, return access_denied error via redirect back to client.
          const redirectUri = form.get("redirect_uri") || "";
          const state = form.get("state") || "";
          const separator = redirectUri.includes("?") ? "&" : "?";
          const location = `${redirectUri}${separator}error=access_denied&state=${encodeURIComponent(state)}`;
          return Response.redirect(location, 302);
        }

        const authReq = {
          responseType: form.get("response_type") || undefined,
          clientId: form.get("client_id") || undefined,
          redirectUri: form.get("redirect_uri") || undefined,
          scope: form.get("scope") || undefined,
          state: form.get("state") || undefined,
          codeChallenge: form.get("code_challenge") || undefined,
          codeChallengeMethod: form.get("code_challenge_method") || undefined,
        } as any;

        const requestedScopes = (authReq.scope || "").split(/\s+/).filter(Boolean);

        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: authReq,
          userId: "user-1234",
          metadata: { note: "demo grant" },
          scope: requestedScopes,
          props: {
            userId: "user-1234",
            username: "Demo User"
          }
        });
        return Response.redirect(redirectTo, 302);
      }

      return new Response("Not found", { status: 404 });
    }
  },

  // OAuth2 provider URLs. The provider implements these endpoints directly.
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",

  // Optional supported scopes to advertise in discovery (purely informational)
  scopesSupported: ["profile", "email", "document.read", "document.write"],

  // Toggle implicit flow if needed; keep disabled for OAuth 2.1
  allowImplicitFlow: false,

  // Example: 30-day refresh tokens (can be omitted to never expire)
  refreshTokenTTL: 60 * 60 * 24 * 30
});
