/// <reference types="@cloudflare/workers-types" />
/// <reference lib="esnext" />

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
  TEXT: DurableObjectNamespace<any>; // Reference to TextDO for file system access
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

interface FileNode {
  id: number;
  path: string;
  name: string;
  parent_path: string | null;
  type: "file" | "folder";
  size: number;
  created_at: number;
  updated_at: number;
  content?: string;
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

  async getUserFiles(userId: string): Promise<FileNode[]> {
    if (!this.env.TEXT) return [];

    try {
      const textDO = this.env.TEXT.get(
        this.env.TEXT.idFromName(`${userId}:v1`)
      );

      // Get all files for this user
      const response = await textDO.fetch(
        new Request("http://localhost/", {
          headers: { "x-username": userId },
        })
      );

      if (!response.ok) return [];

      const data = (await response.json()) as { files?: FileNode[] };
      return data.files || [];
    } catch (error) {
      console.error("Error fetching user files:", error);
      return [];
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

  if (path === "/callback") {
    return handleCallback(request, env, ctx);
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

  // Check if user is already authenticated with X provider by calling /me
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const xAccessToken = cookies.x_access_token;

  if (xAccessToken) {
    try {
      const userResponse = await fetch(`${env.X_OAUTH_PROVIDER_URL}/me`, {
        headers: { Authorization: `Bearer ${xAccessToken}` },
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
          resource,
          env,
          ctx
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

  // Get state from cookie
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

  // Show consent page for the resource scopes
  const secureFlag = isLocalhost(request) ? "" : " Secure;";
  const consentPageResponse = await showConsentPage(
    user,
    oauthState.clientId,
    oauthState.redirectUri,
    oauthState.state,
    oauthState.scopes,
    oauthState.resource,
    env,
    ctx
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

async function showConsentPage(
  user: XUser,
  clientId: string,
  redirectUri: string,
  state: string | null,
  scopes: string[],
  resource: string | null,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  // Get user's files for the file selector
  const userDO = env.UserDO.get(
    env.UserDO.idFromName(`${USER_DO_PREFIX}${user.id}`)
  );
  const userFiles = await userDO.getUserFiles(user.username);

  // Separate variable scopes from specific scopes
  const variableScopes: string[] = [];
  const specificScopes: {
    scope: string;
    exists: boolean;
    action: string;
    resource: string;
  }[] = [];

  for (const scope of scopes) {
    if (scope.includes(":{resource}") || scope.includes(":{*}")) {
      // Extract the action part (read, write, append)
      const action = scope.split(":")[0];
      if (!variableScopes.includes(action)) {
        variableScopes.push(action);
      }
    } else if (scope.includes(":")) {
      const [action, res] = scope.split(":", 2);
      const fullPath = `/${user.username}/${res}`;
      const exists = userFiles.some((file) => file.path === fullPath);
      specificScopes.push({ scope, exists, action, resource: res });
    } else {
      // Plain scope like "read", "write", "append"
      specificScopes.push({
        scope,
        exists: true,
        action: scope,
        resource: "all files",
      });
    }
  }

  const hasVariableScopes = variableScopes.length > 0;
  const hasSpecificScopes = specificScopes.length > 0;

  const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Authorize ${clientId}</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
</head>
<body class="bg-gray-50 min-h-screen py-8">
    <div class="max-w-2xl mx-auto">
        <div class="bg-white rounded-xl shadow-lg overflow-hidden">
            <!-- Header -->
            <div class="bg-gradient-to-r from-blue-600 to-indigo-700 px-8 py-6">
                <h1 class="text-2xl font-bold text-white">Authorize Application</h1>
                <p class="text-blue-100 mt-1">Grant access to your files</p>
            </div>

            <div class="p-8">
                <!-- User Info -->
                <div class="flex items-center space-x-4 mb-8 p-4 bg-gray-50 rounded-lg">
                    <img src="${
                      user.profile_image_url || "https://via.placeholder.com/48"
                    }" 
                         alt="Avatar" 
                         class="w-12 h-12 rounded-full border-2 border-gray-200">
                    <div>
                        <div class="font-semibold text-gray-900">${
                          user.name
                        }</div>
                        <div class="text-gray-600 flex items-center">
                            <span>@${user.username}</span>
                            ${
                              user.verified
                                ? '<i class="fas fa-check-circle text-blue-500 ml-2"></i>'
                                : ""
                            }
                        </div>
                    </div>
                </div>

                <!-- Client Info -->
                <div class="mb-8 p-4 border-l-4 border-blue-500 bg-blue-50">
                    <p class="text-gray-700">
                        <strong class="text-blue-700">${clientId}</strong> wants to access your files with the following permissions:
                    </p>
                </div>

                <form method="POST" action="/consent" class="space-y-6">
                    <input type="hidden" name="client_id" value="${clientId}">
                    <input type="hidden" name="redirect_uri" value="${redirectUri}">
                    <input type="hidden" name="state" value="${state || ""}">
                    <input type="hidden" name="resource" value="${
                      resource || ""
                    }">
                    <input type="hidden" name="user_id" value="${user.id}">
                    <input type="hidden" name="original_scopes" value="${scopes.join(
                      " "
                    )}">

                    ${
                      hasVariableScopes
                        ? `
                    <!-- Variable Permissions -->
                    <div class="bg-blue-50 rounded-lg p-6">
                        <h3 class="text-lg font-semibold text-gray-900 mb-4">
                            <i class="fas fa-sliders-h text-blue-600 mr-2"></i>
                            Resource Permissions
                        </h3>
                        <p class="text-gray-700 mb-4">The application requests the following permissions:</p>
                        
                        <div class="flex flex-wrap gap-2 mb-6">
                            ${variableScopes
                              .map(
                                (action) => `
                                <span class="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${getPermissionBadgeColor(
                                  action
                                )} text-white">
                                    <i class="${getPermissionIcon(
                                      action
                                    )} mr-1"></i>
                                    ${action.toUpperCase()}
                                </span>
                            `
                              )
                              .join("")}
                        </div>

                        <p class="text-gray-700 mb-4">Select which files or folders these permissions should apply to:</p>
                        
                        <!-- File Selector -->
                        <div class="border border-gray-200 rounded-lg">
                            <div class="bg-gray-50 px-4 py-3 border-b border-gray-200">
                                <div class="flex items-center justify-between">
                                    <span class="font-medium text-gray-900">Your Files & Folders</span>
                                    <div class="flex items-center space-x-3">
                                        <button type="button" onclick="toggleSelectAll()" id="selectAllBtn" class="text-blue-600 hover:text-blue-800 text-sm">
                                            Select All
                                        </button>
                                        <button type="button" onclick="clearSelection()" class="text-gray-600 hover:text-gray-800 text-sm">
                                            Clear All
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <div class="max-h-80 overflow-y-auto">
                                ${generateFileTree(userFiles, user.username)}
                            </div>
                        </div>

                        <div class="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                            <div class="flex items-start">
                                <i class="fas fa-exclamation-triangle text-yellow-600 mt-1 mr-2"></i>
                                <div>
                                    <p class="text-sm text-yellow-800">
                                        <strong>Note:</strong> You must select at least one resource to continue.
                                        You can grant access to existing files/folders or create new ones.
                                    </p>
                                </div>
                            </div>
                        </div>

                        <input type="hidden" name="selected_resources" id="selectedResources" value="">
                    </div>
                    `
                        : ""
                    }

                    ${
                      hasSpecificScopes
                        ? `
                    <!-- Specific Permissions -->
                    <div class="space-y-3">
                        <h3 class="text-lg font-semibold text-gray-900">
                            <i class="fas fa-file-alt text-green-600 mr-2"></i>
                            Specific Permissions
                        </h3>
                        <div class="space-y-3">
                            ${specificScopes
                              .map(
                                (s) => `
                                <div class="flex items-center justify-between p-4 border border-gray-200 rounded-lg">
                                    <div class="flex-1">
                                        <div class="flex items-center space-x-3">
                                            <span class="inline-flex items-center px-2 py-1 rounded text-sm font-medium ${getPermissionBadgeColor(
                                              s.action
                                            )} text-white">
                                                <i class="${getPermissionIcon(
                                                  s.action
                                                )} mr-1"></i>
                                                ${s.action.toUpperCase()}
                                            </span>
                                            <span class="font-medium text-gray-900">${
                                              s.resource
                                            }</span>
                                        </div>
                                        <p class="text-sm text-gray-600 mt-1">${getScopeDescription(
                                          s.action,
                                          s.resource
                                        )}</p>
                                    </div>
                                    <div class="ml-4">
                                        ${
                                          s.exists
                                            ? `<span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                               <i class="fas fa-check mr-1"></i>Exists
                                             </span>`
                                            : `<span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                                               <i class="fas fa-plus mr-1"></i>Will be created
                                             </span>`
                                        }
                                    </div>
                                </div>
                            `
                              )
                              .join("")}
                        </div>
                    </div>
                    `
                        : ""
                    }

                    <!-- Action Buttons -->
                    <div class="flex space-x-4 pt-6 border-t border-gray-200">
                        <button type="submit" 
                                name="action" 
                                value="approve" 
                                ${
                                  hasVariableScopes
                                    ? 'id="approveBtn" disabled'
                                    : ""
                                }
                                class="flex-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-semibold py-3 px-6 rounded-lg transition-colors duration-200 flex items-center justify-center">
                            <i class="fas fa-check mr-2"></i>
                            Authorize
                        </button>
                        <button type="submit" 
                                name="action" 
                                value="deny" 
                                class="flex-1 bg-gray-500 hover:bg-gray-600 text-white font-semibold py-3 px-6 rounded-lg transition-colors duration-200 flex items-center justify-center">
                            <i class="fas fa-times mr-2"></i>
                            Deny
                        </button>
                    </div>
                </form>
            </div>
        </div>
    </div>

    <script>
        let selectedResources = new Set();
        let newResources = new Set();
        
        function toggleResource(checkbox, path) {
            if (checkbox.checked) {
                selectedResources.add(path);
            } else {
                selectedResources.delete(path);
            }
            updateSelectedResources();
            updateApproveButton();
            updateSelectAllButton();
        }
        
        function addNewResource() {
            const input = document.getElementById('newResourcePath');
            const path = input.value.trim();
            
            if (!path) {
                alert('Please enter a resource path');
                return;
            }
            
            // Validate path format
            if (path.startsWith('/') || path.includes('..')) {
                alert('Invalid path format. Use relative paths without leading slashes or parent directory references.');
                return;
            }
            
            if (selectedResources.has(path) || newResources.has(path)) {
                alert('This resource is already selected');
                return;
            }
            
            // Add to selected resources
            selectedResources.add(path);
            newResources.add(path);
            
            // Add to visual list
            const newResourcesList = document.getElementById('newResourcesList');
            const resourceDiv = document.createElement('div');
            resourceDiv.className = 'flex items-center justify-between p-2 bg-green-50 border border-green-200 rounded text-sm';
            resourceDiv.innerHTML = \`
                <div class="flex items-center">
                    <i class="fas fa-plus text-green-600 mr-2"></i>
                    <span class="font-medium text-green-800">\${path}</span>
                    <span class="text-green-600 text-xs ml-2">(new)</span>
                </div>
                <button type="button" onclick="removeNewResource('\${path}', this.parentElement)" class="text-red-600 hover:text-red-800">
                    <i class="fas fa-times"></i>
                </button>
            \`;
            newResourcesList.appendChild(resourceDiv);
            
            // Clear input
            input.value = '';
            
            // Update form state
            updateSelectedResources();
            updateApproveButton();
        }
        
        function removeNewResource(path, element) {
            selectedResources.delete(path);
            newResources.delete(path);
            element.remove();
            updateSelectedResources();
            updateApproveButton();
        }
        
        function toggleSelectAll() {
            const checkboxes = document.querySelectorAll('.resource-checkbox');
            const allSelected = Array.from(checkboxes).every(cb => cb.checked);
            
            checkboxes.forEach(cb => {
                cb.checked = !allSelected;
                const path = cb.getAttribute('data-path');
                if (cb.checked) {
                    selectedResources.add(path);
                } else {
                    selectedResources.delete(path);
                }
            });
            
            updateSelectedResources();
            updateApproveButton();
            updateSelectAllButton();
        }
        
        function clearSelection() {
            // Clear all checkboxes
            const checkboxes = document.querySelectorAll('.resource-checkbox');
            checkboxes.forEach(cb => {
                cb.checked = false;
                const path = cb.getAttribute('data-path');
                selectedResources.delete(path);
            });
            
            // Clear new resources
            const newResourcesList = document.getElementById('newResourcesList');
            newResourcesList.innerHTML = '';
            newResources.clear();
            selectedResources.clear();
            
            updateSelectedResources();
            updateApproveButton();
            updateSelectAllButton();
        }
        
        function updateSelectedResources() {
            document.getElementById('selectedResources').value = JSON.stringify(Array.from(selectedResources));
        }
        
        function updateApproveButton() {
            const approveBtn = document.getElementById('approveBtn');
            if (approveBtn) {
                approveBtn.disabled = ${
                  hasVariableScopes ? "selectedResources.size === 0" : "false"
                };
            }
        }
        
        function updateSelectAllButton() {
            const selectAllBtn = document.getElementById('selectAllBtn');
            const checkboxes = document.querySelectorAll('.resource-checkbox');
            
            if (selectAllBtn && checkboxes.length > 0) {
                const allSelected = Array.from(checkboxes).every(cb => cb.checked);
                selectAllBtn.textContent = allSelected ? 'Deselect All' : 'Select All';
            }
        }
        
        // Handle Enter key in the new resource input
        document.getElementById('newResourcePath').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                addNewResource();
            }
        });
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: { ...getCorsHeaders(), "Content-Type": "text/html" },
  });
}

function generateFileTree(files: FileNode[], username: string): string {
  // Always include root directory option
  let html = `
    <label class="flex items-center p-3 hover:bg-gray-50 cursor-pointer border-b border-gray-100">
      <input type="checkbox" 
             class="resource-checkbox mr-3 text-blue-600" 
             data-path=""
             onchange="toggleResource(this, '')">
      <i class="fas fa-folder text-yellow-500 mr-3"></i>
      <div class="flex-1">
        <span class="text-gray-900 font-semibold">/ (Root Directory)</span>
        <div class="text-xs text-gray-500">
          All files and folders
        </div>
      </div>
    </label>
  `;

  // Add existing files and folders
  const userFiles = files
    .filter((f) => f.path.startsWith(`/${username}/`))
    .sort((a, b) => {
      // Folders first, then files, then alphabetically
      if (a.type !== b.type) {
        return a.type === "folder" ? -1 : 1;
      }
      return a.path.localeCompare(b.path);
    });

  userFiles.forEach((file) => {
    const relativePath = file.path.slice(`/${username}/`.length);
    const isFolder = file.type === "folder";
    const icon = isFolder ? "fas fa-folder" : "fas fa-file";
    const iconColor = isFolder ? "text-yellow-500" : "text-blue-500";

    html += `
      <label class="flex items-center p-3 hover:bg-gray-50 cursor-pointer border-b border-gray-100">
        <input type="checkbox" 
               class="resource-checkbox mr-3 text-blue-600" 
               data-path="${relativePath}"
               onchange="toggleResource(this, '${relativePath}')">
        <i class="${icon} ${iconColor} mr-3"></i>
        <div class="flex-1">
          <span class="text-gray-900">${relativePath}</span>
          <div class="text-xs text-gray-500">
            ${isFolder ? "Folder" : `File • ${file.size} bytes`}
          </div>
        </div>
      </label>
    `;
  });

  // Add section for creating new resources
  html += `
    <div class="bg-gray-50 border-t border-gray-200">
      <div class="p-3">
        <h4 class="text-sm font-semibold text-gray-700 mb-3">
          <i class="fas fa-plus text-green-600 mr-2"></i>
          Grant access to new resources
        </h4>
        
        <div class="space-y-2">
          <div class="flex items-center space-x-2">
            <input type="text" 
                   id="newResourcePath" 
                   placeholder="e.g., documents/notes.txt or projects/"
                   class="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent">
            <button type="button" 
                    onclick="addNewResource()" 
                    class="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500">
              Add
            </button>
          </div>
          <p class="text-xs text-gray-600">
            Add files (with extension) or folders (ending with /) that don't exist yet
          </p>
        </div>
        
        <!-- Dynamic list of added new resources -->
        <div id="newResourcesList" class="mt-3 space-y-1"></div>
      </div>
    </div>
  `;

  if (userFiles.length === 0) {
    html += `
      <div class="p-4 text-center text-gray-500 border-t border-gray-200">
        <i class="fas fa-info-circle text-blue-500 mb-2"></i>
        <p class="text-sm">No existing files found</p>
        <p class="text-xs">You can still grant access to the root directory or add new resources above</p>
      </div>
    `;
  }

  return html;
}

function getPermissionIcon(action: string): string {
  switch (action) {
    case "read":
      return "fas fa-eye";
    case "write":
      return "fas fa-edit";
    case "append":
      return "fas fa-plus";
    default:
      return "fas fa-key";
  }
}

function getPermissionBadgeColor(action: string): string {
  switch (action) {
    case "read":
      return "bg-blue-600";
    case "write":
      return "bg-red-600";
    case "append":
      return "bg-green-600";
    default:
      return "bg-gray-600";
  }
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

  // Parse selected resources for variable scopes
  let selectedResources: string[] = [];
  if (selectedResourcesJson) {
    try {
      selectedResources = JSON.parse(selectedResourcesJson);
    } catch (e) {
      selectedResources = [];
    }
  }

  // Build final scopes list
  const finalScopes: string[] = [];

  for (const scope of originalScopes) {
    if (scope.includes(":{resource}") || scope.includes(":{*}")) {
      // Variable scope - expand to all selected resources
      const action = scope.split(":")[0];
      if (selectedResources.length === 0) {
        // No resources selected, return error
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

      // Add scope for each selected resource
      for (const selectedResource of selectedResources) {
        finalScopes.push(`${action}:${selectedResource}`);
      }
    } else {
      // Specific scope - keep as is
      finalScopes.push(scope);
    }
  }

  // User approved, create auth code
  const authCode = generateCodeVerifier();
  const userDO = env.UserDO.get(
    env.UserDO.idFromName(`${USER_DO_PREFIX}code:${authCode}`)
  );

  await userDO.setAuthData(authCode, {
    userId,
    clientId,
    redirectUri,
    resource,
    scopes: finalScopes, // Use the expanded scopes
  });

  redirectUrl.searchParams.set("code", authCode);
  if (state) redirectUrl.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: { ...getCorsHeaders(), Location: redirectUrl.toString() },
  });
}

function validateScopes(scopes: string[]): boolean {
  const validActions = ["read", "write", "append"];

  for (const scope of scopes) {
    if (!scope.includes(":")) {
      // Plain scope like "read", "write", "append" - valid for all resources
      if (!validActions.includes(scope)) return false;
    } else {
      const [action, resource] = scope.split(":", 2);
      if (!validActions.includes(action)) return false;

      // Allow variable scopes like "read:{resource}"
      if (resource === "{resource}" || resource === "{*}") {
        continue; // Valid variable scope
      }

      // Validate specific resource path
      if (!resource || resource.startsWith("/") || resource.includes(".."))
        return false;
    }
  }

  return true;
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
    const token = authHeader.substring(7);
    return token;
  }

  // Fallback to cookie
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const cookieToken = cookies.access_token || null;
  return cookieToken;
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

function isLocalhost(request: Request): boolean {
  const url = new URL(request.url);
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    request.headers.get("cf-connecting-ip") === "::1" ||
    request.headers.get("cf-connecting-ip") === "127.0.0.1"
  );
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

    // Handle CORS preflight at the top level
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

    const hasScope = (requiredScope: string): boolean => {
      // Check for exact match first
      if (scopes.includes(requiredScope)) return true;

      // Parse the required scope
      const [requiredAction, requiredResource = ""] = requiredScope.split(
        ":",
        2
      );

      // Check each granted scope
      for (const grantedScope of scopes) {
        const [grantedAction, grantedResource = ""] = grantedScope.split(
          ":",
          2
        );

        // Action must match
        if (grantedAction !== requiredAction) continue;

        // If granted scope has no resource specified (e.g., "read:", "write:"),
        // it grants access to everything for that action
        if (grantedResource === "") return true;

        // If required scope has no resource specified, check if we have the plain action
        if (requiredResource === "") {
          if (scopes.includes(requiredAction)) return true;
          continue;
        }

        // Check if granted resource is a parent path of required resource
        // Examples:
        // - granted "read:documents" allows "read:documents/file.txt"
        // - granted "write:" allows "write:any/path"
        // - granted "read:docs/" allows "read:docs/sub/file.txt"

        if (requiredResource.startsWith(grantedResource)) {
          // Exact match or granted resource is empty (root access)
          if (grantedResource === "" || requiredResource === grantedResource) {
            return true;
          }

          // Check if granted resource is a proper parent directory
          // Either it ends with '/' or the next character in required is '/'
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

      // Check if user has the plain action scope (backward compatibility)
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
