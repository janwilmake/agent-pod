# E2E Testing Usage

## Running the servers with logging

**Terminal 1 - Solid Broker:**
```bash
cd ../solid-broker
pnpm dev:logged
```

**Terminal 2 - OAuth Server:**
```bash
cd ../cloudflare-oauth-server  
pnpm dev:logged
```

**Terminal 3 - Community Server:**
```bash
cd ../community-server
pnpm start:logged
```

## Running the tests

**Terminal 4 - Tests:**
```bash
cd e2e
pnpm test
```

## Viewing logs

All server logs are automatically piped to `e2e/logs/`:
- `logs/solid-broker.log` - Solid broker logs
- `logs/oauth-server.log` - OAuth server logs  
- `logs/community-server.log` - Community Solid server logs

Watch logs in real-time:
```bash
pnpm test:logs
```

Or check specific logs:
```bash
tail -f logs/solid-broker.log
tail -f logs/oauth-server.log
tail -f logs/community-server.log
```

## Workflow

1. Start all three servers with logging commands
2. Wait for them to be ready (check console output)
3. Run tests with `pnpm test`
4. If tests fail, check the relevant log files for server-side errors