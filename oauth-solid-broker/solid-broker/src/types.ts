export interface Env {
  BROKER_KV: KVNamespace;

  // Broker issuer and webid config
  BROKER_ISSUER: string; // e.g., https://openid.example.com
  WEBID_HOST: string; // e.g., id.example.com
  TOKEN_TTL_SECONDS?: number; // e.g., 300

  // Signing keys
  JWT_PRIVATE_KEY_PEM: string; // PKCS#8 PEM
  JWT_KID: string; // kid value exposed in JWKS

  // Backing provider
  BACKING_ISSUER: string;
  BACKING_CLIENT_ID: string;
  BACKING_CLIENT_SECRET: string;
  BACKING_AUTH_PATH?: string; // default /authorize
  BACKING_TOKEN_PATH?: string; // default /oauth/token
  BACKING_USERINFO_PATH?: string; // optional userinfo or whoami
}

export type Client = {
  client_id: string;
  client_secret?: string; // confidential if present
  redirect_uris: string[];
  client_name?: string;
};

export type AuthRequest = {
  response_type: "code";
  client_id: string;
  redirect_uri: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: "S256" | "plain";
};

export type StoredAuth = AuthRequest & {
  created: number;
  internal_state: string; // internal correlation
};

export type CodeRecord = {
  client_id: string;
  redirect_uri: string;
  scope: string[];
  sub: string;
  webid: string;
  created: number;
  expires_at: number;
  // PKCE
  code_challenge?: string;
  code_challenge_method?: "S256" | "plain";
};

