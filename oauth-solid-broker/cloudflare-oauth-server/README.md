Cloudflare OAuth2 Mock Server
=============================

Minimal OAuth 2.1 provider using `@cloudflare/workers-oauth-provider` to support local testing. Stores tokens and client registrations in Workers KV.

What’s included

- Worker with authorization, token, client registration, and discovery endpoints
- Simple HTML consent page at `/authorize`
- Test API at `/api/whoami` that echoes authenticated `props`
- Admin helper endpoint to create a demo client: `/admin/seed-client?redirect_uri=...`

Requirements

- Node 18+
- pnpm
- Cloudflare Wrangler (`pnpm dlx wrangler --version` shows version)
- A Workers KV namespace

Setup

1) Install dependencies

   - cd cloudflare-oauth-server
   - pnpm install

2) Create a KV namespace

   - pnpm dlx wrangler kv namespace create OAUTH_KV
   - Copy the returned `id` to `wrangler.toml` under the `kv_namespaces` entry
   - Optionally set `preview_id` too for dev

3) Dev server

   - pnpm dev
   - Opens at http://localhost:8799 (pinned to avoid 8787 clashes)

4) Run tests

   - pnpm test

Usage

- Create a demo client via UI on `/` (home), or directly:

  - GET /admin/seed-client?redirect_uri=http://localhost:8787/callback
  - Response page shows `client_id` and `client_secret`

- Start an authorization flow (example PKCE/Code flow):

  - GET /authorize?response_type=code&client_id=...&redirect_uri=...&scope=profile%20email&state=xyz&code_challenge=...&code_challenge_method=S256
  - Approve on the consent page; you’ll be redirected back to the redirect URI with `code` and `state`

- Exchange code for tokens:

  - POST /oauth/token with `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier` (and `client_secret` for confidential clients)

- Call the protected API:

  - GET /api/whoami with `Authorization: Bearer <access_token>`

Notes

- Discovery is available at `/.well-known/oauth-authorization-server`.
- Client registration endpoint is available at `/oauth/register` (dynamic registration).
- This server is for testing only; it uses fixed demo user info in grants.
