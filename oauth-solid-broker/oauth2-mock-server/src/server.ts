import { OAuth2Server } from 'oauth2-mock-server';

export interface ServerConfig {
  port?: number;
  host?: string;
  issuerUrl?: string;
  keyAlgorithm?: 'RS256' | 'RS384' | 'RS512' | 'PS256' | 'PS384' | 'PS512' | 'ES256' | 'ES384' | 'ES512' | 'Ed25519';
}

export class MockOAuth2Server {
  private server: OAuth2Server;
  private isRunning = false;

  constructor(private config: ServerConfig = {}) {
    this.server = new OAuth2Server();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('Server is already running');
    }

    const port = this.config.port ?? 8080;
    const host = this.config.host ?? 'localhost';
    const keyAlgorithm = this.config.keyAlgorithm ?? 'RS256';

    await this.server.issuer.keys.generate(keyAlgorithm);
    
    await this.server.start(port, host);
    this.isRunning = true;

    console.log(`OAuth2 Mock Server started at: ${this.server.issuer.url}`);
    console.log(`JWKS endpoint: ${this.server.issuer.url}/jwks`);
    console.log(`Token endpoint: ${this.server.issuer.url}/token`);
    console.log(`Authorize endpoint: ${this.server.issuer.url}/authorize`);
    console.log(`UserInfo endpoint: ${this.server.issuer.url}/userinfo`);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    await this.server.stop();
    this.isRunning = false;
    console.log('OAuth2 Mock Server stopped');
  }

  get issuerUrl(): string {
    if (!this.isRunning) {
      throw new Error('Server is not running');
    }
    return this.server.issuer.url || '';
  }

  async buildToken(customClaims?: Record<string, unknown>): Promise<string> {
    if (!this.isRunning) {
      throw new Error('Server is not running');
    }

    const token = await this.server.issuer.buildToken(customClaims);
    return token;
  }

  addCustomTokenClaims(handler: (token: any, req: any) => void): void {
    this.server.service.once('beforeTokenSigning', handler);
  }

  addCustomResponse(handler: (response: any, req: any) => void): void {
    this.server.service.once('beforeResponse', handler);
  }

  getServer(): OAuth2Server {
    return this.server;
  }
}

export default MockOAuth2Server;