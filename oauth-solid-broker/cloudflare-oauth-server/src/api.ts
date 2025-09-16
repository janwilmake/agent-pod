import { Hono } from "hono";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env, OAuthExecutionContext } from "./types";

export class ApiHandler extends WorkerEntrypoint<Env> {
  private app = new Hono<{ Bindings: Env }>();

  constructor(ctx: unknown, env: unknown) {
    super(ctx as any, env as any);
    this.registerRoutes();
  }

  private registerRoutes() {
    this.app.get("/api/whoami", async (c) => {
      const props = (c.executionCtx as OAuthExecutionContext)?.props ?? {};
      return c.json({ ok: true, props });
    });
  }

  async fetch(request: Request): Promise<Response> {
    // If a backend service binding is configured, forward the request to it
    // after token validation, attaching the auth props as a header.
    const backend = (this.env as Env).API_BACKEND;
    if (backend) {
      const props = (this.ctx as OAuthExecutionContext)?.props ?? {};
      const headers = new Headers(request.headers);
      headers.set("x-auth-props", JSON.stringify(props));
      // Optionally signal to backend this request came through the gateway
      headers.set("x-authenticated", "true");
      const forwarded = new Request(request, { headers });
      return backend.fetch(forwarded);
    }

    // Fallback to local Hono API implementation
    return this.app.fetch(request, this.env, this.ctx);
  }
}
