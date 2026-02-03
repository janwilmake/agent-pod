/// <reference types="@cloudflare/workers-types" />
/// <reference lib="esnext" />

import { DurableObject } from "cloudflare:workers";
import { Queryable } from "queryable-object";
import type { Env, XUser, FileNode, AuthData } from "./types";

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

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS resource_logins (
        access_token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
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
        `SELECT rl.scopes, u.*
      FROM resource_logins rl
      JOIN users u ON rl.user_id = u.user_id
      WHERE rl.access_token = ?`,
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

  async setAuthData(authCode: string, data: AuthData) {
    await this.storage.put(`code:${authCode}`, data);
  }

  async getAuthData(authCode: string): Promise<AuthData | undefined> {
    return this.storage.get<AuthData>(`code:${authCode}`);
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
