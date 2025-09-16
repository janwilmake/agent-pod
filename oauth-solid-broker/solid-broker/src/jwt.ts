import { Env } from "./types";

// Minimal JOSE helpers for Workers using WebCrypto.
// - Imports an RSA private key from PKCS#8 PEM
// - Signs payloads with RS256
// - Exports a public JWK for JWKS endpoint

const enc = new TextEncoder();

export type Jwk = {
  kty: "RSA";
  n: string;
  e: string;
  kid?: string;
  alg?: string;
  use?: string;
};

export async function importPrivateKeyFromPem(pem: string): Promise<CryptoKey> {
  const lines = pem.trim().split(/\r?\n/);
  const body = lines
    .filter((l) => !l.startsWith("---"))
    .join("");
  const raw = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    raw,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["sign"]
  );
}

export async function publicJwkFromPrivateKey(priv: CryptoKey, kid?: string): Promise<Jwk> {
  const pubKey = await crypto.subtle.exportKey("jwk", await toPublicKey(priv));
  const jwk: Jwk = {
    kty: "RSA",
    n: pubKey.n as string,
    e: pubKey.e as string,
  };
  if (kid) jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return jwk;
}

async function toPublicKey(priv: CryptoKey): Promise<CryptoKey> {
  // Export private as JWK, re-import as public key
  const jwk = (await crypto.subtle.exportKey("jwk", priv)) as JsonWebKey;
  delete jwk.d;
  delete jwk.dp;
  delete jwk.dq;
  delete jwk.q;
  delete jwk.qi;
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["verify"]
  );
}

function b64url(bytes: Uint8Array): string {
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function utf8ToUint8(str: string): Uint8Array {
  return enc.encode(str);
}

export async function signJwtRS256(priv: CryptoKey, header: any, payload: any): Promise<string> {
  const encodedHeader = b64url(utf8ToUint8(JSON.stringify(header)));
  const encodedPayload = b64url(utf8ToUint8(JSON.stringify(payload)));
  const toSign = enc.encode(`${encodedHeader}.${encodedPayload}`);
  const sigBuf = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", priv, toSign);
  const sig = b64url(new Uint8Array(sigBuf));
  return `${encodedHeader}.${encodedPayload}.${sig}`;
}

export async function makeSigner(env: Env) {
  const priv = await importPrivateKeyFromPem(env.JWT_PRIVATE_KEY_PEM);
  const kid = env.JWT_KID;
  const jwk = await publicJwkFromPrivateKey(priv, kid);
  return {
    jwk,
    async sign(payload: Record<string, unknown>) {
      const header = { alg: "RS256", typ: "JWT", kid };
      return signJwtRS256(priv, header, payload);
    },
  };
}

