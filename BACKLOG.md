# Topics

- **Business model & Enterprise offering**

- **Efficiency problem** How to use Cloudflare tech to enable a good SOLID server without degradation/limitation of app performance? Can we leverage DO SQL more, or of not, how do we design apps that are maximally efficient (is there an alternative to the SQL indexing in the file system?)

- **Onboarding problem** How to ensure that apps we make intended for SOLID are able to easily provision a temporary POD when onboarding, and allow to then transfer this data to their own server. I think to make the apps itself accessible, they need MCP compatible oauth as entry point for users and should provision our server by default, while making it possible to switch. but I think this can be done completely standalone from what you've done here

- **Sync from local fs** - can we make a dropbox-like app that syncs a certain folder to the pod server? this makes it much more interoperable with things like ffmpeg or any other tools you might have on your PC (and your own files)

- **Using Stytch** would make it more adoptable for other startups since it's more prominent in the oauth space. How do we create a oauth provider that hooks into _ANY_ SOLID server?

- **Making it easy to integrate fs-based apps/clis with SOLID** could really be useful because the ecosystem for fs is grand. However if we build for solid, the inner working will be totally different. can we design an API that looks alike and potentially is 'swappable'?
