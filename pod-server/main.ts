// @ts-check
/// <reference types="@cloudflare/workers-types" />
/// <reference lib="esnext" />

import {
  Queryable,
  QueryableHandler,
  studioMiddleware,
} from "queryable-object";
import { DurableObject } from "cloudflare:workers";
import type { Env, ResourceUserContext } from "./types";
import { oauthClientMiddleware, UserDO } from "./oauth-client";
import {
  oauthProviderMiddleware,
  tokenValidationMiddleware,
} from "./oauth-provider";
export { UserDO };

const DO_NAME_SUFFIX = ":v1";

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

interface GrepResult {
  path: string;
  line: number;
  column: number;
  content: string;
  match: string;
}

interface FindResult {
  path: string;
  name: string;
  type: "file" | "folder";
  size: number;
  created_at: number;
  updated_at: number;
}

// Helper function to add CORS headers to any response
function addCorsHeaders(response: Response): Response {
  if (response.status === 101 && (response as any).webSocket) {
    return response;
  }

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-username, x-api-key",
    "Access-Control-Max-Age": "0",
  };

  const headers = new Headers(response.headers);
  Object.entries(corsHeaders).forEach(([key, value]) => {
    headers.set(key, value);
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

@Queryable()
export class TextDO extends DurableObject {
  private sessions: Map<string, Session> = new Map();
  private version: number = 0;
  public sql: SqlStorage;
  public env: Env;

  constructor(
    private state: DurableObjectState,
    env: Env,
  ) {
    super(state, env);
    this.sql = state.storage.sql;
    this.env = env;
    this.initSQLite();
  }

  async initSQLite(): Promise<void> {
    // Main nodes table for hierarchical file structure
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
      `CREATE INDEX IF NOT EXISTS idx_parent_path ON nodes(parent_path)`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_type ON nodes(type)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_name ON nodes(name)`);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_path_type ON nodes(path, type)`,
    );

    // FTS5 virtual table for full-text search (grep)
    // Note: We recreate if schema changed
    try {
      this.sql.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
          path,
          content,
          content='nodes',
          content_rowid='id'
        )
      `);

      // Triggers to keep FTS in sync
      this.sql.exec(`
        CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
          INSERT INTO nodes_fts(rowid, path, content) VALUES (new.id, new.path, new.content);
        END
      `);

      this.sql.exec(`
        CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
          INSERT INTO nodes_fts(nodes_fts, rowid, path, content) VALUES('delete', old.id, old.path, old.content);
        END
      `);

      this.sql.exec(`
        CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
          INSERT INTO nodes_fts(nodes_fts, rowid, path, content) VALUES('delete', old.id, old.path, old.content);
          INSERT INTO nodes_fts(rowid, path, content) VALUES (new.id, new.path, new.content);
        END
      `);
    } catch (e) {
      // FTS table might already exist with different schema, ignore
      console.log("FTS setup note:", e);
    }
  }

  async fetch(request: Request) {
    if (request.method === "OPTIONS") {
      return addCorsHeaders(new Response(null, { status: 200 }));
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const username = request.headers.get("x-username") || "";

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
          }),
        );
      }

      // Handle file deletion
      if (request.method === "DELETE") {
        const fullPath =
          path === "/" ? path : this.ensureUserPrefix(path, username);
        const deleted = this.deleteNode(fullPath);
        if (deleted) {
          this.broadcastFileChange(username, "delete", fullPath);
          return addCorsHeaders(
            new Response(JSON.stringify({ success: true }), {
              headers: { "Content-Type": "application/json" },
            }),
          );
        } else {
          return addCorsHeaders(
            new Response(JSON.stringify({ error: "File not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
      }

      // WebSocket handling
      if (request.headers.get("Upgrade") === "websocket") {
        return this.handleWebSocket(request, username, path);
      }

      // Handle file content operations
      if (request.method === "GET") {
        const response = await this.handleFileGet(url, username);
        return addCorsHeaders(response);
      }

      if (request.method === "PUT") {
        const fullPath = this.ensureUserPrefix(path, username);
        const content = await request.text();
        this.saveContent(fullPath, content);
        this.broadcastFileChange(username, "update", fullPath, content);
        return addCorsHeaders(
          new Response(JSON.stringify({ success: true, path: fullPath }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      // Default API info response
      return addCorsHeaders(
        new Response(
          `FS Pod Server API
      
Endpoints:

- Files: GET/PUT/DELETE /{path}
- API: POST /api/{endpoint}
- Search: POST /api/grep, POST /api/find
- WebSocket: WS /{path}
- llms: GET /llms.txt
- admin: /studio
- SQL api: /query
      `,
          {
            headers: { "Content-Type": "text/plain" },
          },
        ),
      );
    } catch (error) {
      console.error("Error in TextDO fetch:", error);
      return addCorsHeaders(
        new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
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
      now,
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
          currentPath,
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
          parent_path,
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
      parent_path,
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
      sourcePath,
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
          child.path,
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
      path,
    );
    return result.rowsWritten > 0;
  }

  // ==================== GREP IMPLEMENTATION ====================

  /**
   * Search for pattern in file contents
   * Supports:
   * - Simple string matching (case-insensitive by default)
   * - Regex patterns (when regex=true)
   * - Path filtering
   * - Line number and context
   */
  grep(
    username: string,
    pattern: string,
    options: {
      path?: string; // Starting path (default: user root)
      regex?: boolean; // Treat pattern as regex
      caseSensitive?: boolean; // Case-sensitive search
      maxResults?: number; // Limit results (default: 1000)
      contextLines?: number; // Lines of context before/after match
      filePattern?: string; // Filter by filename pattern (glob-like)
    } = {},
  ): GrepResult[] {
    const {
      path = `/${username}`,
      regex = false,
      caseSensitive = false,
      maxResults = 1000,
      contextLines = 0,
      filePattern,
    } = options;

    const results: GrepResult[] = [];
    const searchPath = path.startsWith(`/${username}`)
      ? path
      : `/${username}${path.startsWith("/") ? "" : "/"}${path}`;

    // Build query to get files
    let query = `
      SELECT path, content FROM nodes 
      WHERE type = 'file' 
      AND content IS NOT NULL
      AND (path = ? OR path LIKE ? || '/%')
    `;
    const params: any[] = [searchPath, searchPath];

    // Add filename pattern filter
    if (filePattern) {
      // Convert glob to SQL LIKE pattern
      const sqlPattern = filePattern.replace(/\*/g, "%").replace(/\?/g, "_");
      query += ` AND name LIKE ?`;
      params.push(sqlPattern);
    }

    const files = this.sql.exec(query, ...params).toArray() as {
      path: string;
      content: string;
    }[];

    // Create regex or string matcher
    let matcher: (text: string) => { index: number; match: string }[];

    if (regex) {
      try {
        const flags = caseSensitive ? "g" : "gi";
        const re = new RegExp(pattern, flags);
        matcher = (text: string) => {
          const matches: { index: number; match: string }[] = [];
          let m;
          while ((m = re.exec(text)) !== null) {
            matches.push({ index: m.index, match: m[0] });
            if (matches.length >= maxResults) break;
          }
          return matches;
        };
      } catch (e) {
        throw new Error(`Invalid regex pattern: ${pattern}`);
      }
    } else {
      const searchTerm = caseSensitive ? pattern : pattern.toLowerCase();
      matcher = (text: string) => {
        const searchText = caseSensitive ? text : text.toLowerCase();
        const matches: { index: number; match: string }[] = [];
        let pos = 0;
        while ((pos = searchText.indexOf(searchTerm, pos)) !== -1) {
          matches.push({ index: pos, match: text.substr(pos, pattern.length) });
          pos += 1;
          if (matches.length >= maxResults) break;
        }
        return matches;
      };
    }

    // Search each file
    for (const file of files) {
      if (!file.content) continue;

      const matches = matcher(file.content);
      if (matches.length === 0) continue;

      const lines = file.content.split("\n");

      for (const match of matches) {
        // Find line number and column
        let charCount = 0;
        let lineNum = 0;

        for (let i = 0; i < lines.length; i++) {
          if (charCount + lines[i].length >= match.index) {
            lineNum = i + 1;
            break;
          }
          charCount += lines[i].length + 1; // +1 for newline
        }

        const column = match.index - charCount + 1;

        // Get context lines
        let content = lines[lineNum - 1];
        if (contextLines > 0) {
          const startLine = Math.max(0, lineNum - 1 - contextLines);
          const endLine = Math.min(lines.length, lineNum + contextLines);
          content = lines.slice(startLine, endLine).join("\n");
        }

        results.push({
          path: file.path,
          line: lineNum,
          column,
          content,
          match: match.match,
        });

        if (results.length >= maxResults) {
          return results;
        }
      }
    }

    return results;
  }

  /**
   * Full-text search using FTS5 (faster for large datasets)
   */
  grepFTS(
    username: string,
    query: string,
    options: {
      path?: string;
      maxResults?: number;
    } = {},
  ): GrepResult[] {
    const { path = `/${username}`, maxResults = 1000 } = options;
    const searchPath = path.startsWith(`/${username}`)
      ? path
      : `/${username}${path.startsWith("/") ? "" : "/"}${path}`;

    try {
      // Use FTS5 MATCH query
      const ftsResults = this.sql
        .exec(
          `
          SELECT n.path, n.content, 
                 snippet(nodes_fts, 1, '>>>>', '<<<<', '...', 32) as snippet
          FROM nodes_fts 
          JOIN nodes n ON nodes_fts.rowid = n.id
          WHERE nodes_fts MATCH ? 
          AND (n.path = ? OR n.path LIKE ? || '/%')
          LIMIT ?
        `,
          query,
          searchPath,
          searchPath,
          maxResults,
        )
        .toArray() as { path: string; content: string; snippet: string }[];

      return ftsResults.map((r) => {
        // Find the actual line with the match
        const lines = (r.content || "").split("\n");
        const matchText = r.snippet.replace(/>>>>|<<<<|\.\.\./g, "").trim();
        let lineNum = 1;
        let column = 1;

        for (let i = 0; i < lines.length; i++) {
          const idx = lines[i].toLowerCase().indexOf(matchText.toLowerCase());
          if (idx !== -1) {
            lineNum = i + 1;
            column = idx + 1;
            break;
          }
        }

        return {
          path: r.path,
          line: lineNum,
          column,
          content: r.snippet,
          match: matchText,
        };
      });
    } catch (e) {
      console.error("FTS search error:", e);
      // Fallback to regular grep
      return this.grep(username, query, { path, maxResults });
    }
  }

  // ==================== FIND IMPLEMENTATION ====================

  /**
   * Find files and folders by name pattern
   * Supports:
   * - Glob patterns (*, ?)
   * - Type filtering (file/folder)
   * - Size filtering
   * - Date filtering
   * - Depth limiting
   */
  find(
    username: string,
    options: {
      path?: string; // Starting path
      name?: string; // Name pattern (glob)
      type?: "file" | "folder" | "all";
      minSize?: number; // Minimum size in bytes
      maxSize?: number; // Maximum size in bytes
      newerThan?: number; // Unix timestamp
      olderThan?: number; // Unix timestamp
      maxDepth?: number; // Maximum directory depth
      maxResults?: number; // Limit results
    } = {},
  ): FindResult[] {
    const {
      path = `/${username}`,
      name,
      type = "all",
      minSize,
      maxSize,
      newerThan,
      olderThan,
      maxDepth,
      maxResults = 1000,
    } = options;

    const searchPath = path.startsWith(`/${username}`)
      ? path
      : `/${username}${path.startsWith("/") ? "" : "/"}${path}`;

    // Build query
    let query = `
      SELECT path, name, type, size, created_at, updated_at 
      FROM nodes 
      WHERE (path = ? OR path LIKE ? || '/%')
    `;
    const params: any[] = [searchPath, searchPath];

    // Name pattern filter
    if (name) {
      const sqlPattern = name.replace(/\*/g, "%").replace(/\?/g, "_");
      query += ` AND name LIKE ?`;
      params.push(sqlPattern);
    }

    // Type filter
    if (type !== "all") {
      query += ` AND type = ?`;
      params.push(type);
    }

    // Size filters
    if (minSize !== undefined) {
      query += ` AND size >= ?`;
      params.push(minSize);
    }
    if (maxSize !== undefined) {
      query += ` AND size <= ?`;
      params.push(maxSize);
    }

    // Date filters
    if (newerThan !== undefined) {
      query += ` AND updated_at >= ?`;
      params.push(newerThan);
    }
    if (olderThan !== undefined) {
      query += ` AND updated_at <= ?`;
      params.push(olderThan);
    }

    query += ` ORDER BY path LIMIT ?`;
    params.push(maxResults);

    let results = this.sql.exec(query, ...params).toArray() as FindResult[];

    // Apply depth filter (can't easily do in SQL)
    if (maxDepth !== undefined) {
      const baseDepth = searchPath.split("/").filter((p) => p).length;
      results = results.filter((r) => {
        const depth = r.path.split("/").filter((p) => p).length - baseDepth;
        return depth <= maxDepth;
      });
    }

    return results;
  }

  /**
   * Find files by extension
   */
  findByExtension(
    username: string,
    extension: string,
    path?: string,
  ): FindResult[] {
    const pattern = extension.startsWith(".")
      ? `*${extension}`
      : `*.${extension}`;
    return this.find(username, { path, name: pattern, type: "file" });
  }

  /**
   * Find empty files or folders
   */
  findEmpty(
    username: string,
    type: "file" | "folder" | "all" = "all",
    path?: string,
  ): FindResult[] {
    const searchPath = path
      ? path.startsWith(`/${username}`)
        ? path
        : `/${username}${path.startsWith("/") ? "" : "/"}${path}`
      : `/${username}`;

    if (type === "file" || type === "all") {
      // Empty files have size 0
      const emptyFiles = this.find(username, {
        path,
        type: "file",
        maxSize: 0,
      });

      if (type === "file") return emptyFiles;

      // Empty folders have no children
      const allFolders = this.find(username, { path, type: "folder" });
      const emptyFolders = allFolders.filter((folder) => {
        const children = this.sql
          .exec(
            `SELECT COUNT(*) as count FROM nodes WHERE parent_path = ?`,
            folder.path,
          )
          .toArray()[0] as { count: number };
        return children.count === 0;
      });

      return [...emptyFiles, ...emptyFolders];
    } else {
      // Only folders
      const allFolders = this.find(username, { path, type: "folder" });
      return allFolders.filter((folder) => {
        const children = this.sql
          .exec(
            `SELECT COUNT(*) as count FROM nodes WHERE parent_path = ?`,
            folder.path,
          )
          .toArray()[0] as { count: number };
        return children.count === 0;
      });
    }
  }

  /**
   * Get file/folder statistics
   */
  stat(
    username: string,
    path: string,
  ): (FindResult & { content?: string }) | null {
    const fullPath = path.startsWith(`/${username}`)
      ? path
      : `/${username}${path.startsWith("/") ? "" : "/"}${path}`;

    const result = this.sql
      .exec(
        `SELECT path, name, type, size, created_at, updated_at, content 
         FROM nodes WHERE path = ?`,
        fullPath,
      )
      .toArray()[0] as (FindResult & { content?: string }) | undefined;

    return result || null;
  }

  /**
   * Get disk usage (du equivalent)
   */
  du(
    username: string,
    path?: string,
  ): {
    path: string;
    totalSize: number;
    fileCount: number;
    folderCount: number;
  } {
    const searchPath = path
      ? path.startsWith(`/${username}`)
        ? path
        : `/${username}${path.startsWith("/") ? "" : "/"}${path}`
      : `/${username}`;

    const stats = this.sql
      .exec(
        `SELECT 
          COALESCE(SUM(size), 0) as totalSize,
          SUM(CASE WHEN type = 'file' THEN 1 ELSE 0 END) as fileCount,
          SUM(CASE WHEN type = 'folder' THEN 1 ELSE 0 END) as folderCount
         FROM nodes 
         WHERE path = ? OR path LIKE ? || '/%'`,
        searchPath,
        searchPath,
      )
      .toArray()[0] as {
      totalSize: number;
      fileCount: number;
      folderCount: number;
    };

    return {
      path: searchPath,
      ...stats,
    };
  }

  // ==================== APPEND OPERATION ====================

  /**
   * Append content to a file
   */
  appendContent(path: string, content: string): void {
    const existing = this.sql
      .exec(`SELECT content, type FROM nodes WHERE path = ?`, path)
      .toArray()[0] as { content: string; type: string } | undefined;

    if (!existing) {
      // Create new file if doesn't exist
      this.saveContent(path, content);
      return;
    }

    if (existing.type === "folder") {
      throw new Error("Cannot append content to a folder");
    }

    const newContent = (existing.content || "") + content;
    const now = Math.round(Date.now() / 1000);

    this.sql.exec(
      `UPDATE nodes SET content = ?, size = ?, updated_at = ? WHERE path = ?`,
      newContent,
      newContent.length,
      now,
      path,
    );
  }

  /**
   * Read partial file content (head/tail)
   */
  readPartial(
    username: string,
    path: string,
    options: { head?: number; tail?: number; lines?: boolean } = {},
  ): string {
    const fullPath = path.startsWith(`/${username}`)
      ? path
      : `/${username}${path.startsWith("/") ? "" : "/"}${path}`;

    const result = this.sql
      .exec(
        `SELECT content FROM nodes WHERE path = ? AND type = 'file'`,
        fullPath,
      )
      .toArray()[0] as { content: string } | undefined;

    if (!result || !result.content) {
      throw new Error("File not found");
    }

    const { head, tail, lines = true } = options;
    const content = result.content;

    if (lines) {
      const contentLines = content.split("\n");
      if (head !== undefined) {
        return contentLines.slice(0, head).join("\n");
      }
      if (tail !== undefined) {
        return contentLines.slice(-tail).join("\n");
      }
    } else {
      // Character mode
      if (head !== undefined) {
        return content.slice(0, head);
      }
      if (tail !== undefined) {
        return content.slice(-tail);
      }
    }

    return content;
  }

  /**
   * Word count (wc equivalent)
   */
  wc(
    username: string,
    path: string,
  ): { lines: number; words: number; chars: number; bytes: number } {
    const fullPath = path.startsWith(`/${username}`)
      ? path
      : `/${username}${path.startsWith("/") ? "" : "/"}${path}`;

    const result = this.sql
      .exec(
        `SELECT content, size FROM nodes WHERE path = ? AND type = 'file'`,
        fullPath,
      )
      .toArray()[0] as { content: string; size: number } | undefined;

    if (!result) {
      throw new Error("File not found");
    }

    const content = result.content || "";
    const lines = content.split("\n").length;
    const words = content.split(/\s+/).filter((w) => w.length > 0).length;
    const chars = content.length;

    return {
      lines,
      words,
      chars,
      bytes: result.size,
    };
  }

  getVisibleNodes(expandedPaths: string[], username: string): FileNode[] {
    let visibleCondition = `parent_path IS NULL OR parent_path = '/${username}'`;
    let params = [`/${username}/%`, `/${username}`];

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
        `/${username}/%`,
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
    const rawPath = url.pathname;

    if (rawPath === "/") {
      const files = this.sql
        .exec(
          `
        SELECT path, created_at, updated_at, type, size FROM nodes
        WHERE path LIKE ?
        ORDER BY type DESC, path ASC
      `,
          `/${username}/%`,
        )
        .toArray();

      return new Response(
        JSON.stringify({
          username: username,
          files: files,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const path = this.ensureUserPrefix(rawPath, username);

    const nodeResult = this.sql
      .exec(
        `
      SELECT content, type, created_at, updated_at, size FROM nodes WHERE path = ?
    `,
        path,
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
      const children = this.sql
        .exec(
          `
        SELECT path, name, type, size, created_at, updated_at FROM nodes
        WHERE parent_path = ?
        ORDER BY type DESC, name ASC
      `,
          path,
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
        },
      );
    }

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
      },
    );
  }

  private ensureUserPrefix(path: string, username: string): string {
    const cleanPath = path.replace(/^\/+/, "");

    if (cleanPath.startsWith(`${username}/`) || cleanPath === username) {
      return `/${cleanPath}`;
    }

    return `/${username}/${cleanPath}`;
  }

  async handleAPIRequest(
    request: Request,
    url: URL,
    username: string,
  ): Promise<Response> {
    const pathSegments = url.pathname.split("/").filter((p) => p);
    const apiEndpoint = pathSegments[1];

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

    // ==================== GREP API ====================
    if (apiEndpoint === "grep" && request.method === "POST") {
      const {
        pattern,
        path,
        regex,
        caseSensitive,
        maxResults,
        contextLines,
        filePattern,
        useFTS,
      } = requestData;

      if (!pattern) {
        return new Response(JSON.stringify({ error: "Pattern is required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      try {
        const results = useFTS
          ? this.grepFTS(username, pattern, { path, maxResults })
          : this.grep(username, pattern, {
              path,
              regex,
              caseSensitive,
              maxResults,
              contextLines,
              filePattern,
            });

        return new Response(
          JSON.stringify({ results, count: results.length }),
          {
            headers: { "Content-Type": "application/json" },
          },
        );
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    // ==================== FIND API ====================
    if (apiEndpoint === "find" && request.method === "POST") {
      const {
        path,
        name,
        type,
        minSize,
        maxSize,
        newerThan,
        olderThan,
        maxDepth,
        maxResults,
      } = requestData;

      try {
        const results = this.find(username, {
          path,
          name,
          type,
          minSize,
          maxSize,
          newerThan,
          olderThan,
          maxDepth,
          maxResults,
        });
        return new Response(
          JSON.stringify({ results, count: results.length }),
          {
            headers: { "Content-Type": "application/json" },
          },
        );
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    // ==================== STAT API ====================
    if (apiEndpoint === "stat" && request.method === "POST") {
      const { path } = requestData;

      if (!path) {
        return new Response(JSON.stringify({ error: "Path is required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const result = this.stat(username, path);
      if (!result) {
        return new Response(JSON.stringify({ error: "File not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ==================== DU (DISK USAGE) API ====================
    if (apiEndpoint === "du" && request.method === "POST") {
      const { path } = requestData;
      const result = this.du(username, path);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ==================== HEAD API ====================
    if (apiEndpoint === "head" && request.method === "POST") {
      const { path, lines = 10 } = requestData;

      if (!path) {
        return new Response(JSON.stringify({ error: "Path is required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      try {
        const content = this.readPartial(username, path, { head: lines });
        return new Response(JSON.stringify({ content }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    // ==================== TAIL API ====================
    if (apiEndpoint === "tail" && request.method === "POST") {
      const { path, lines = 10 } = requestData;

      if (!path) {
        return new Response(JSON.stringify({ error: "Path is required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      try {
        const content = this.readPartial(username, path, { tail: lines });
        return new Response(JSON.stringify({ content }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    // ==================== WC (WORD COUNT) API ====================
    if (apiEndpoint === "wc" && request.method === "POST") {
      const { path } = requestData;

      if (!path) {
        return new Response(JSON.stringify({ error: "Path is required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      try {
        const result = this.wc(username, path);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    // ==================== APPEND API ====================
    if (apiEndpoint === "append" && request.method === "POST") {
      const { path, content } = requestData;

      if (!path) {
        return new Response(JSON.stringify({ error: "Path is required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const fullPath = this.ensureUserPrefix(path, username);

      try {
        this.appendContent(fullPath, content || "");
        this.broadcastFileChange(username, "update", fullPath);
        return new Response(JSON.stringify({ success: true, path: fullPath }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    // Existing API endpoints...
    if (apiEndpoint === "visible-nodes" && request.method === "POST") {
      const { expandedPaths = [] } = requestData;
      const visibleNodes = this.getVisibleNodes(expandedPaths, username);
      return new Response(JSON.stringify({ nodes: visibleNodes }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (apiEndpoint === "create-file" && request.method === "POST") {
      const { path, content = "" } = requestData;
      const fullPath = this.ensureUserPrefix(path, username);
      try {
        this.createFile(fullPath, content);
        this.broadcastFileChange(username, "create", fullPath, content);
        return new Response(JSON.stringify({ success: true, path: fullPath }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    if (apiEndpoint === "create-folder" && request.method === "POST") {
      const { path } = requestData;
      const fullPath = this.ensureUserPrefix(path, username);
      try {
        this.createFolder(fullPath);
        this.broadcastFileChange(username, "create", fullPath);
        return new Response(JSON.stringify({ success: true, path: fullPath }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    if (apiEndpoint === "copy-node" && request.method === "POST") {
      const { sourcePath, targetPath } = requestData;
      const fullSourcePath = this.ensureUserPrefix(sourcePath, username);
      const fullTargetPath = this.ensureUserPrefix(targetPath, username);
      try {
        this.copyNode(fullSourcePath, fullTargetPath);
        this.broadcastFileChange(username, "copy", fullTargetPath);
        return new Response(
          JSON.stringify({ success: true, path: fullTargetPath }),
          {
            headers: { "Content-Type": "application/json" },
          },
        );
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    if (apiEndpoint === "move-node" && request.method === "POST") {
      const { sourcePath, targetPath } = requestData;
      const fullSourcePath = this.ensureUserPrefix(sourcePath, username);
      const fullTargetPath = this.ensureUserPrefix(targetPath, username);
      try {
        this.moveNode(fullSourcePath, fullTargetPath);
        this.broadcastFileChange(
          username,
          "move",
          fullTargetPath,
          undefined,
          fullSourcePath,
        );
        return new Response(
          JSON.stringify({ success: true, path: fullTargetPath }),
          {
            headers: { "Content-Type": "application/json" },
          },
        );
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    if (apiEndpoint === "rename-node" && request.method === "POST") {
      const { path, newName } = requestData;
      const fullPath = this.ensureUserPrefix(path, username);
      try {
        this.renameNode(fullPath, newName);
        const pathParts = fullPath.split("/");
        pathParts[pathParts.length - 1] = newName;
        const newPath = pathParts.join("/");
        this.broadcastFileChange(
          username,
          "rename",
          newPath,
          undefined,
          fullPath,
        );
        return new Response(JSON.stringify({ success: true, path: newPath }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    if (apiEndpoint === "delete-node" && request.method === "POST") {
      const { path } = requestData;
      const fullPath = this.ensureUserPrefix(path, username);
      const deleted = this.deleteNode(fullPath);
      if (deleted) {
        this.broadcastFileChange(username, "delete", fullPath);
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
      const fullBasePath = this.ensureUserPrefix(basePath, username);
      const nextName = this.getNextAvailableName(fullBasePath, extension);
      return new Response(JSON.stringify({ nextName }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "API endpoint not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  handleWebSocket(
    request: Request,
    username: string,
    rawPath: string,
  ): Response {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    server.accept();
    const sessionId = crypto.randomUUID();

    const path = this.ensureUserPrefix(rawPath, username);

    let textContent = "";
    const nodeResult = this.sql
      .exec(
        `
      SELECT content, type FROM nodes WHERE path = ?
    `,
        path,
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
      }),
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
              }),
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
            path,
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
    _username: string,
    action: "create" | "update" | "delete" | "move" | "rename" | "copy",
    path: string,
    content?: string,
    oldPath?: string,
  ): void {
    const message: WSMessage = {
      type: "file_change",
      path,
      ...(content !== undefined && { text: content }),
      ...(oldPath && { fromSession: oldPath }),
    };

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

// Handler for protected resources (after OAuth authentication)
const protectedHandler = async (
  request: Request,
  env: Env,
  ctx: ResourceUserContext,
): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname;

  // Apply permissions checks
  if (request.method === "GET") {
    const requiredScope = path === "/" ? "read:" : `read:${path.slice(1)}`;
    if (!ctx.hasScope(requiredScope)) {
      return addCorsHeaders(
        new Response("Insufficient permissions", { status: 403 }),
      );
    }
  } else if (request.method === "PUT") {
    const requiredScope = `write:${path.slice(1)}`;
    if (!ctx.hasScope(requiredScope)) {
      return addCorsHeaders(
        new Response("Insufficient permissions", { status: 403 }),
      );
    }
  } else if (request.method === "POST" && path.startsWith("/api/append")) {
    const targetPath = url.searchParams.get("path");
    const requiredScope = `append:${targetPath?.slice(1)}`;
    if (!ctx.hasScope(requiredScope)) {
      return addCorsHeaders(
        new Response("Insufficient permissions", { status: 403 }),
      );
    }
  }

  if (!ctx.user) {
    return addCorsHeaders(
      new Response("Authentication required", { status: 401 }),
    );
  }

  const stub = env.TEXT.get(env.TEXT.idFromName(ctx.user.id + DO_NAME_SUFFIX));

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
      }),
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
      }),
    );
  }
};

// Apply token validation middleware for protected resources
const authenticatedHandler = tokenValidationMiddleware(protectedHandler, {
  isLoginRequired: true,
});

export default {
  fetch: async (
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> => {
    // First, check if this is an OAuth client endpoint (login with X)
    const clientResponse = await oauthClientMiddleware(request, env, ctx);
    if (clientResponse) return clientResponse;

    // Then, check if this is an OAuth provider endpoint (for downstream apps)
    const providerResponse = await oauthProviderMiddleware(request, env, ctx);
    if (providerResponse) return providerResponse;

    // Otherwise, pass through to the authenticated handler
    return authenticatedHandler(request, env, ctx);
  },
};
