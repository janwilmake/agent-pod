#!/bin/bash

# Default values
PORT=8799
REDIRECT_URI="http://localhost:8789/callback"
CLIENT_NAME="Solid Broker Client"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --redirect-uri)
      REDIRECT_URI="$2"
      shift 2
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --client-name)
      CLIENT_NAME="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --redirect-uri URL    OAuth redirect URI (default: http://localhost:8789/callback)"
      echo "  --port PORT          OAuth server port (default: 8799)"
      echo "  --client-name NAME   Client name (default: Solid Broker Client)"
      echo "  --help, -h           Show this help message"
      echo ""
      echo "Example:"
      echo "  $0 --redirect-uri http://localhost:3000/callback --client-name \"My App\""
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

SERVER_URL="http://localhost:$PORT"

echo "🔧 Seeding OAuth2 client..."
echo "   Server: $SERVER_URL"
echo "   Redirect URI: $REDIRECT_URI"
echo "   Client Name: $CLIENT_NAME"
echo ""

# Register the client
RESPONSE=$(curl -s -X POST "$SERVER_URL/oauth/register" \
  -H "Content-Type: application/json" \
  -d "{
    \"redirect_uris\": [\"$REDIRECT_URI\"],
    \"client_name\": \"$CLIENT_NAME\",
    \"grant_types\": [\"authorization_code\"],
    \"response_types\": [\"code\"],
    \"token_endpoint_auth_method\": \"client_secret_basic\"
  }")

# Check if curl succeeded
if [ $? -ne 0 ]; then
  echo "❌ Failed to connect to OAuth server at $SERVER_URL"
  echo "   Make sure the server is running with: pnpm dev"
  exit 1
fi

# Parse the response
CLIENT_ID=$(echo "$RESPONSE" | grep -o '"client_id":"[^"]*"' | cut -d'"' -f4)
CLIENT_SECRET=$(echo "$RESPONSE" | grep -o '"client_secret":"[^"]*"' | cut -d'"' -f4)

if [ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ]; then
  echo "✅ Client created successfully!"
  echo ""
  echo "📋 Client Credentials:"
  echo "   CLIENT_ID:     $CLIENT_ID"
  echo "   CLIENT_SECRET: $CLIENT_SECRET"
  echo ""
  echo "🔗 Use these credentials in your application configuration."
else
  echo "❌ Failed to create client. Server response:"
  echo "$RESPONSE"
  exit 1
fi