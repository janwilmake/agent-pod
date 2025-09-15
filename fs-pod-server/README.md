# pod api

Headless collaborative file system API with real-time WebSocket support and direct SQL access

![](design.drawio.png)

Demo: https://server.agent-pod.com

# PLAN

1. ✅ Take `xytext` and strip out all front-end (https://letmeprompt.com/rules-httpsuithu-xjgyzz0)
2. ✅ strip out oauth, replace with mcp-compatible oauth (https://github.com/janwilmake/universal-mcp-oauth/tree/main/simplerauth-client)
3. ✅ clean up api footprint a bit more. focus on purely necessary for file access.
4. ✅ come up with scopes of that apps using this file system may request. definitely needs ability for user to select fs scope, read,write,time-bound, etc. this is cool. needs to be added to simplerauth clients login flow. https://letmeprompt.com/rules-httpsuithu-guuz6k0
5. see how this differs from https://solidproject.org/TR/protocol and if its worth refactoring it towards it - https://letmeprompt.com/rules-httpsuithu-wknp8p0
6. create a super clear documentation about the API and how to make a client.
7. once I have this with oauth provider:

- build the frontend against this separately. this part could also control making stuff public and followable.
- build a fs MCP
- build a web-based terminal for it
- build a fs sync for MacOS so I can keep using browser fs functionality like downloading and selecting files: https://letmeprompt.com/in-which-ways-do-b-3xdzoa0

This now opens the door for doing much more because it allows easily making web-based apps that use a central file system without owning the data.

# Questions

- Use a local user filesystem for this, or is Cloudflare's addressable DO better (POD = always online, infinitely scalable)?
  - most peoople use AI from phone, no always on desktop
