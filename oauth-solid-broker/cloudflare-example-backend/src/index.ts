import { Hono } from "hono";

type Env = {};

const app = new Hono<{ Bindings: Env }>();

// This backend expects that a trusted gateway (like the OAuth server) forwards
// requests after validating the access token, attaching user props via headers.
// If called directly without those, we reject the request with 401.

app.get("/api/whoami", async (c) => {
  const header = c.req.header("x-auth-props");
  if (!header) {
    return c.text("Unauthorized", 401);
  }
  try {
    const props = JSON.parse(header);
    return c.json({ ok: true, via: "backend", props });
  } catch {
    return c.text("Unauthorized", 401);
  }
});

export default app;

