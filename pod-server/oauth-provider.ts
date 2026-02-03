/// <reference types="@cloudflare/workers-types" />
/// <reference lib="esnext" />

/**
 * OAuth Provider - endpoints for downstream apps to authenticate with THIS app.
 * Endpoints: /.well-known/*, /register, /consent, /token, /me
 */

import { getMultiStub } from "multistub";
import type { Env, XUser, ResourceUserContext } from "./types";
import {
  getCorsHeaders,
  handleOptionsRequest,
  getAccessToken,
  generateCodeVerifier,
  encrypt,
  decrypt,
  USER_DO_PREFIX,
} from "./utils";

export { ResourceUserContext } from "./types";

/**
 * Middleware that handles OAuth provider endpoints for downstream apps.
 */
export async function oauthProviderMiddleware(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!env.X_OAUTH_PROVIDER_URL || !env.SELF_CLIENT_ID || !env.UserDO) {
    return new Response("Environment misconfigured", { status: 500 });
  }

  if (path === "/.well-known/oauth-authorization-server") {
    if (request.method === "OPTIONS") return handleOptionsRequest();

    const metadata = {
      issuer: url.origin,
      authorization_endpoint: `${url.origin}/authorize`,
      token_endpoint: `${url.origin}/token`,
      token_endpoint_auth_methods_supported: ["none"],
      registration_endpoint: `${url.origin}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [
        "read:{resource}",
        "write:{resource}",
        "append:{resource}",
      ],
    };

    return new Response(JSON.stringify(metadata, null, 2), {
      headers: { ...getCorsHeaders(), "Content-Type": "application/json" },
    });
  }

  if (path === "/.well-known/oauth-protected-resource") {
    if (request.method === "OPTIONS") return handleOptionsRequest();

    const metadata = {
      resource: url.origin,
      authorization_servers: [url.origin],
      scopes_supported: [
        "read:{resource}",
        "write:{resource}",
        "append:{resource}",
      ],
      bearer_methods_supported: ["header"],
      resource_documentation: url.origin,
    };

    return new Response(JSON.stringify(metadata, null, 2), {
      headers: { ...getCorsHeaders(), "Content-Type": "application/json" },
    });
  }

  if (path === "/register") {
    return handleRegister(request);
  }

  if (path === "/consent") {
    return handleConsent(request, env);
  }

  if (path === "/token") {
    return handleToken(request, env, ctx);
  }

  if (path === "/me") {
    return handleMe(request, env);
  }

  return null;
}

async function handleRegister(request: Request): Promise<Response> {
  if (request.method === "OPTIONS")
    return handleOptionsRequest(["POST", "OPTIONS"]);
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: getCorsHeaders(["POST", "OPTIONS"]),
    });
  }

  try {
    const body = (await request.json()) as any;
    if (
      !body.redirect_uris ||
      !Array.isArray(body.redirect_uris) ||
      body.redirect_uris.length === 0
    ) {
      return new Response(
        JSON.stringify({
          error: "invalid_client_metadata",
          error_description: "redirect_uris must be a non-empty array",
        }),
        {
          status: 400,
          headers: {
            ...getCorsHeaders(["POST", "OPTIONS"]),
            "Content-Type": "application/json",
          },
        }
      );
    }

    const hostnames = new Set();
    for (const uri of body.redirect_uris) {
      try {
        const parsedUrl = new URL(uri);
        hostnames.add(parsedUrl.hostname);
      } catch {
        return new Response(
          JSON.stringify({
            error: "invalid_redirect_uri",
            error_description: `Invalid redirect URI: ${uri}`,
          }),
          {
            status: 400,
            headers: {
              ...getCorsHeaders(["POST", "OPTIONS"]),
              "Content-Type": "application/json",
            },
          }
        );
      }
    }

    if (hostnames.size !== 1) {
      return new Response(
        JSON.stringify({
          error: "invalid_client_metadata",
          error_description: "All redirect URIs must have the same host",
        }),
        {
          status: 400,
          headers: {
            ...getCorsHeaders(["POST", "OPTIONS"]),
            "Content-Type": "application/json",
          },
        }
      );
    }

    const clientHost = Array.from(hostnames)[0];
    const response = {
      client_id: clientHost,
      redirect_uris: body.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    };

    return new Response(JSON.stringify(response, null, 2), {
      status: 201,
      headers: {
        ...getCorsHeaders(["POST", "OPTIONS"]),
        "Content-Type": "application/json",
      },
    });
  } catch {
    return new Response(
      JSON.stringify({
        error: "invalid_client_metadata",
        error_description: "Invalid JSON in request body",
      }),
      {
        status: 400,
        headers: {
          ...getCorsHeaders(["POST", "OPTIONS"]),
          "Content-Type": "application/json",
        },
      }
    );
  }
}

async function handleConsent(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: getCorsHeaders(),
    });
  }

  const formData = await request.formData();
  const action = formData.get("action");
  const clientId = formData.get("client_id") as string;
  const redirectUri = formData.get("redirect_uri") as string;
  const state = formData.get("state") as string;
  const originalScopes = (formData.get("original_scopes") as string).split(" ");
  const selectedResourcesJson = formData.get("selected_resources") as string;
  const resource = formData.get("resource") as string;
  const userId = formData.get("user_id") as string;

  const redirectUrl = new URL(redirectUri);

  if (action === "deny") {
    redirectUrl.searchParams.set("error", "access_denied");
    if (state) redirectUrl.searchParams.set("state", state);

    return new Response(null, {
      status: 302,
      headers: { ...getCorsHeaders(), Location: redirectUrl.toString() },
    });
  }

  let selectedResources: string[] = [];
  if (selectedResourcesJson) {
    try {
      selectedResources = JSON.parse(selectedResourcesJson);
    } catch {
      selectedResources = [];
    }
  }

  const finalScopes: string[] = [];

  for (const scope of originalScopes) {
    if (scope.includes(":{resource}") || scope.includes(":{*}")) {
      const scopeAction = scope.split(":")[0];
      if (selectedResources.length === 0) {
        redirectUrl.searchParams.set("error", "invalid_request");
        redirectUrl.searchParams.set(
          "error_description",
          "No resources selected for variable scopes"
        );
        if (state) redirectUrl.searchParams.set("state", state);

        return new Response(null, {
          status: 302,
          headers: { ...getCorsHeaders(), Location: redirectUrl.toString() },
        });
      }

      for (const selectedResource of selectedResources) {
        finalScopes.push(`${scopeAction}:${selectedResource}`);
      }
    } else {
      finalScopes.push(scope);
    }
  }

  const authCode = generateCodeVerifier();
  const userDO = env.UserDO.get(
    env.UserDO.idFromName(`${USER_DO_PREFIX}code:${authCode}`)
  );

  await userDO.setAuthData(authCode, {
    userId,
    clientId,
    redirectUri,
    resource,
    scopes: finalScopes,
  });

  redirectUrl.searchParams.set("code", authCode);
  if (state) redirectUrl.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: { ...getCorsHeaders(), Location: redirectUrl.toString() },
  });
}

async function handleToken(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method === "OPTIONS")
    return handleOptionsRequest(["POST", "OPTIONS"]);
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: getCorsHeaders(["POST", "OPTIONS"]),
    });
  }

  const formData = await request.formData();
  const grantType = formData.get("grant_type");
  const code = formData.get("code") as string;
  const clientId = formData.get("client_id") as string;
  const resource = formData.get("resource") as string;

  if (grantType !== "authorization_code") {
    return new Response(JSON.stringify({ error: "unsupported_grant_type" }), {
      status: 400,
      headers: {
        ...getCorsHeaders(["POST", "OPTIONS"]),
        "Content-Type": "application/json",
      },
    });
  }

  if (!code || !clientId) {
    return new Response(JSON.stringify({ error: "invalid_request" }), {
      status: 400,
      headers: {
        ...getCorsHeaders(["POST", "OPTIONS"]),
        "Content-Type": "application/json",
      },
    });
  }

  const userDO = env.UserDO.get(
    env.UserDO.idFromName(`${USER_DO_PREFIX}code:${code}`)
  );
  const authData = await userDO.getAuthData(code);

  if (!authData || authData.clientId !== clientId) {
    return new Response(JSON.stringify({ error: "invalid_grant" }), {
      status: 400,
      headers: {
        ...getCorsHeaders(["POST", "OPTIONS"]),
        "Content-Type": "application/json",
      },
    });
  }

  const tokenData = `${authData.userId};${resource};${JSON.stringify(
    authData.scopes
  )}`;
  const encryptedData = await encrypt(tokenData, env.ENCRYPTION_SECRET);
  const accessToken = `resource_${encryptedData}`;

  const resourceUserDO = getMultiStub(
    env.UserDO,
    [
      { name: `${USER_DO_PREFIX}${authData.userId}` },
      { name: `${USER_DO_PREFIX}aggregate:` },
    ],
    ctx
  );

  await resourceUserDO.createResourceLogin(
    authData.userId,
    clientId,
    accessToken,
    authData.scopes
  );

  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: "bearer",
      scope: authData.scopes.join(" "),
    }),
    {
      headers: {
        ...getCorsHeaders(["POST", "OPTIONS"]),
        "Content-Type": "application/json",
      },
    }
  );
}

async function handleMe(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return handleOptionsRequest();
  if (request.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: getCorsHeaders(),
    });
  }

  const accessToken = getAccessToken(request);
  if (!accessToken || !accessToken.startsWith("resource_")) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...getCorsHeaders(), "Content-Type": "application/json" },
    });
  }

  try {
    const encryptedData = accessToken.substring(9);
    const decryptedData = await decrypt(encryptedData, env.ENCRYPTION_SECRET);
    const [userId] = decryptedData.split(";");

    const userDO = env.UserDO.get(
      env.UserDO.idFromName(`${USER_DO_PREFIX}${userId}`)
    );
    await userDO.updateActivity(accessToken);

    const loginData = await userDO.getResourceLogin(accessToken);
    if (!loginData) {
      return new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: { ...getCorsHeaders(), "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        ...loginData.user,
        scopes: loginData.scopes,
      }),
      {
        headers: { ...getCorsHeaders(), "Content-Type": "application/json" },
      }
    );
  } catch {
    return new Response(JSON.stringify({ error: "invalid_token" }), {
      status: 401,
      headers: { ...getCorsHeaders(), "Content-Type": "application/json" },
    });
  }
}

// ============================================================================
// Token Validation Middleware - for protecting resources
// ============================================================================

interface ResourceUserFetchHandler<
  TEnv = {},
  TMetadata = { [key: string]: any }
> {
  (
    request: Request,
    env: Env & TEnv,
    ctx: ResourceUserContext<TMetadata>
  ): Response | Promise<Response>;
}

/**
 * Middleware that validates OAuth tokens and provides user context.
 */
export function tokenValidationMiddleware<
  TEnv = {},
  TMetadata = { [key: string]: any }
>(
  handler: ResourceUserFetchHandler<TEnv, TMetadata>,
  config?: {
    isLoginRequired?: boolean;
    requiredScopes?: string[];
  }
): ExportedHandlerFetchHandler<Env & TEnv> {
  return async (
    request: Request,
    env: TEnv & Env,
    ctx: ExecutionContext
  ): Promise<Response> => {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, x-username, x-api-key",
          "Access-Control-Max-Age": "0",
        },
      });
    }

    let user: XUser | undefined = undefined;
    let scopes: string[] = [];
    const accessToken = getAccessToken(request) ?? undefined;

    if (accessToken && accessToken.startsWith("resource_")) {
      try {
        const encryptedData = accessToken.substring(9);
        const decryptedData = await decrypt(
          encryptedData,
          env.ENCRYPTION_SECRET
        );
        const [userId] = decryptedData.split(";");

        const userDO = env.UserDO.get(
          env.UserDO.idFromName(`${USER_DO_PREFIX}${userId}`)
        );
        const loginData = await userDO.getResourceLogin(accessToken);
        if (loginData) {
          user = loginData.user;
          scopes = loginData.scopes;
        }
      } catch {
        // Invalid token
      }
    }

    const hasScope = (requiredScope: string): boolean => {
      if (scopes.includes(requiredScope)) return true;

      const [requiredAction, requiredResource = ""] = requiredScope.split(
        ":",
        2
      );

      for (const grantedScope of scopes) {
        const [grantedAction, grantedResource = ""] = grantedScope.split(
          ":",
          2
        );

        if (grantedAction !== requiredAction) continue;
        if (grantedResource === "") return true;

        if (requiredResource === "") {
          if (scopes.includes(requiredAction)) return true;
          continue;
        }

        if (requiredResource.startsWith(grantedResource)) {
          if (grantedResource === "" || requiredResource === grantedResource) {
            return true;
          }

          const nextChar = requiredResource.charAt(grantedResource.length);
          if (
            grantedResource.endsWith("/") ||
            nextChar === "/" ||
            nextChar === ""
          ) {
            return true;
          }
        }
      }

      if (requiredScope.includes(":")) {
        return scopes.includes(requiredAction);
      }

      return false;
    };

    if (config?.isLoginRequired && !user) {
      const url = new URL(request.url);
      const loginUrl = `${
        url.origin
      }/authorize?redirect_uri=${encodeURIComponent(request.url)}&client_id=${
        env.SELF_CLIENT_ID
      }&scope=read:{resource}%20write:{resource}%20append:{resource}`;

      return new Response("Authentication required: " + loginUrl, {
        status: 401,
        headers: { ...getCorsHeaders(), Location: loginUrl },
      });
    }

    if (
      config?.requiredScopes &&
      config.requiredScopes.some((scope) => !hasScope(scope))
    ) {
      return new Response("Insufficient scope", {
        status: 403,
        headers: getCorsHeaders(),
      });
    }

    const enhancedCtx: ResourceUserContext<TMetadata> = {
      passThroughOnException: () => ctx.passThroughOnException(),
      props: ctx.props,
      waitUntil: (promise: Promise<any>) => ctx.waitUntil(promise),
      user,
      scopes,
      accessToken,
      hasScope,
    };

    const response = await handler(request, env, enhancedCtx);

    // WebSocket responses must be returned as-is - don't wrap them
    // or the webSocket property will be lost
    if (response.status === 101 && (response as any).webSocket) {
      return response;
    }

    const newHeaders = new Headers(response.headers);

    Object.entries(getCorsHeaders()).forEach(([key, value]) => {
      newHeaders.set(key, value);
    });

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  };
}
