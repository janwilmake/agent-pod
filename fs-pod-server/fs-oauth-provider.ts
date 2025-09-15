/// <reference types="@cloudflare/workers-types" />
/// <reference lib="esnext" />
//https://letmeprompt.com/rules-httpsuithu-pmz52g0
import { DurableObject } from "cloudflare:workers";
import { getMultiStub } from "multistub";
import {
  Queryable,
  QueryableHandler,
  studioMiddleware,
} from "queryable-object";

const USER_DO_PREFIX = "user-resource-v1:";

export interface Env {
  SELF_CLIENT_ID: string;
  X_OAUTH_PROVIDER_URL: string; // https://login.wilmake.com
  ENCRYPTION_SECRET: string;
  ADMIN_X_USERNAME: string;
  UserDO: DurableObjectNamespace<UserDO & QueryableHandler>;
}

export interface XUser {
  id: string;
  name: string;
  username: string;
  profile_image_url?: string;
  verified?: boolean;
  [key: string]: any;
}

interface OAuthState {
  redirectTo?: string;
  codeVerifier: string;
  resource?: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  scopes: string[];
}

// Helper function for CORS headers
function getCorsHeaders(
  allowedMethods: string[] = ["GET", "OPTIONS"]
): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": allowedMethods.join(", "),
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, MCP-Protocol-Version",
  };
}

function handleOptionsRequest(
  allowedMethods: string[] = ["GET", "OPTIONS"]
): Response {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(allowedMethods),
  });
}

@Queryable()
export class UserDO extends DurableObject {
  private storage: DurableObjectStorage;
  public sql: SqlStorage;
  public env: Env;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.storage = state.storage;
    this.sql = state.storage.sql;
    this.env = env;

    // Initialize users table (cached from X provider)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        username TEXT NOT NULL,
        profile_image_url TEXT,
        verified BOOLEAN DEFAULT FALSE,
        x_access_token TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        last_active_at INTEGER DEFAULT (unixepoch()),
        session_count INTEGER DEFAULT 1
      )
    `);

    // Initialize resource logins table with scopes
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS resource_logins (
        access_token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        scopes TEXT NOT NULL, -- JSON array of granted scopes
        created_at INTEGER DEFAULT (unixepoch()),
        last_active_at INTEGER DEFAULT (unixepoch()),
        session_count INTEGER DEFAULT 1,
        FOREIGN KEY (user_id) REFERENCES users (user_id)
      )
    `);
  }

  async setUser(user: XUser, xAccessToken: string) {
    const now = Math.floor(Date.now() / 1000);
    const { id, name, username, profile_image_url, verified } = user;

    this.sql.exec(
      `INSERT OR REPLACE INTO users 
       (user_id, name, username, profile_image_url, verified, x_access_token, updated_at, last_active_at, session_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT session_count FROM users WHERE user_id = ?), 1))`,
      id,
      name,
      username,
      profile_image_url || null,
      verified || false,
      xAccessToken,
      now,
      now,
      id
    );
  }

  async createResourceLogin(
    userId: string,
    clientId: string,
    accessToken: string,
    scopes: string[]
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    this.sql.exec(
      `INSERT OR REPLACE INTO resource_logins (access_token, user_id, client_id, scopes, last_active_at, session_count)
       VALUES (?, ?, ?, ?, ?, COALESCE((SELECT session_count FROM resource_logins WHERE access_token = ?), 1))`,
      accessToken,
      userId,
      clientId,
      JSON.stringify(scopes),
      now,
      accessToken
    );
  }

  async getResourceLogin(accessToken: string): Promise<{
    user: XUser;
    scopes: string[];
  } | null> {
    const result = this.sql
      .exec(
        `
      SELECT rl.scopes, u.* 
      FROM resource_logins rl
      JOIN users u ON rl.user_id = u.user_id
      WHERE rl.access_token = ?
    `,
        accessToken
      )
      .toArray()[0];

    if (!result) return null;

    const user: XUser = {
      id: result.user_id as string,
      name: result.name as string,
      username: result.username as string,
      ...(result.profile_image_url && {
        profile_image_url: result.profile_image_url as string,
      }),
      ...(result.verified && { verified: result.verified as boolean }),
    };

    return {
      user,
      scopes: JSON.parse(result.scopes as string),
    };
  }

  async setAuthData(authCode: string, data: any) {
    await this.storage.put(`code:${authCode}`, data);
  }

  async getAuthData(authCode: string) {
    return this.storage.get(`code:${authCode}`);
  }

  async updateActivity(accessToken: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const oneHourAgo = now - 3600;
    const fourHoursAgo = now - 14400;

    const result = this.sql
      .exec(
        `SELECT user_id, last_active_at FROM resource_logins WHERE access_token = ?`,
        accessToken
      )
      .toArray()[0];

    if (!result) return;

    const lastActive = result.last_active_at as number;
    if (lastActive < fourHoursAgo) {
      this.sql.exec(
        `UPDATE resource_logins SET last_active_at = ?, session_count = session_count + 1 WHERE access_token = ?`,
        now,
        accessToken
      );
    } else if (lastActive < oneHourAgo) {
      this.sql.exec(
        `UPDATE resource_logins SET last_active_at = ? WHERE access_token = ?`,
        now,
        accessToken
      );
    }
  }
}

export async function handleResourceOAuth(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!env.X_OAUTH_PROVIDER_URL || !env.SELF_CLIENT_ID || !env.UserDO) {
    return new Response("Environment misconfigured", { status: 500 });
  }

  // OAuth metadata endpoints
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
      scopes_supported: ["read", "write", "append"], // Base scopes, resources added dynamically
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
      scopes_supported: ["read", "write", "append"],
      bearer_methods_supported: ["header"],
      resource_documentation: url.origin,
    };

    return new Response(JSON.stringify(metadata, null, 2), {
      headers: { ...getCorsHeaders(), "Content-Type": "application/json" },
    });
  }

  if (path === "/register") {
    if (request.method === "OPTIONS")
      return handleOptionsRequest(["POST", "OPTIONS"]);
    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: getCorsHeaders(["POST", "OPTIONS"]),
      });
    }

    try {
      const body = await request.json();
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
          const url = new URL(uri);
          hostnames.add(url.hostname);
        } catch (e) {
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
    } catch (error) {
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

  if (path === "/authorize") {
    return handleAuthorize(request, env, ctx);
  }

  if (path === "/consent") {
    return handleConsent(request, env, ctx);
  }

  if (path === "/token") {
    return handleToken(request, env, ctx);
  }

  if (path === "/me") {
    return handleMe(request, env, ctx);
  }

  return null;
}

async function handleAuthorize(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
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

  // Parse and validate scopes
  const requestedScopes = scope.split(" ").filter((s) => s);
  const validScopes = validateScopes(requestedScopes);
  if (!validScopes) {
    return new Response("Invalid scopes", {
      status: 400,
      headers: getCorsHeaders(),
    });
  }

  // Check if user is already authenticated with X provider
  const accessToken = getAccessToken(request);
  if (accessToken) {
    // Try to get user from X provider
    try {
      const userResponse = await fetch(`${env.X_OAUTH_PROVIDER_URL}/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (userResponse.ok) {
        const user = (await userResponse.json()) as XUser;
        // User is authenticated, show consent page
        return showConsentPage(
          user,
          clientId,
          redirectUri,
          state,
          requestedScopes,
          resource
        );
      }
    } catch (error) {
      // Continue to X provider auth
    }
  }

  // User not authenticated, redirect to X provider
  const oauthState: OAuthState = {
    codeVerifier: generateCodeVerifier(),
    clientId,
    redirectUri,
    state,
    scopes: requestedScopes,
    resource,
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

  return new Response(null, {
    status: 302,
    headers: {
      ...getCorsHeaders(),
      Location: xAuthUrl.toString(),
      "Set-Cookie": `oauth_state=${encodeURIComponent(
        stateString
      )}; HttpOnly; SameSite=Lax; Max-Age=600; Path=/`,
    },
  });
}

function showConsentPage(
  user: XUser,
  clientId: string,
  redirectUri: string,
  state: string | null,
  scopes: string[],
  resource: string | null
): Response {
  // Parse scopes to show user-friendly descriptions
  const scopeDescriptions = scopes.map((scope) => {
    const [action, res] = scope.split(":");
    return {
      scope,
      action,
      resource: res || "all files",
      description: getScopeDescription(action, res),
    };
  });

  const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Authorize ${clientId}</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
        body { font-family: system-ui; max-width: 400px; margin: 100px auto; padding: 20px; }
        .user-info { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; padding: 16px; border: 1px solid #ddd; border-radius: 8px; }
        .avatar { width: 48px; height: 48px; border-radius: 50%; }
        .scopes { margin: 20px 0; }
        .scope-item { padding: 8px; margin: 4px 0; background: #f5f5f5; border-radius: 4px; }
        .actions { display: flex; gap: 12px; }
        button { padding: 12px 24px; border: none; border-radius: 6px; cursor: pointer; }
        .approve { background: #007bff; color: white; }
        .deny { background: #6c757d; color: white; }
    </style>
</head>
<body>
    <h2>Authorize ${clientId}</h2>
    
    <div class="user-info">
        <img src="${user.profile_image_url || ""}" alt="Avatar" class="avatar">
        <div>
            <div><strong>${user.name}</strong></div>
            <div>@${user.username}</div>
        </div>
    </div>

    <p><strong>${clientId}</strong> wants to access your files with the following permissions:</p>
    
    <div class="scopes">
        ${scopeDescriptions
          .map(
            (s) => `
            <div class="scope-item">
                <strong>${s.action.toUpperCase()}</strong> access to <strong>${
              s.resource
            }</strong>
                <div style="font-size: 0.9em; color: #666;">${
                  s.description
                }</div>
            </div>
        `
          )
          .join("")}
    </div>

    <form method="POST" action="/consent" class="actions">
        <input type="hidden" name="client_id" value="${clientId}">
        <input type="hidden" name="redirect_uri" value="${redirectUri}">
        <input type="hidden" name="state" value="${state || ""}">
        <input type="hidden" name="scopes" value="${scopes.join(" ")}">
        <input type="hidden" name="resource" value="${resource || ""}">
        <input type="hidden" name="user_id" value="${user.id}">
        
        <button type="submit" name="action" value="approve" class="approve">Authorize</button>
        <button type="submit" name="action" value="deny" class="deny">Deny</button>
    </form>
</body>
</html>`;

  return new Response(html, {
    headers: { ...getCorsHeaders(), "Content-Type": "text/html" },
  });
}

async function handleConsent(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
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
  const scopes = (formData.get("scopes") as string).split(" ");
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

  // User approved, create auth code
  const authCode = generateCodeVerifier();
  const userDO = env.UserDO.get(
    env.UserDO.idFromName(`${USER_DO_PREFIX}${userId}`)
  );

  await userDO.setAuthData(authCode, {
    userId,
    clientId,
    redirectUri,
    resource,
    scopes,
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

  // Get auth data
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

  // Create encrypted access token
  const tokenData = `${authData.userId};${resource};${JSON.stringify(
    authData.scopes
  )}`;
  const encryptedData = await encrypt(tokenData, env.ENCRYPTION_SECRET);
  const accessToken = `resource_${encryptedData}`;

  // Store resource login
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

async function handleMe(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
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
    const encryptedData = accessToken.substring(9); // Remove "resource_" prefix
    const decryptedData = await decrypt(encryptedData, env.ENCRYPTION_SECRET);
    const [userId, resource, scopesJson] = decryptedData.split(";");
    const scopes = JSON.parse(scopesJson);

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
  } catch (error) {
    return new Response(JSON.stringify({ error: "invalid_token" }), {
      status: 401,
      headers: { ...getCorsHeaders(), "Content-Type": "application/json" },
    });
  }
}

// Utility functions
function validateScopes(scopes: string[]): boolean {
  const validActions = ["read", "write", "append"];

  for (const scope of scopes) {
    if (!scope.includes(":")) {
      // Plain scope like "read", "write", "append" - valid for all resources
      if (!validActions.includes(scope)) return false;
    } else {
      const [action, resource] = scope.split(":", 2);
      if (!validActions.includes(action)) return false;
      if (!resource || resource.startsWith("/") || resource.includes(".."))
        return false;
    }
  }

  return true;
}

function getScopeDescription(action: string, resource?: string): string {
  const resourceStr = resource || "all your files";
  switch (action) {
    case "read":
      return `View and download ${resourceStr}`;
    case "write":
      return `Create, modify, and delete ${resourceStr}`;
    case "append":
      return `Add content to ${resourceStr}`;
    default:
      return `${action} access to ${resourceStr}`;
  }
}

function getAccessToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.substring(7);
  }

  // Fallback to cookie
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  return cookies.access_token || null;
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  cookieHeader.split(";").forEach((cookie) => {
    const [name, value] = cookie.trim().split("=");
    if (name && value) {
      cookies[name] = decodeURIComponent(value);
    }
  });
  return cookies;
}

function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode.apply(null, Array.from(array)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(
    String.fromCharCode.apply(null, Array.from(new Uint8Array(digest)))
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function encrypt(text: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv },
    key,
    data
  );
  const combined = new Uint8Array(
    salt.length + iv.length + encrypted.byteLength
  );
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(encrypted), salt.length + iv.length);

  return btoa(String.fromCharCode.apply(null, Array.from(combined)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function decrypt(encrypted: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const combined = new Uint8Array(
    atob(encrypted.replace(/-/g, "+").replace(/_/g, "/"))
      .split("")
      .map((c) => c.charCodeAt(0))
  );

  const salt = combined.slice(0, 16);
  const iv = combined.slice(16, 28);
  const data = combined.slice(28);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv },
    key,
    data
  );
  return decoder.decode(decrypted);
}

export interface ResourceUserContext<T = { [key: string]: any }>
  extends ExecutionContext {
  user: XUser | undefined;
  scopes: string[];
  accessToken: string | undefined;
  hasScope: (requiredScope: string) => boolean;
}

interface ResourceUserFetchHandler<
  TEnv = {},
  TMetadata = { [key: string]: any }
> {
  (request: Request, env: Env & TEnv, ctx: ResourceUserContext<TMetadata>):
    | Response
    | Promise<Response>;
}

export function withResourceAuth<TEnv = {}, TMetadata = { [key: string]: any }>(
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
    const oauth = await handleResourceOAuth(request, env, ctx);
    if (oauth) return oauth;

    let user: XUser | undefined = undefined;
    let scopes: string[] = [];
    const accessToken = getAccessToken(request);

    if (accessToken && accessToken.startsWith("resource_")) {
      try {
        const encryptedData = accessToken.substring(9);
        const decryptedData = await decrypt(
          encryptedData,
          env.ENCRYPTION_SECRET
        );
        const [userId, resource, scopesJson] = decryptedData.split(";");
        scopes = JSON.parse(scopesJson);

        const userDO = env.UserDO.get(
          env.UserDO.idFromName(`${USER_DO_PREFIX}${userId}`)
        );
        const loginData = await userDO.getResourceLogin(accessToken);

        if (loginData) {
          user = loginData.user;
          scopes = loginData.scopes;
        }
      } catch (error) {
        // Invalid token
      }
    }

    const hasScope = (requiredScope: string) => {
      // Check exact match or wildcard match
      if (scopes.includes(requiredScope)) return true;

      // Check if user has broader scope (e.g., "write" includes "write:specific")
      if (requiredScope.includes(":")) {
        const [action] = requiredScope.split(":");
        return scopes.includes(action);
      }

      return false;
    };

    if (config?.isLoginRequired && !user) {
      const url = new URL(request.url);
      const loginUrl = `${
        url.origin
      }/authorize?redirect_uri=${encodeURIComponent(request.url)}&client_id=${
        env.SELF_CLIENT_ID
      }`;

      return new Response("Authentication required: " + loginUrl, {
        status: 401,
        headers: { Location: loginUrl },
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
    const newHeaders = new Headers(response.headers);

    // Add CORS headers
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
