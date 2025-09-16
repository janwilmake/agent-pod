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
    return this.app.fetch(request, this.env, this.ctx);
  }
}

