# Agent POD

This project aims to solve the problem of **capturing all your digital personal data and store it into a single place that you control**, then allowing a simple interface for agents and apps to do things with your data. Inspired by [SOLID from Tim Berners-Lee](<https://en.wikipedia.org/wiki/Solid_(web_decentralization_project)>) this project uses the same terminology of a POD, without prioritizing other requirements of the [SOLID protocol](https://solidproject.org/TR/protocol). This project shares the same ultimate goal of SOLID: to allow users to have full control of their own data, including access control and storage location.

![](store-anything.svg)

[Read more about SOLID here](https://solidproject.org/about)

There are many questions unanswered, and in this project I aim to link any work I do to get answers (and better questions).

- How should we structure information? Is a file system sufficient, does a tag-based system make more sense, or perhaps a system where we can assign multiple hierarchies of meaning to the same data?

- How can i create an operating system in which 100% of my personal data and output is captured in a way that makes it easy to navigate and work with?

- Does it make sense to integrate with protocols like SOLID or ATProto? If so, how can we do this without loosing focus? Are all their requirements strictly necessary or is a subset of it more practical?

- How do we create this type of data storage for groups of people rather than individuals?

- Do we need [RFD](https://www.w3.org/RDF/) per se, or is JSON or even fully unstructured files sufficient?

What im interested in is how we can transition from traditional apps to apps that don't store personal data. Basically, there's already lots of apps online and currently they all own the data. There's no solid pods that have access to all of these. It'd be great if we could design a system that has a general way to syncing your data from any platform that has any API, into your own solid POD. Think: GitHub, X, google drive, etc. now we can keep using these services but all data also ends up in the solid pod. now, it becomes possible to create solid-first apps because the data is already there.

# Design Decisions

1. The SOLID spec suggests using [Solid-OIDC](https://solidproject.org/TR/oidc) and either [WAC](https://solidproject.org/TR/wac) or [ACP](https://solidproject.org/TR/acp). Since these are lesser known specifications and since I'm convinced it can also be done with OAuth which has much wider adoption, the current SOLID server implementations don't implement this yet. We may add this at a later stage.

# Experiments

**POD Servers**

- [xytext](https://github.com/janwilmake/xytext) - Early prototype of a 'POD server' that uses X OAuth for authentication and a minimal monaco-based interface for file editing. Needs to move to MCP-compatible oauth, and needs to offer a SOLID-like API that allows apps to easily read and write data to it.
- [pod-server](pod-server/) - Minimal FS POD server with MCP-compatible OAuth. Work in progress.

**POD Apps**

- [server demo](https://server.agent-pod.com/demo) - shows oauth
- [demo-explorer](demo-explorer/) - shows simple explorer after logging in (WIP)

# Let's make this real

Let me know if you want to be involved! Seeking contributors who share a common goal of **capturing all your digital personal data and store it into a single place that you control** and making it super easy to build secure and capable apps that create utility with this shared data.

## MVP

To work towards an MVP that is viable open source:

- Instruct users to self-host this on their own Cloudflare
- Offer a clear path to creating pod servers that can be hosted anywhere

## Demo ideas (that could go viral) - TBD

- Multiple apps using the same X Network Data; start with https://github.com/janwilmake/x-crm-mcp (app 1), create app that uses AI to enrich this further (app 2)

- Get all browser history synced (app 1) and have simple app that accesses it using MCP (app 2)

- Efficient sync screen-recording to fs (app 1) and have simple app that uses ai to analyze it (app 2)
