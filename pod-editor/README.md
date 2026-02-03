# XYText Client

A collaborative text editor that uses Agent Pod as its backend.

## Features

- Monaco editor with syntax highlighting
- File explorer with folder hierarchy
- Real-time collaboration via WebSocket
- OAuth 2.0 authentication with Agent Pod
- Dark/light theme support

## Setup

1. Deploy to Cloudflare Workers
2. Create a KV namespace and update wrangler.json
3. Register your app with Agent Pod (optional - dynamic registration supported)
4. Set your custom domain

## Authentication

This app uses OAuth 2.0 with PKCE to authenticate with Agent Pod. Your app's hostname
serves as the `client_id`. Users are redirected to Agent Pod to grant permissions,
and can select which files/folders to share.

## Scopes

The app requests `read:{resource} write:{resource}` scopes, which means users
will be presented with a file picker to choose which resources to grant access to.

## Context

Made using the agent-pod server openapi.

https://server.agent-pod.com/openapi.yaml

## License

MIT
