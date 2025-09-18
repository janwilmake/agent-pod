import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import type { FC } from "hono/jsx";

interface Env {
  FOOBAR_USERS: KVNamespace;
  BROKER_URL?: string;
  OAUTH_ADMIN_URL?: string;
  CSS_PROVISION_URL?: string;
  CSS_BASE_URL?: string;
}

interface StoredUser {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

type ExternalLinks = {
  oauth?: { userId: string };
  css?: { podUrl: string; webId: string };
};

type StoredUserRecord = StoredUser & {
  passwordHash: string;
  external?: ExternalLinks;
};

type ProvisionService = "oauth" | "css";

type ProvisionStatus = "created" | "skipped" | "failed";

interface ProvisionOutcome {
  service: ProvisionService;
  status: ProvisionStatus;
  detail: string;
  data?: Record<string, unknown>;
}

const HTML_HEADERS = { "content-type": "text/html; charset=UTF-8" } as const;

const app = new Hono<{ Bindings: Env }>();

const Layout = jsxRenderer(
  ({ children, title }) => (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title ?? "Foobar"}</title>
        <link rel="icon" href="data:," />
        <script defer src="https://unpkg.com/htmx.org@1.9.12" />
        <style>{`
          :root { color-scheme: light dark; }
          body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 0 1rem 4rem; background: #f7f7fb; color: #1c1c28; }
          header { max-width: 720px; margin: 0 auto; padding: 2.5rem 0 2rem; }
          main { max-width: 720px; margin: 0 auto; }
          h1 { font-size: clamp(2rem, 3vw, 2.75rem); margin: 0; }
          p { line-height: 1.5; }
          .card { background: #ffffff; border-radius: 16px; padding: 1.75rem; box-shadow: 0 1.25rem 2.5rem -2.5rem rgba(15, 23, 42, 0.65); margin-bottom: 1.5rem; }
          form { display: grid; gap: 1rem; }
          label { display: grid; gap: .5rem; font-weight: 600; }
          input { border-radius: 8px; border: 1px solid rgba(15, 23, 42, 0.12); padding: .75rem 1rem; font-size: 1rem; }
          button { appearance: none; border: none; border-radius: 999px; background: linear-gradient(135deg, #5748ff, #8b5cf6); color: white; font-weight: 600; font-size: 1rem; padding: .85rem 1.75rem; cursor: pointer; justify-self: start; box-shadow: 0 8px 20px -12px rgba(87, 72, 255, 0.9); transition: transform .15s ease, box-shadow .2s ease; }
          button:hover { transform: translateY(-1px); box-shadow: 0 12px 24px -14px rgba(87, 72, 255, 0.9); }
          .mute { color: rgba(28, 28, 40, 0.6); }
          .notice { border-radius: 12px; padding: .85rem 1rem; margin-bottom: 1rem; }
          .notice.success { background: rgba(69, 206, 162, 0.18); color: #166a47; }
          .notice.error { background: rgba(244, 63, 94, 0.18); color: #991b3b; }
          .notice ul { margin: .75rem 0 0; padding-left: 1.25rem; }
          .notice li { margin: .25rem 0; }
          ul.users { list-style: none; padding: 0; margin: 0; display: grid; gap: .75rem; }
          ul.users li { padding: .85rem 1rem; border-radius: 12px; background: rgba(87, 72, 255, 0.07); border: 1px solid rgba(87, 72, 255, 0.12); }
          ul.users small { display: block; margin-top: .25rem; color: rgba(28, 28, 40, 0.55); font-size: .85rem; }
          @media (prefers-color-scheme: dark) {
            body { background: #0f172a; color: #f8fafc; }
            .card { background: rgba(15, 23, 42, 0.85); box-shadow: 0 1.5rem 3rem -2.5rem rgba(15, 23, 42, 1); }
            input { background: rgba(15, 23, 42, 0.6); border-color: rgba(148, 163, 184, 0.25); color: inherit; }
            button { box-shadow: none; }
            ul.users li { background: rgba(87, 72, 255, 0.15); border-color: rgba(87, 72, 255, 0.3); }
            .mute { color: rgba(226, 232, 240, 0.65); }
          }
        `}</style>
      </head>
      <body>
        <header>
          <h1>Foobar Accounts</h1>
          <p class="mute">Create your Foobar identity to sync with Solid and third-party integrations.</p>
        </header>
        <main>{children}</main>
      </body>
    </html>
  ),
  { docType: "<!DOCTYPE html>" }
);

app.use("*", Layout);

const Home: FC<{ users: StoredUser[] }> = ({ users }) => (
  <>
    <SignupCard />
    <section
      id="user-list"
      hxGet="/users"
      hxTrigger="load, userCreated from:body"
      hxTarget="this"
    >
      <UserList users={users} />
    </section>
  </>
);

const SignupCard: FC = () => (
  <section class="card">
    <h2>Create a Foobar account</h2>
    <form hxPost="/api/accounts" hxTarget="#signup-feedback" hxSwap="innerHTML">
      <label>
        Your name
        <input type="text" name="name" autoComplete="name" required placeholder="Jane Doe" />
      </label>
      <label>
        Email
        <input type="email" name="email" autoComplete="email" required placeholder="jane@example.com" />
      </label>
      <label>
        Password
        <input type="password" name="password" autoComplete="new-password" required placeholder="••••••••" />
      </label>
      <button type="submit">Create my Foobar ID</button>
    </form>
    <div id="signup-feedback" aria-live="polite" />
  </section>
);

const UserList: FC<{ users: StoredUser[] }> = ({ users }) => {
  if (!users.length) {
    return (
      <div class="card">
        <p class="mute">No Foobar accounts yet. Be the first to sign up.</p>
      </div>
    );
  }

  return (
    <div class="card">
      <h2>Recently created accounts</h2>
      <ul class="users">
        {users.map((user) => (
          <li key={user.id}>
            <strong>{user.name}</strong>
            <small>
              {user.email} · Joined {new Date(user.createdAt).toLocaleString()}
            </small>
          </li>
        ))}
      </ul>
    </div>
  );
};

const ErrorNotice: FC<{ messages: string[] }> = ({ messages }) => (
  <div class="notice error" role="alert">
    {messages.map((msg, idx) => (
      <div key={idx}>{msg}</div>
    ))}
  </div>
);

const SuccessNotice: FC<{ name: string; outcomes: ProvisionOutcome[] }> = ({ name, outcomes }) => (
  <div class="notice success" role="status">
    <div>Welcome to Foobar, {name}!</div>
    <ul>
      {outcomes.map((outcome) => (
        <li key={outcome.service}>
          <strong>{describeService(outcome.service)}:</strong> {outcome.detail}
        </li>
      ))}
    </ul>
  </div>
);

app.get("/", async (c) => {
  const users = await fetchUsers(c.env);
  return c.render(<Home users={users} />, { title: "Foobar Accounts" });
});

app.get("/users", async (c) => {
  const users = await fetchUsers(c.env);
  c.header("content-type", HTML_HEADERS["content-type"]);
  return c.html(<UserList users={users} />);
});

app.post("/api/accounts", async (c) => {
  const env = c.env;
  const form = await c.req.formData();
  const name = (form.get("name") || "").toString().trim();
  const email = (form.get("email") || "").toString().trim();
  const password = (form.get("password") || "").toString();

  const errors: string[] = [];
  if (!name) errors.push("Please tell us your name.");
  if (!email) {
    errors.push("Email is required.");
  } else {
    const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    if (!emailPattern.test(email)) {
      errors.push("Use a valid email address.");
    }
  }
  if (!password || password.length < 8) {
    errors.push("Password must be at least 8 characters long.");
  }

  const key = `user:${email.toLowerCase()}`;
  const existing = email ? await env.FOOBAR_USERS.get(key) : null;
  if (existing) {
    errors.push("That email is already registered with Foobar.");
  }

  if (errors.length) {
    c.header("content-type", HTML_HEADERS["content-type"]);
    return c.html(<ErrorNotice messages={errors} />, 422);
  }

  const user: StoredUser = {
    id: crypto.randomUUID(),
    name,
    email,
    createdAt: new Date().toISOString(),
  };

  const { outcomes, external, failures } = await provisionExternalSystems(env, user, password);
  if (failures.length) {
    const provisionErrors = failures.map((outcome) => outcome.detail);
    c.header("content-type", HTML_HEADERS["content-type"]);
    return c.html(<ErrorNotice messages={provisionErrors} />, 502);
  }

  const record: StoredUserRecord = {
    ...user,
    passwordHash: await hashPlaceholder(password),
    external: Object.keys(external).length ? external : undefined,
  };
  await env.FOOBAR_USERS.put(key, JSON.stringify(record));

  c.header("HX-Trigger", "userCreated");
  c.header("content-type", HTML_HEADERS["content-type"]);
  return c.html(<SuccessNotice name={name} outcomes={outcomes} />, 201);
});

async function fetchUsers(env: Env): Promise<StoredUser[]> {
  const listing = await env.FOOBAR_USERS.list({ prefix: "user:", limit: 50 });
  const users: StoredUser[] = [];
  for (const key of listing.keys) {
    const item = await env.FOOBAR_USERS.get<StoredUserRecord>(key.name, { type: "json" });
    if (item) {
      users.push({ id: item.id, name: item.name, email: item.email, createdAt: item.createdAt });
    }
  }
  users.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return users;
}

async function hashPlaceholder(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function provisionExternalSystems(env: Env, user: StoredUser, password: string) {
  const outcomes: ProvisionOutcome[] = [];
  const external: ExternalLinks = {};

  const oauthOutcome = await createOAuthAccount(env, user, password);
  outcomes.push(oauthOutcome);
  if (oauthOutcome.status === "created" && oauthOutcome.data?.userId) {
    external.oauth = { userId: String(oauthOutcome.data.userId) };
  }

  const cssOutcome = await createCssPod(env, user, external);
  outcomes.push(cssOutcome);
  if (cssOutcome.status === "created" && cssOutcome.data?.podUrl) {
    external.css = {
      podUrl: String(cssOutcome.data.podUrl),
      webId: String(cssOutcome.data.webId ?? buildWebId(env, user.id)),
    };
  }

  const failures = outcomes.filter((outcome) => outcome.status === "failed");
  return { outcomes, external, failures };
}

function buildWebId(env: Env, userId: string): string {
  const base = env.BROKER_URL ?? "http://localhost:8789";
  return `${base.replace(/\/$/, "")}/webid/${encodeURIComponent(userId)}#me`;
}

async function createOAuthAccount(env: Env, user: StoredUser, password: string): Promise<ProvisionOutcome> {
  if (!env.OAUTH_ADMIN_URL) {
    return {
      service: "oauth",
      status: "skipped",
      detail: "Skipped OAuth provisioning (OAUTH_ADMIN_URL not configured).",
    };
  }

  try {
    const url = joinUrl(env.OAUTH_ADMIN_URL, "/users");
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: user.id,
        name: user.name,
        email: user.email,
        password,
      }),
    });
    const body = await safeJson(response);

    if (!response.ok) {
      const message = body?.error_description || body?.error || response.statusText;
      return {
        service: "oauth",
        status: "failed",
        detail: `OAuth server rejected provisioning (${response.status}): ${message}`,
        data: body ?? undefined,
      };
    }

    return {
      service: "oauth",
      status: "created",
      detail: `OAuth account ready (user ID ${body?.user?.id ?? user.id}).`,
      data: { userId: body?.user?.id ?? user.id },
    };
  } catch (error) {
    return {
      service: "oauth",
      status: "failed",
      detail: `Failed to reach OAuth server: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function createCssPod(env: Env, user: StoredUser, links: ExternalLinks): Promise<ProvisionOutcome> {
  if (!env.CSS_PROVISION_URL) {
    return {
      service: "css",
      status: "skipped",
      detail: "Skipped CSS provisioning (CSS_PROVISION_URL not configured).",
    };
  }

  try {
    const url = env.CSS_PROVISION_URL;
    const webId = buildWebId(env, user.id);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: user.id,
        webId,
        name: user.name,
        email: user.email,
        oauthUserId: links.oauth?.userId ?? user.id,
      }),
    });
    const body = await safeJson(response);

    if (!response.ok) {
      const message = body?.error_description || body?.error || response.statusText;
      return {
        service: "css",
        status: "failed",
        detail: `CSS pod provisioning failed (${response.status}): ${message}`,
        data: body ?? undefined,
      };
    }

    const podUrl = body?.podUrl ?? body?.pod_url ?? body?.location ?? env.CSS_BASE_URL ?? env.CSS_PROVISION_URL;
    return {
      service: "css",
      status: "created",
      detail: body?.message ?? "Solid pod created.",
      data: {
        podUrl,
        webId,
      },
    };
  } catch (error) {
    return {
      service: "css",
      status: "failed",
      detail: `Failed to reach CSS admin API: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function safeJson(response: Response): Promise<Record<string, any> | null> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text } as Record<string, any>;
  }
}

function joinUrl(base: string, path: string): string {
  const normalized = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${normalized}${path}`;
}

function describeService(service: ProvisionService): string {
  switch (service) {
    case "oauth":
      return "OAuth Server";
    case "css":
      return "Community Solid Server";
    default:
      return service;
  }
}

export default app;
