/// <reference types="@cloudflare/workers-types" />

import type { QueryableHandler } from "queryable-object";
import type { UserDO } from "./user-do";

export interface Env {
  SELF_CLIENT_ID: string;
  X_OAUTH_PROVIDER_URL: string;
  ENCRYPTION_SECRET: string;
  ADMIN_X_USERNAME: string;
  UserDO: DurableObjectNamespace<UserDO & QueryableHandler>;
  TEXT: DurableObjectNamespace<any>;
  KV: KVNamespace;
  ENVIRONMENT: string;
  PORT?: string;
}

export interface XUser {
  id: string;
  name: string;
  username: string;
  profile_image_url?: string;
  verified?: boolean;
  [key: string]: any;
}

export interface FileNode {
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

export interface OAuthState {
  redirectTo?: string;
  codeVerifier: string;
  resource?: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  scopes: string[];
}

export interface AuthData {
  userId: string;
  clientId: string;
  redirectUri: string;
  resource?: string;
  scopes: string[];
}

export interface ResourceUserContext<
  T = { [key: string]: any }
> extends ExecutionContext {
  user: XUser | undefined;
  scopes: string[];
  accessToken: string | undefined;
  hasScope: (requiredScope: string) => boolean;
}
