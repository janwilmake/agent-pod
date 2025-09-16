import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./types";
import { buildUiApp } from "./ui";
import { ApiHandler } from "./api";

const uiApp = buildUiApp();

export default new OAuthProvider<Env>({
  // All routes under /api/ require a valid access token and are sent to ApiHandler.
  apiRoute: "/api/",
  apiHandler: ApiHandler,

  // Non-API routes (including authorize UI) are handled here.
  defaultHandler: {
    async fetch(request, env, ctx) {
      return uiApp.fetch(request, env, ctx);
    },
  },

  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["profile", "email", "document.read", "document.write"],
  allowImplicitFlow: false,
  refreshTokenTTL: 60 * 60 * 24 * 30,
});
