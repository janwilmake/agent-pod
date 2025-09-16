import type { KVNamespace } from "@cloudflare/workers-types";

// Minimal shape for the OAuth provider helper we use from env.OAUTH_PROVIDER
export interface OAuthRequestInfo {
  responseType: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

export interface OAuthProviderHelpers {
  parseAuthRequest(request: Request): Promise<OAuthRequestInfo>;
  lookupClient(clientId: string): Promise<unknown>;
  completeAuthorization(options: {
    request: OAuthRequestInfo;
    userId: string;
    metadata?: unknown;
    scope: string[];
    props: Record<string, unknown>;
  }): Promise<{ redirectTo: string }>;
}

// Execution context that may carry OAuth props when API routes are called
export type OAuthExecutionContext = ExecutionContext & {
  props?: Record<string, unknown>;
};

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthProviderHelpers;
}
