// @ts-check
/// <reference types="@cloudflare/workers-types" />
/// <reference lib="esnext" />

import {
  Queryable,
  QueryableHandler,
  studioMiddleware,
} from "queryable-object";
import { DurableObject } from "cloudflare:workers";
import { UserDO, withResourceAuth } from "./fs-oauth-provider";
export { UserDO };

const DO_NAME_SUFFIX = ":v1";

interface Env {
  TEXT: DurableObjectNamespace<TextDO & QueryableHandler>;
  KV: KVNamespace;
  ENVIRONMENT: string;
  PORT?: string;
}

interface Session {
  webSocket: WebSocket;
  path: string;
  username: string;
  name: string;
  profile_image_url: string;
}

interface WSMessage {
  type: string;
  text?: string;
  version?: number;
  sessionId?: string;
  sessionCount?: number;
  username?: string;
  fromSession?: string;
  path?: string;
  sessions?: Session[];
  files?: FileNode[];
  line?: number;
  column?: number;
}

interface FileNode extends Record<string, any> {
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

// Helper function to add CORS headers to any response
function addCorsHeaders(response: Response): Response {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-username, x-api-key",
    "Access-Control-Max-Age": "0", // 24 hours
  };

  const headers = new Headers(response.headers);

  Object.entries(corsHeaders).forEach(([key, value]) => {
    headers.set(key, value);
  });
  ``;
  const newResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });

  return newResponse;
}

@Queryable()
export class TextDO extends DurableObject {
  private sessions: Map<string, Session> = new Map();
  private version: number = 0;
  public sql: SqlStorage;
  public env: Env;

  constructor(private state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    this.env = env;
    this.initSQLite();
  }

  async initSQLite(): Promise<void> {
    // Main nodes table for hierarchical file structure (UI state removed)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        parent_path TEXT,
        type TEXT CHECK(type IN ('file', 'folder')) NOT NULL,
        size INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        content TEXT
      )
    `);

    // Indexes for performance
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_parent_path ON nodes(parent_path)`
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_type ON nodes(type)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_name ON nodes(name)`);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_path_type ON nodes(path, type)`
    );
  }

  async fetch(request: Request) {
    // Handle CORS preflight requests first
    if (request.method === "OPTIONS") {
      return addCorsHeaders(new Response(null, { status: 200 }));
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const username = request.headers.get("x-username");

    try {
      // Handle API endpoints
      if (path.startsWith("/api/")) {
        const response = await this.handleAPIRequest(request, url, username);
        return addCorsHeaders(response);
      }

      // Handle llms.txt endpoint
      if (path === "/llms.txt") {
        const llmsTxt = this.generateLlmsTxt(username);
        return addCorsHeaders(
          new Response(llmsTxt, {
            headers: { "Content-Type": "text/plain" },
          })
        );
      }

      // Handle file deletion
      if (request.method === "DELETE") {
        const deleted = this.deleteNode(path);
        if (deleted) {
          this.broadcastFileChange(username, "delete", path);
          return addCorsHeaders(
            new Response(JSON.stringify({ success: true }), {
              headers: { "Content-Type": "application/json" },
            })
          );
        } else {
          return addCorsHeaders(
            new Response(JSON.stringify({ error: "File not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            })
          );
        }
      }

      // Handle file content operations
      if (request.method === "GET") {
        const response = await this.handleFileGet(url, username);
        return addCorsHeaders(response);
      }

      if (request.method === "PUT") {
        const content = await request.text();
        this.saveContent(path, content);
        this.broadcastFileChange(username, "update", path, content);
        return addCorsHeaders(
          new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json" },
          })
        );
      }

      // WebSocket handling - CORS not needed for websockets
      if (request.headers.get("Upgrade") === "websocket") {
        return this.handleWebSocket(request, username, path);
      }

      // Default API info response
      return addCorsHeaders(
        new Response(
          `FS Pod Server API
      
Endpoints:

- Files: GET/PUT/DELETE /{path}"
- API: POST /api/{endpoint}
- websocket: "WS /{path}
- llms: "GET /llms.txt
- admin: /studio
- SQL api: /query
      `,
          {
            headers: { "Content-Type": "text/plain" },
          }
        )
      );
    } catch (error) {
      console.error("Error in TextDO fetch:", error);
      return addCorsHeaders(
        new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
  }

  private parsePathComponents(path: string): {
    name: string;
    parent_path: string | null;
  } {
    if (path === "/") {
      return { name: "/", parent_path: null };
    }

    const parts = path.slice(1).split("/");

    if (parts.length === 1) {
      return { name: parts[0], parent_path: null };
    }

    const name = parts[parts.length - 1];
    const parentParts = parts.slice(0, -1);
    const parent_path = "/" + parentParts.join("/");

    return { name, parent_path };
  }

  saveContent(path: string, content: string): void {
    const now = Math.round(Date.now() / 1000);

    const existing = this.sql
      .exec(`SELECT type FROM nodes WHERE path = ?`, path)
      .toArray()[0] as { type: string } | undefined;

    if (existing && existing.type === "folder") {
      throw new Error("Cannot save content to a folder");
    }

    this.ensureParentFolders(path);
    const { name, parent_path } = this.parsePathComponents(path);

    this.sql.exec(
      `
      INSERT OR REPLACE INTO nodes (path, name, parent_path, type, size, content, created_at, updated_at)
      VALUES (?, ?, ?, 'file', ?, ?, 
        COALESCE((SELECT created_at FROM nodes WHERE path = ?), ?), 
        ?)
    `,
      path,
      name,
      parent_path,
      content.length,
      content,
      path,
      now,
      now
    );
  }

  ensureParentFolders(path: string): void {
    const parts = path.split("/").filter((p) => p);
    let currentPath = "";

    for (let i = 0; i < parts.length - 1; i++) {
      currentPath += "/" + parts[i];

      const existing = this.sql
        .exec(
          `SELECT id FROM nodes WHERE path = ? AND type = 'folder'`,
          currentPath
        )
        .toArray();

      if (existing.length === 0) {
        const { name, parent_path } = this.parsePathComponents(currentPath);
        this.sql.exec(
          `
          INSERT INTO nodes (path, name, parent_path, type, size, content) 
          VALUES (?, ?, ?, 'folder', 0, NULL)
        `,
          currentPath,
          name,
          parent_path
        );
      }
    }
  }

  createFile(path: string, content: string = ""): void {
    const existing = this.sql
      .exec(`SELECT id FROM nodes WHERE path = ?`, path)
      .toArray()[0];
    if (existing) {
      throw new Error("File already exists");
    }
    this.saveContent(path, content);
  }

  createFolder(path: string): void {
    const existing = this.sql
      .exec(`SELECT id FROM nodes WHERE path = ?`, path)
      .toArray()[0];
    if (existing) {
      throw new Error("Folder already exists");
    }

    this.ensureParentFolders(path);
    const { name, parent_path } = this.parsePathComponents(path);

    this.sql.exec(
      `
      INSERT INTO nodes (path, name, parent_path, type, size, content) 
      VALUES (?, ?, ?, 'folder', 0, NULL)
    `,
      path,
      name,
      parent_path
    );
  }

  copyNode(sourcePath: string, targetPath: string): void {
    const sourceNode = this.sql
      .exec(`SELECT * FROM nodes WHERE path = ?`, sourcePath)
      .toArray()[0] as FileNode;

    if (!sourceNode) {
      throw new Error("Source node not found");
    }

    if (sourceNode.type === "file") {
      this.createFile(targetPath, sourceNode.content || "");
    } else {
      this.createFolder(targetPath);
      const children = this.sql
        .exec(`SELECT * FROM nodes WHERE path LIKE ? || '/%'`, sourcePath)
        .toArray() as FileNode[];
      for (const child of children) {
        const relativePath = child.path.slice(sourcePath.length);
        const newChildPath = targetPath + relativePath;
        this.copyNode(child.path, newChildPath);
      }
    }
  }

  moveNode(sourcePath: string, targetPath: string): void {
    const sourceNode = this.sql
      .exec(`SELECT * FROM nodes WHERE path = ?`, sourcePath)
      .toArray()[0] as FileNode;

    if (!sourceNode) {
      throw new Error("Source node not found");
    }

    const existing = this.sql
      .exec(`SELECT id FROM nodes WHERE path = ?`, targetPath)
      .toArray()[0];
    if (existing) {
      throw new Error("Target path already exists");
    }

    const { name, parent_path } = this.parsePathComponents(targetPath);

    this.sql.exec(
      `
      UPDATE nodes SET path = ?, name = ?, parent_path = ?, updated_at = strftime('%s', 'now') WHERE path = ?
    `,
      targetPath,
      name,
      parent_path,
      sourcePath
    );

    if (sourceNode.type === "folder") {
      const children = this.sql
        .exec(`SELECT path FROM nodes WHERE path LIKE ? || '/%'`, sourcePath)
        .toArray() as { path: string }[];

      for (const child of children) {
        const relativePath = child.path.slice(sourcePath.length);
        const newChildPath = targetPath + relativePath;
        const { name: childName, parent_path: childParentPath } =
          this.parsePathComponents(newChildPath);

        this.sql.exec(
          `
          UPDATE nodes SET path = ?, name = ?, parent_path = ?, updated_at = strftime('%s', 'now') WHERE path = ?
        `,
          newChildPath,
          childName,
          childParentPath,
          child.path
        );
      }
    }
  }

  renameNode(oldPath: string, newName: string): void {
    const node = this.sql
      .exec(`SELECT * FROM nodes WHERE path = ?`, oldPath)
      .toArray()[0] as FileNode;

    if (!node) {
      throw new Error("Node not found");
    }

    const pathParts = oldPath.split("/");
    pathParts[pathParts.length - 1] = newName;
    const newPath = pathParts.join("/");

    const existing = this.sql
      .exec(`SELECT id FROM nodes WHERE path = ?`, newPath)
      .toArray()[0];
    if (existing) {
      throw new Error("A file or folder with this name already exists");
    }

    this.moveNode(oldPath, newPath);
  }

  getNextAvailableName(basePath: string, extension: string = ""): string {
    let counter = 1;
    let testPath = basePath;

    while (true) {
      const existing = this.sql
        .exec(`SELECT id FROM nodes WHERE path = ?`, testPath)
        .toArray()[0];

      if (!existing) {
        return testPath;
      }

      if (extension) {
        const baseWithoutExt = basePath.slice(0, -extension.length);
        testPath = `${baseWithoutExt}${counter}${extension}`;
      } else {
        testPath = `${basePath}${counter}`;
      }
      counter++;
    }
  }

  deleteNode(path: string): boolean {
    const result = this.sql.exec(
      `
      DELETE FROM nodes 
      WHERE path = ? OR path LIKE ? || '/%'
    `,
      path,
      path
    );
    return result.rowsWritten > 0;
  }

  getVisibleNodes(expandedPaths: string[], username: string): FileNode[] {
    // Always include root level nodes
    let visibleCondition = `parent_path IS NULL OR parent_path = '/${username}'`;
    let params = [`/${username}/%`, `/${username}`];

    // Add children of expanded folders
    if (expandedPaths.length > 0) {
      const expandedPlaceholders = expandedPaths.map(() => "?").join(",");
      visibleCondition += ` OR parent_path IN (${expandedPlaceholders})`;
      params.push(...expandedPaths);
    }

    const query = `
      SELECT id, path, name, parent_path, type, size, created_at, updated_at, content
      FROM nodes 
      WHERE (path LIKE ? OR path = ?) AND (${visibleCondition})
      ORDER BY parent_path, type DESC, name ASC
    `;

    const nodes = this.sql.exec<FileNode>(query, ...params).toArray();
    return nodes;
  }

  generateLlmsTxt(username: string): string {
    const files = this.sql
      .exec(
        `
      SELECT path, content, created_at, updated_at FROM nodes 
      WHERE path LIKE ? AND type = 'file'
    `,
        `/${username}/%`
      )
      .toArray() as FileNode[];

    const baseUrl = `https://${
      this.env.ENVIRONMENT === "development" ? "localhost:3000" : "xytext.com"
    }`;
    let llmsTxt = `# ${username}'s Files\n\n`;
    llmsTxt += `This document lists all available files for ${username}.\n\n`;

    files.forEach((file) => {
      llmsTxt += `${baseUrl}${file.path}\n`;
    });

    if (files.length === 0) {
      llmsTxt += `No files available for ${username}.\n`;
    }

    return llmsTxt;
  }

  handleFileGet(url: URL, username: string): Response {
    const path = url.pathname;

    if (path === "/") {
      // Return file listing for root
      const files = this.sql
        .exec(
          `
        SELECT path, created_at, updated_at, type, size FROM nodes 
        WHERE path LIKE ? 
        ORDER BY type DESC, path ASC
      `,
          `/${username}/%`
        )
        .toArray();

      return new Response(
        JSON.stringify({
          username: username,
          files: files,
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Get specific file
    const nodeResult = this.sql
      .exec(
        `
      SELECT content, type, created_at, updated_at, size FROM nodes WHERE path = ?
    `,
        path
      )
      .toArray()[0] as
      | {
          content: string;
          type: string;
          created_at: number;
          updated_at: number;
          size: number;
        }
      | undefined;

    if (!nodeResult) {
      return new Response(JSON.stringify({ error: "File not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (nodeResult.type === "folder") {
      // Return folder contents
      const children = this.sql
        .exec(
          `
        SELECT path, name, type, size, created_at, updated_at FROM nodes 
        WHERE parent_path = ? 
        ORDER BY type DESC, name ASC
      `,
          path
        )
        .toArray();

      return new Response(
        JSON.stringify({
          path: path,
          type: "folder",
          children: children,
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Return file content and metadata
    return new Response(
      JSON.stringify({
        path: path,
        type: "file",
        content: nodeResult.content || "",
        size: nodeResult.size,
        created_at: nodeResult.created_at,
        updated_at: nodeResult.updated_at,
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  async handleAPIRequest(
    request: Request,
    url: URL,
    username: string
  ): Promise<Response> {
    const pathSegments = url.pathname.split("/").filter((p) => p);
    const apiEndpoint = pathSegments[1]; // /api/{endpoint}

    let requestData: any = {};
    if (request.method === "POST") {
      try {
        requestData = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (apiEndpoint === "visible-nodes" && request.method === "POST") {
      const { expandedPaths = [] } = requestData;
      const visibleNodes = this.getVisibleNodes(expandedPaths, username);
      return new Response(JSON.stringify({ nodes: visibleNodes }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (apiEndpoint === "create-file" && request.method === "POST") {
      const { path, content = "" } = requestData;
      try {
        this.createFile(path, content);
        this.broadcastFileChange(username, "create", path, content);
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    if (apiEndpoint === "create-folder" && request.method === "POST") {
      const { path } = requestData;
      try {
        this.createFolder(path);
        this.broadcastFileChange(username, "create", path);
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    if (apiEndpoint === "copy-node" && request.method === "POST") {
      const { sourcePath, targetPath } = requestData;
      try {
        this.copyNode(sourcePath, targetPath);
        this.broadcastFileChange(username, "copy", targetPath);
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    if (apiEndpoint === "move-node" && request.method === "POST") {
      const { sourcePath, targetPath } = requestData;
      try {
        this.moveNode(sourcePath, targetPath);
        this.broadcastFileChange(
          username,
          "move",
          targetPath,
          undefined,
          sourcePath
        );
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    if (apiEndpoint === "rename-node" && request.method === "POST") {
      const { path, newName } = requestData;
      try {
        this.renameNode(path, newName);
        const pathParts = path.split("/");
        pathParts[pathParts.length - 1] = newName;
        const newPath = pathParts.join("/");
        this.broadcastFileChange(username, "rename", newPath, undefined, path);
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    if (apiEndpoint === "delete-node" && request.method === "POST") {
      const { path } = requestData;
      const deleted = this.deleteNode(path);
      if (deleted) {
        this.broadcastFileChange(username, "delete", path);
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } else {
        return new Response(JSON.stringify({ error: "Node not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (apiEndpoint === "get-next-name" && request.method === "POST") {
      const { basePath, extension } = requestData;
      const nextName = this.getNextAvailableName(basePath, extension);
      return new Response(JSON.stringify({ nextName }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "API endpoint not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  handleWebSocket(request: Request, username: string, path: string): Response {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    server.accept();
    const sessionId = crypto.randomUUID();

    // Get current file content
    let textContent = "";
    const nodeResult = this.sql
      .exec(
        `
      SELECT content, type FROM nodes WHERE path = ?
    `,
        path
      )
      .toArray()[0] as
      | {
          content: string;
          type: string;
        }
      | undefined;

    if (nodeResult && nodeResult.type === "file") {
      textContent = nodeResult.content || "";
    }

    this.sessions.set(sessionId, {
      path,
      webSocket: server,
      username,
      name: username,
      profile_image_url: "",
    });

    const sessions = Array.from(this.sessions.values());

    this.broadcast(sessionId, {
      type: "join",
      sessionId,
      username,
      path,
      sessionCount: this.sessions.size,
      sessions,
    });

    server.addEventListener("close", () => {
      this.sessions.delete(sessionId);

      const sessions = Array.from(this.sessions.values());
      this.broadcast(sessionId, {
        type: "leave",
        sessionId,
        username,
        path,
        sessions,
        sessionCount: this.sessions.size,
      });
    });

    server.send(
      JSON.stringify({
        type: "init",
        text: textContent,
        version: this.version,
        sessionId,
        sessionCount: this.sessions.size,
        sessions,
        username,
      })
    );

    server.addEventListener("message", async (msg: MessageEvent) => {
      try {
        const data = JSON.parse(msg.data as string) as WSMessage;
        if (
          data.type === "text" &&
          data.text !== undefined &&
          data.version !== undefined
        ) {
          this.version = data.version;
          try {
            this.saveContent(path, data.text);
            this.broadcastFileChange(username, "update", path, data.text);
          } catch (error) {
            server.send(
              JSON.stringify({
                type: "error",
                message: "Cannot edit folder content",
              })
            );
            return;
          }
          this.broadcast(
            sessionId,
            {
              type: "text",
              text: data.text,
              version: data.version,
              fromSession: sessionId,
              line: data.line,
              column: data.column,
            },
            path
          );
        }
      } catch (err) {
        console.error("WebSocket Error:", err);
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(senderSessionId: string, message: WSMessage, path?: string): void {
    const messageStr = JSON.stringify(message);
    for (const [sessionId, session] of this.sessions.entries()) {
      if (sessionId !== senderSessionId) {
        if (!path || (path && session.path === path)) {
          try {
            session.webSocket.send(messageStr);
          } catch (err) {
            this.sessions.delete(sessionId);
          }
        }
      }
    }
  }

  broadcastFileChange(
    username: string,
    action: "create" | "update" | "delete" | "move" | "rename" | "copy",
    path: string,
    content?: string,
    oldPath?: string
  ): void {
    const message: WSMessage = {
      type: "file_change",
      path,
      ...(content !== undefined && { text: content }),
      ...(oldPath && { fromSession: oldPath }),
    };

    // Add action-specific data
    (message as any).action = action;

    const messageStr = JSON.stringify(message);
    for (const [sessionId, session] of this.sessions.entries()) {
      try {
        session.webSocket.send(messageStr);
      } catch (err) {
        this.sessions.delete(sessionId);
      }
    }
  }
}

export default {
  fetch: withResourceAuth(
    async (request: Request, env: Env, ctx) => {
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

      const url = new URL(request.url);
      const path = url.pathname;

      // Apply permissions checks
      if (request.method === "GET") {
        const requiredScope = path === "/" ? "read:" : `read:${path.slice(1)}`;
        if (!ctx.hasScope(requiredScope)) {
          return addCorsHeaders(
            new Response("Insufficient permissions", { status: 403 })
          );
        }
      } else if (request.method === "PUT") {
        const requiredScope = `write:${path.slice(1)}`;
        if (!ctx.hasScope(requiredScope)) {
          return addCorsHeaders(
            new Response("Insufficient permissions", { status: 403 })
          );
        }
      } else if (request.method === "POST" && path.startsWith("/api/append")) {
        const targetPath = url.searchParams.get("path");
        const requiredScope = `append:${targetPath?.slice(1)}`;
        if (!ctx.hasScope(requiredScope)) {
          return addCorsHeaders(
            new Response("Insufficient permissions", { status: 403 })
          );
        }
      }

      const stub = env.TEXT.get(
        env.TEXT.idFromName(ctx.user.id + DO_NAME_SUFFIX)
      );

      // Handle studio endpoint
      if (url.pathname === "/studio") {
        const response = await studioMiddleware(request, stub.raw, {
          dangerouslyDisableAuth: true,
        });
        return addCorsHeaders(response);
      }

      // Handle exec endpoint
      if (url.pathname === "/exec") {
        const query = url.searchParams.get("query");
        const bindings = url.searchParams.getAll("binding");
        const result = await stub.exec(query, ...bindings);
        return addCorsHeaders(
          new Response(JSON.stringify(result, undefined, 2), {
            headers: { "Content-Type": "application/json" },
          })
        );
      }

      // Add username to request headers for the DO
      const newRequest = new Request(request, {
        headers: {
          ...Object.fromEntries(request.headers.entries()),
          "x-username": ctx.user.username,
        },
      });

      try {
        const response = await stub.fetch(newRequest);
        return addCorsHeaders(response);
      } catch (error) {
        console.error("Error calling Durable Object:", error);
        return addCorsHeaders(
          new Response(JSON.stringify({ error: "Internal server error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
    },
    { isLoginRequired: true }
  ),
};
