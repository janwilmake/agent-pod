#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { MockOAuth2Server, type ServerConfig } from './server.js';

interface CliOptions {
  port?: number;
  host?: string;
  algorithm?: ServerConfig['keyAlgorithm'];
  help?: boolean;
}

function showHelp() {
  console.log(`
OAuth2 Mock Server - A development and testing OAuth2 server

Usage:
  pnpx @oauth-solid-broker/oauth2-mock-server [options]

Options:
  --port, -p <number>     Port to run the server on (default: 8080)
  --host, -h <string>     Host to bind the server to (default: localhost)
  --algorithm, -a <alg>   JWT signing algorithm (default: RS256)
                          Available: RS256, RS384, RS512, PS256, PS384, PS512, ES256, ES384, ES512, Ed25519
  --help                  Show this help message

Examples:
  pnpx @oauth-solid-broker/oauth2-mock-server
  pnpx @oauth-solid-broker/oauth2-mock-server --port 3000 --host 0.0.0.0
  pnpx @oauth-solid-broker/oauth2-mock-server --algorithm ES256

Environment Variables:
  OAUTH2_MOCK_PORT        Port to run the server on
  OAUTH2_MOCK_HOST        Host to bind the server to
  OAUTH2_MOCK_ALGORITHM   JWT signing algorithm
`);
}

async function main() {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        port: { type: 'string', short: 'p' },
        host: { type: 'string', short: 'h' },
        algorithm: { type: 'string', short: 'a' },
        help: { type: 'boolean' }
      },
      allowPositionals: false
    });

    if (values.help) {
      showHelp();
      return;
    }

    const config: ServerConfig = {
      port: values.port ? parseInt(values.port, 10) : parseInt(process.env.OAUTH2_MOCK_PORT || '8080', 10),
      host: values.host || process.env.OAUTH2_MOCK_HOST || 'localhost',
      keyAlgorithm: (values.algorithm || process.env.OAUTH2_MOCK_ALGORITHM || 'RS256') as ServerConfig['keyAlgorithm']
    };

    if (isNaN(config.port!) || config.port! < 1 || config.port! > 65535) {
      console.error('Error: Port must be a number between 1 and 65535');
      process.exit(1);
    }

    const server = new MockOAuth2Server(config);

    process.on('SIGINT', async () => {
      console.log('\nShutting down server...');
      await server.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\nShutting down server...');
      await server.stop();
      process.exit(0);
    });

    await server.start();

    console.log('\nServer is ready! Press Ctrl+C to stop.');

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}