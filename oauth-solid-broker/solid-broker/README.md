Solid OIDC Broker (MVP)
=======================

Minimal Solid OIDC Broker implemented as a Cloudflare Worker. It brokers authentication from a backing OAuth/OIDC provider and mints Solid-compatible ID and access tokens with a `webid` claim. Exposes standard discovery and JWKS endpoints.

What’s included

- OIDC Discovery at `/.well-known/openid-configuration`
- Authorization Code + PKCE flow via `/authorize` and `/callback`
- Token endpoint `/token` that returns signed `id_token` and `access_token` (RS256)
- JWKS at `/jwks` (driven by configured RSA key)
- Minimal client registry with seeding endpoint `/admin/seed-client?redirect_uri=...`

Assumptions

- This broker is the OpenID Provider (OP) for Solid clients. The backing provider can be OAuth2 or OIDC; we only need a stable user id to derive `webid`.
- The `webid` is minted using `WEBID_HOST` and (by default) the backing user `sub` claim: `https://<WEBID_HOST>/<sub>`.
- Tokens expire in ~5 minutes (configurable).

Requirements

- Node 18+
- pnpm
- Cloudflare Wrangler
- A Workers KV namespace for codes/clients
- An RSA private key in PKCS#8 PEM format (bound via environment secret)

Configuration (wrangler.toml / environment)

- `BROKER_ISSUER` (string): The external issuer URL for this broker, e.g. `https://openid.example.com`
- `WEBID_HOST` (string): Host for minting WebIDs, e.g. `id.example.com`
- `TOKEN_TTL_SECONDS` (number, default 300): Token lifetime
- `JWT_PRIVATE_KEY_PEM` (secret): RSA private key (PKCS#8 PEM) used for RS256 signing
- `JWT_KID` (string): Key id advertised in JWKS for the active key

Backing provider

- `BACKING_ISSUER` (string): Base URL of the OAuth/OIDC provider (e.g. the local `cloudflare-oauth-server`)
- `BACKING_CLIENT_ID` (string): Client id issued by the backing provider to the broker
- `BACKING_CLIENT_SECRET` (secret): Client secret for the broker at the backing provider
- `BACKING_AUTH_PATH` (string, default `/authorize`)
- `BACKING_TOKEN_PATH` (string, default `/oauth/token`)
- `BACKING_USERINFO_PATH` (string, optional): If the backing provider is OAuth2-only, set a user info endpoint to fetch a stable user id

KV bindings

- `BROKER_KV` (KV): storage for authorization codes and client registrations

Local development

1) Install deps

   - cd solid-broker
   - pnpm install

2) Create KV namespace and bind

   - pnpm dlx wrangler kv namespace create BROKER_KV

3) Add secrets / env

   - pnpm dlx wrangler secret put JWT_PRIVATE_KEY_PEM
   - pnpm dlx wrangler secret put BACKING_CLIENT_SECRET
   - Edit `wrangler.toml` to set the rest (issuer, host, client ids)

4) Dev

   - pnpm dev

Seeding a demo client

- GET `/admin/seed-client?redirect_uri=http://localhost:8777/callback`
- Response shows `client_id` and `client_secret`. Use those with `/authorize`.

Authorize flow (example)

- GET `/authorize?response_type=code&client_id=...&redirect_uri=http://localhost:8777/callback&scope=openid%20webid&state=xyz&code_challenge=...&code_challenge_method=S256`
- You’ll be redirected to the backing provider to login, then back to the client with `code`.
- Exchange at `/token` with `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `client_secret` (if confidential), and `code_verifier`.

Notes

- This is an MVP. It omits refresh tokens, DPoP, dynamic client registration UI, and full error object shapes. Those can be added incrementally.

