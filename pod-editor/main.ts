// @ts-check
/// <reference types="@cloudflare/workers-types" />
/// <reference lib="esnext" />

/**
 * XYText Client - A collaborative text editor that uses Agent Pod as backend
 * All API calls happen directly from the browser to Agent Pod server
 */
//@ts-ignore
import landingHtml from "./public/landing.html";
//@ts-ignore
import editorHtml from "./public/editor.html";

interface Env {
  KV: KVNamespace;
  ENVIRONMENT: string;
  AGENT_POD_SERVER: string;
}

// PKCE Helper functions
async function generateRandomString(length: number): Promise<string> {
  const randomBytes = new Uint8Array(length);
  crypto.getRandomValues(randomBytes);
  return Array.from(randomBytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function generateCodeVerifier(): Promise<string> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode.apply(null, Array.from(array)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function generateCodeChallenge(codeVerifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isLocalhost = env.ENVIRONMENT === "development";
    const agentPodServer =
      env.AGENT_POD_SERVER || "https://server.agent-pod.com";
    const clientId = url.hostname;

    // Get access token from cookie
    const accessToken = request.headers
      .get("Cookie")
      ?.split(";")
      .find((c) => c.trim().startsWith("agent_pod_token="))
      ?.split("=")[1];

    // Handle logout
    if (url.pathname === "/logout") {
      const redirectTo = url.searchParams.get("redirect_to") || "/";
      const securePart = isLocalhost ? "" : " Secure;";
      return new Response(null, {
        status: 302,
        headers: {
          Location: redirectTo,
          "Set-Cookie": `agent_pod_token=; HttpOnly;${securePart} SameSite=Lax; Max-Age=0; Path=/`,
        },
      });
    }

    // Handle OAuth login
    if (url.pathname === "/login") {
      const state = await generateRandomString(16);
      const codeVerifier = await generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);

      await env.KV.put(`oauth_state:${state}`, codeVerifier, {
        expirationTtl: 600,
      });

      const redirectUri = `${url.origin}/callback`;
      const authUrl = new URL(`${agentPodServer}/authorize`);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("scope", "read write");
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("resource", agentPodServer);

      return new Response(null, {
        status: 302,
        headers: { Location: authUrl.toString() },
      });
    }

    // Handle OAuth callback
    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        return new Response(`Authorization failed: ${error}`, { status: 400 });
      }

      if (!code || !state) {
        return new Response("Missing authorization code or state", {
          status: 400,
        });
      }

      const codeVerifier = await env.KV.get(`oauth_state:${state}`);
      if (!codeVerifier) {
        return new Response("Invalid or expired state", { status: 400 });
      }

      await env.KV.delete(`oauth_state:${state}`);

      const tokenResponse = await fetch(`${agentPodServer}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: `${url.origin}/callback`,
          code_verifier: codeVerifier,
          resource: agentPodServer,
        }),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        return new Response(`Token exchange failed: ${errorText}`, {
          status: 400,
        });
      }

      const tokenData = await tokenResponse.json<{ access_token: string }>();
      const securePart = isLocalhost ? "" : " Secure;";

      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          "Set-Cookie": `agent_pod_token=${encodeURIComponent(tokenData.access_token)}; HttpOnly; Path=/;${securePart} SameSite=Lax; Max-Age=34560000`,
        },
      });
    }

    // Handle root path - landing or redirect
    if (url.pathname === "/") {
      if (!accessToken) {
        return new Response(landingHtml, {
          headers: { "content-type": "text/html;charset=utf8" },
        });
      }

      // Get user info to redirect
      const meResponse = await fetch(`${agentPodServer}/me`, {
        headers: { Authorization: `Bearer ${decodeURIComponent(accessToken)}` },
      });

      if (!meResponse.ok) {
        const securePart = isLocalhost ? "" : " Secure;";
        return new Response(landingHtml, {
          headers: {
            "content-type": "text/html;charset=utf8",
            "Set-Cookie": `agent_pod_token=; HttpOnly;${securePart} SameSite=Lax; Max-Age=0; Path=/`,
          },
        });
      }

      const user = await meResponse.json<{ username: string }>();
      return new Response(null, {
        status: 302,
        headers: { Location: `/${user.username}` },
      });
    }

    // For all other paths, return the editor HTML
    // The frontend will handle fetching data directly from Agent Pod
    if (request.headers.get("accept")?.includes("text/html")) {
      const pathSegments = url.pathname.split("/").filter((p) => p);
      const firstSegment = pathSegments[0] || "";
      const fileName = pathSegments[pathSegments.length - 1] || firstSegment;

      // Inject configuration into HTML
      const html = editorHtml
        .replace("{{AGENT_POD_SERVER}}", agentPodServer)
        .replace(
          "{{ACCESS_TOKEN}}",
          accessToken ? decodeURIComponent(accessToken) : "",
        )
        .replace("{{CURRENT_PATH}}", url.pathname)
        .replace("{{FILE_NAME}}", fileName)
        .replace("{{FIRST_SEGMENT}}", firstSegment);

      return new Response(html, {
        headers: { "content-type": "text/html;charset=utf8" },
      });
    }

    // For non-HTML requests, proxy to Agent Pod
    const headers: Record<string, string> = {};
    if (accessToken) {
      headers.Authorization = `Bearer ${decodeURIComponent(accessToken)}`;
    }

    return fetch(`${agentPodServer}${url.pathname}${url.search}`, {
      method: request.method,
      headers: {
        ...headers,
        "Content-Type": request.headers.get("Content-Type") || "text/plain",
      },
      body:
        request.method !== "GET" && request.method !== "HEAD"
          ? await request.text()
          : undefined,
    });
  },
};
