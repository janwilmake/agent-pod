# Agent POD

This project aims to solve the problem of capturing all your digital personal data and store it into a single place that you control, then allowing a simple interface for agents to do things with your data. Inspired by [SOLID from Tim Berners-Lee](<https://en.wikipedia.org/wiki/Solid_(web_decentralization_project)>) this project uses the same terminology of a POD, without prioritizing other requirements of the [SOLID protocol](https://solidproject.org/TR/protocol). This project shares the same ultimate goal of SOLID: to allow users to have full control of their own data, including access control and storage location.

There are many questions unanswered, and in this project I aim to link any work I do to get answers (and better questions).

- How should we structure information? Is a file system sufficient, does a tag-based system make more sense, or perhaps a system where we can assign multiple hierarchies of meaning to the same data?

- How can i create an operating system in which 100% of my personal data and output is captured in a way that makes it easy to navigate and work with?

- Does it make sense to integrate with protocols like SOLID or ATProto? If so, how can we do this without loosing focus? Are all their requirements strictly necessary or is a subset of it more practical?

- How do we create this type of data storage for groups of people rather than individuals?

- Do we need [RFD](https://www.w3.org/RDF/) per se, or is JSON or even fully unstructured files sufficient?

What im interested in is how we can transition from traditional apps to apps that don't store personal data. Basically, there's already lots of apps online and currently they all own the data. There's no solid pods that have access to all of these. It'd be great if we could design a system that has a general way to syncing your data from any platform that has any API, into your own solid POD. Think: GitHub, X, google drive, etc. now we can keep using these services but all data also ends up in the solid pod. now, it becomes possible to create solid-first apps because the data is already there.

# Experiments

**Ergonomical Data Capture**

- [efficient-recorder](efficient-recorder/) ([thread](https://news.ycombinator.com/item?id=42596607)) - the original contents of this repo, goal: Create the most **battery-life friendly** recorder to stream video/screen/mic/system-audio to any **S3-compatible** cloud-storage-service of choice, open source.
- [ip-camera-to-s3-macos](ip-camera-to-s3-macos/) - Battery-efficient RTSP video capture and S3 upload utility optimized for macOS (Apple Silicon)
- [yaptabber](yaptabber/) - Yaptabber uploads your screen, video, and mic to your s3 whenever there's sound detected, with a minimum length of 10 seconds.
- [export-safari](export-safari/) - Export your Safari history every hour and upload it to a D1 database

**POD Servers**

I soon aim to create a POD server that uses [simplerauth](https://github.com/janwilmake/universal-mcp-oauth/tree/main/simplerauth-client) for authentication, then offers a SOLID-like API that allows apps to easily read and write data to it. We can use [Durable Objects](https://developers.cloudflare.com/durable-objects/) for storage.

Let me know if you want to be involved!
