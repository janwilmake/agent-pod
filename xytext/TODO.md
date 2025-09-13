## Fix filebug

When I do a script endtag, the page breaks. need lol-html for data object, may be fixed with inserting monacobro

## Cleanup

The entire thing is now 3000 lines of code. Let's remove the follow functionality, this will already free up some lines. Also it'd be nice to split up the code using logical separation of concerns.

There are some interesting areas that can be explored here, and it's easier to do this with a more structured codebase.

# Doing formdata -> formdata API-calls within xytext (uit-like)

This is gonna be epic, basically any external API should be able to be sent formdata and return formdata or perform other file manipulations over this same formdata api through my `uit` formdata standard extension

How this would look is: right-click a file/folde -> hit action -> API will be running in background -> files will literally STREAM IN as the results come back. this is what's needed..... EPIC.

Custom generations in lmpify may be less important than this, this can be any action, also e.g. github clone or esbuild.

# OG image

It'd be cool to have a very well-designed og-image:

- large user pfp
- username
- filename
- size in tokens
- last edited date
- whether or not the owner is there (offline 🔴 / online 🟢)
- how many others are present (unique users in sessions, using their pfp too)

## Preview functionality

It's basically the same as `flaredream.streamserve`, except for that it is backed by the files here. This is a very different setup though, since files are separate, not in a markdown response, and they're likely not streaming (although that could be cool too)

Probably at first it's best to simply start copying it and customizing to the needs here.

- separate worker connected to the same DO script_name
- assign correct mediatype based on extension
- markdown is rendered as markdown
- same sidebar as here show other files and easily navigate to edit
- bonus: realtime websocket connection with file from client-side could potentially allow hot-reloading of html 🤯 imagine using that in a brave split view. so dope.

## Custom named generations (this is also an action applying a single file to an API)

Just like the prompt button, what if we had a button to see the last-generated outcome in gptideas? Since hyphens aren't allowed in X usernames, what if https://{filename}-janwilmake.letmeprompt.com would be tied to the generation? Maybe this is what I'm ACTUALLY LOOKING FOR?

- In lmpify, choosing a name is likely an awkward experience, whereas in a file editor it's much more intuitive.
- In lmpify we can choose the model, in xytext, maybe we should provide it as built-in thing we just know works, and has a built-in system prompt!

After I have the MCP with deployment and that's an API

- login with cloudflare from xytext
- use `/{filepath-slug}-{username}` with lmpify API with flaredream systemprompt and deploy MCP deployed to hostname that is inferred from filename unless defined in wrangler.

## Edit Javascript and HTML

The bare minimum for this to also function as a code editor would be to support:

- html
- css
- js
- md
- yaml
- json

At least color highlighting, formatting isn't that important. The rest is plaintext.

## Context-Intellisense

What I want

- Intellisense on URLs
- autocomplete when writing new urls
- squiggly lines appearing dynamically to make suggestions, while editing.
- Little information snippet above like tokens

✅ See monacobro, make a tiny poc that has it all, then bring it to xytext with a good prompt

Imagine also highlighting insights on words that have meaning by caching the db query against my github and stuff. All of this is just so insanely cool!

## OAuth Login

- Need to login into lmpify
- Need to login into flaredream deploy
- Login into patch for github
- Login into github

Keep all this state in a logins-table belonging to the user.

## Terminal or other way to perform actions

I need to be able to do arbitrary file transformations to these files. For this, it's probably best to allow any other tool access. For this we need this to be an oauth PROVIDER.

Main terminal things I do:

- run little scripts on fs
- git clone
- github patching (or git push)
- download all files
- test a curl

I can be creative in my solution, it doesn't need to 1:1 match the original git (as this can be hard). Even just having deployment is already extremely valuable.

Most actions seem to be APIs ran on a set of files, or a way to import new files. They all make working with files here easier, making everything more accessible, connecting xytext with the outside. Actions that don't have a direct relation to any files are probably better to be used elsewhere.

# History

Getting history of the actions I'm taking throughout the day would be immensely cool. xytext would be the first app i should do that for (`towards-full-observability-of-digital-workers.md`)

🤔 I may provide this data back into the file-system, appending a JSONL file or so (nah, that'd get too big). Think what would be the best way to track not just editing, but also any other file-operations / actions that might be able to be performed without text editor.

# Binary files

If I want to eventually clone repos inhere, having the ability to store binary files is needed.

- we may already be able to just put base64 in TEXT or add a BLOB column and use this for binary files. with this, files would go up to 2MB
- we'll need a blocks table setup connected to the nodes table for binary files over 2mb. less important as this shouldn't be there for most repos.

# Search (file-content search, path search)

- path search is quite easily added to the explorer, it can just be fully local. that said, it makes sense to have an uithub-like api too for this
- for file content search, I'd be entering uithub territory - i'd want that to be an api for sure so agents can use it too.

## Bookmarking context (old idea)

Bookmark contexts: separate interface that I can just embed as js that allows adding contexts that I bookmark.

- Adds button 🔖 to topleft which opens/closes bookmarks sidepanel
- loads in all bookmarks through context.contextarea.com and renders in nice way showing url, title, tokens, og, may be a bit bigger
- button on every bookmark to remove bookmark or use
- also shows current textarea value ones on top with ability to bookmark
- search on top that searches over titles and urls

The state of bookmark contexts is just a flat list of urls and we can use localStorage to store that as `string[]`. Great thing about it is that we use the already authenticated api of context to expand it into something useful. The UI could just make it possible to send this `string[]` over to a predictable URL that is x-authorized, e.g. https://bookmarks.contextarea.com/janwilmake. This can be done by just using pastebin, then using https://bookmarks.contextarea.com/publish?url={url}. This would authenticate, then set the value, making it shareable everybody.

The 'personal context base' should be available publicly as well! this in turn allows turning this into a simple fetch mcp to gather a context prompt!

This `contextbuilding` component has loads of usecases so generally a live DO to render information dynamically is super dope. Let's start with markdown and rendering this in different ways

- https://letmeprompt.com/i-want-to-make-a-new-ce28o20
- initial design: https://letmeprompt.com/i-want-to-make-a-new-cke1710

This'd be super cool, combining several feeds into a live markdown document

- recent repos
- open stripe dashboard
- googllm seach
- recent tweets
- new prompt

It'd be great if i had a markdown syntax to easily build simple forms. Maybe, it makes most sense to use a regular URL with empty query params. This signals they need filling. Also GREAT for lmpify, btw.

# Towards full observability

Every day, im doing actions in the browser, vscode, and terminal. I have a few macos tools i use atop of these programs but that is 95%. im confident that if i can do vscode and the terminal in the browser - i can stop using macos and move to a browser-only OS, or i can just use safari only. I would never need to leave it.

however, then I'd still not be able to observe myself without having something for that

I COULD use my own apps only, and i'd be able to let the app itself observe me and give that information back to me, not using it for own interest. This removes the need to install any extensions and other client-dependent setup. This seems to be the most low-friction path if everyone would adopt it.

- https://x.com/janwilmake/status/1926690572099600500
- https://x.com/dread_numen/status/1930380519239496122
