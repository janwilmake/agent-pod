/// <reference types="@cloudflare/workers-types" />
/// <reference lib="esnext" />

/**
 * OAuth Client - handles authentication with the upstream X OAuth provider.
 * Endpoints: /authorize, /callback
 */

import { getMultiStub } from "multistub";
import type { Env, XUser, OAuthState } from "./types";
import {
  getCorsHeaders,
  handleOptionsRequest,
  parseCookies,
  generateCodeVerifier,
  generateCodeChallenge,
  isLocalhost,
  validateScopes,
  USER_DO_PREFIX,
} from "./utils";
import { showConsentPage } from "./consent";

export { UserDO } from "./user-do";

/**
 * Middleware that handles OAuth client endpoints for authenticating with upstream X OAuth.
 * Handles /authorize and /callback endpoints.
 */
export async function oauthClientMiddleware(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/authorize") {
    return handleAuthorize(request, env);
  }

  if (path === "/callback") {
    return handleCallback(request, env, ctx);
  }

  return null;
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return handleOptionsRequest();

  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const responseType = url.searchParams.get("response_type") || "code";
  const state = url.searchParams.get("state");
  const scope = url.searchParams.get("scope") || "";
  const resource = url.searchParams.get("resource");

  if (!clientId || !redirectUri) {
    return new Response("Missing required parameters", {
      status: 400,
      headers: getCorsHeaders(),
    });
  }

  if (responseType !== "code") {
    return new Response("Unsupported response_type", {
      status: 400,
      headers: getCorsHeaders(),
    });
  }

  const requestedScopes = scope.split(" ").filter((s) => s);
  const validScopes = validateScopes(requestedScopes);
  if (!validScopes) {
    return new Response("Invalid scopes", {
      status: 400,
      headers: getCorsHeaders(),
    });
  }

  // Check if user is already authenticated with X provider
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const xAccessToken = cookies.x_access_token;

  if (xAccessToken) {
    try {
      const userResponse = await fetch(`${env.X_OAUTH_PROVIDER_URL}/me`, {
        headers: { Authorization: `Bearer ${xAccessToken}` },
      });

      if (userResponse.ok) {
        const user = (await userResponse.json()) as XUser;
        return showConsentPage(
          user,
          clientId,
          redirectUri,
          state,
          requestedScopes,
          resource,
          env
        );
      }
    } catch (error) {
      console.error("Error checking X provider authentication:", error);
    }
  }

  // User not authenticated, redirect to X provider
  const oauthState: OAuthState = {
    codeVerifier: generateCodeVerifier(),
    clientId,
    redirectUri,
    state: state ?? undefined,
    scopes: requestedScopes,
    resource: resource ?? undefined,
  };

  const stateString = btoa(JSON.stringify(oauthState));
  const codeChallenge = await generateCodeChallenge(oauthState.codeVerifier);

  const xAuthUrl = new URL(`${env.X_OAUTH_PROVIDER_URL}/authorize`);
  xAuthUrl.searchParams.set("response_type", "code");
  xAuthUrl.searchParams.set("client_id", env.SELF_CLIENT_ID);
  xAuthUrl.searchParams.set("redirect_uri", `${url.origin}/callback`);
  xAuthUrl.searchParams.set("resource", env.X_OAUTH_PROVIDER_URL);
  xAuthUrl.searchParams.set("state", stateString);
  xAuthUrl.searchParams.set("code_challenge", codeChallenge);
  xAuthUrl.searchParams.set("code_challenge_method", "S256");

  const secureFlag = isLocalhost(request) ? "" : " Secure;";

  return new Response(null, {
    status: 302,
    headers: {
      ...getCorsHeaders(),
      Location: xAuthUrl.toString(),
      "Set-Cookie": `oauth_state=${encodeURIComponent(
        stateString
      )}; HttpOnly;${secureFlag} SameSite=Lax; Max-Age=600; Path=/`,
    },
  });
}

async function handleCallback(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method === "OPTIONS") return handleOptionsRequest();

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");

  if (!code || !stateParam) {
    return new Response("Missing code or state parameter", {
      status: 400,
      headers: getCorsHeaders(),
    });
  }

  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const stateCookie = cookies.oauth_state;

  if (!stateCookie || stateCookie !== stateParam) {
    return new Response("Invalid state", {
      status: 400,
      headers: getCorsHeaders(),
    });
  }

  let oauthState: OAuthState;
  try {
    oauthState = JSON.parse(atob(stateCookie));
  } catch {
    return new Response("Invalid state format", {
      status: 400,
      headers: getCorsHeaders(),
    });
  }

  // Exchange code for token with X provider
  const tokenResponse = await fetch(`${env.X_OAUTH_PROVIDER_URL}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code: code,
      client_id: env.SELF_CLIENT_ID,
      redirect_uri: `${url.origin}/callback`,
      resource: env.X_OAUTH_PROVIDER_URL,
      grant_type: "authorization_code",
      code_verifier: oauthState.codeVerifier,
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error("X provider token exchange failed:", errorText);
    return new Response(`Authentication failed: ${errorText}`, {
      status: 400,
      headers: getCorsHeaders(),
    });
  }

  const tokenData = (await tokenResponse.json()) as any;
  const xAccessToken = tokenData.access_token;

  // Get user info from X provider
  const userResponse = await fetch(`${env.X_OAUTH_PROVIDER_URL}/me`, {
    headers: { Authorization: `Bearer ${xAccessToken}` },
  });

  if (!userResponse.ok) {
    return new Response("Failed to get user info", {
      status: 400,
      headers: getCorsHeaders(),
    });
  }

  const user = (await userResponse.json()) as XUser;

  // Store user in our database
  const userDO = getMultiStub(
    env.UserDO,
    [
      { name: `${USER_DO_PREFIX}${user.id}` },
      { name: `${USER_DO_PREFIX}aggregate:` },
    ],
    ctx
  );

  await userDO.setUser(user, xAccessToken);

  // Show consent page
  const secureFlag = isLocalhost(request) ? "" : " Secure;";
  const consentPageResponse = await showConsentPage(
    user,
    oauthState.clientId,
    oauthState.redirectUri,
    oauthState.state ?? null,
    oauthState.scopes,
    oauthState.resource ?? null,
    env
  );

  // Set X access token cookie and clear oauth state
  const headers = new Headers(consentPageResponse.headers);
  headers.append(
    "Set-Cookie",
    `x_access_token=${xAccessToken}; HttpOnly;${secureFlag} SameSite=Lax; Max-Age=3600; Path=/`
  );
  headers.append(
    "Set-Cookie",
    `oauth_state=; HttpOnly;${secureFlag} SameSite=Lax; Max-Age=0; Path=/`
  );

  return new Response(consentPageResponse.body, {
    status: consentPageResponse.status,
    headers,
  });
}
