# OAuth2 Mock Server

A clean TypeScript OAuth2 mock server for development and testing, built with modern Node.js.

## Features

- Built with TypeScript and modern Node.js (ES modules)
- Support for multiple JWT signing algorithms (RS256, ES256, etc.)
- CLI interface with pnpx support
- Programmatic API for use in tests
- Graceful shutdown handling
- Environment variable configuration

## Installation

```bash
pnpm install @oauth-solid-broker/oauth2-mock-server
```

## Usage

### Command Line

Run directly with pnpx:

```bash
pnpx @oauth-solid-broker/oauth2-mock-server
```

With options:

```bash
pnpx @oauth-solid-broker/oauth2-mock-server --port 3000 --host 0.0.0.0 --algorithm ES256
```

### Programmatic Usage

```typescript
import { MockOAuth2Server } from '@oauth-solid-broker/oauth2-mock-server';

const server = new MockOAuth2Server({
  port: 8080,
  host: 'localhost',
  keyAlgorithm: 'RS256'
});

await server.start();
console.log('Server running at:', server.issuerUrl);

// Generate a token
const token = await server.buildToken({
  sub: 'user123',
  scope: 'read write'
});

// Stop the server when done
await server.stop();
```

## Configuration

### CLI Options

- `--port, -p <number>`: Port to run the server on (default: 8080)
- `--host, -h <string>`: Host to bind the server to (default: localhost)
- `--algorithm, -a <alg>`: JWT signing algorithm (default: RS256)
- `--help`: Show help message

### Environment Variables

- `OAUTH2_MOCK_PORT`: Port to run the server on
- `OAUTH2_MOCK_HOST`: Host to bind the server to
- `OAUTH2_MOCK_ALGORITHM`: JWT signing algorithm

### Supported Algorithms

- RS256, RS384, RS512 (RSA with SHA)
- PS256, PS384, PS512 (RSA-PSS with SHA)
- ES256, ES384, ES512 (ECDSA with SHA)
- Ed25519 (EdDSA)

## Endpoints

The server provides standard OAuth2/OIDC endpoints:

- `/.well-known/openid-configuration` - OpenID Connect Discovery
- `/jwks` - JSON Web Key Set
- `/token` - Token endpoint
- `/authorize` - Authorization endpoint
- `/userinfo` - UserInfo endpoint
- `/revoke` - Token revocation
- `/endsession` - End session endpoint
- `/introspect` - Token introspection

## Development

```bash
pnpm install
pnpm build
pnpm dev --port 3000
```

## License

MIT