# XYTerm - Terminal Client for Agent Pod

A powerful terminal interface for your Agent Pod files with split views, full file system commands, and real-time collaboration.

## Features

- **Split Views**: Add unlimited horizontal terminal splits
- **Full File System Commands**: ls, cd, cat, mkdir, touch, rm, cp, mv, grep, find, tree, and more
- **Tab Completion**: Press Tab to autocomplete file and folder names
- **Command History**: Use up/down arrows to navigate through command history
- **Dark Theme**: Easy on the eyes terminal interface
- **Real-time Sync**: Changes sync with Agent Pod server

## Supported Commands

| Command                   | Description                   |
| ------------------------- | ----------------------------- |
| `ls [-la] [path]`         | List directory contents       |
| `cd <path>`               | Change directory              |
| `pwd`                     | Print working directory       |
| `cat <file>`              | Display file contents         |
| `head [-n N] <file>`      | Show first N lines            |
| `tail [-n N] <file>`      | Show last N lines             |
| `mkdir <name>`            | Create directory              |
| `touch <name>`            | Create empty file             |
| `rm [-r] <path>`          | Remove file or directory      |
| `cp <src> <dest>`         | Copy file or directory        |
| `mv <src> <dest>`         | Move/rename file or directory |
| `find <pattern>`          | Find files matching pattern   |
| `grep <pattern> <file>`   | Search for pattern in file    |
| `wc <file>`               | Count lines, words, chars     |
| `tree [path]`             | Show directory tree           |
| `stat <path>`             | Show file information         |
| `write <file> <content>`  | Write content to file         |
| `append <file> <content>` | Append content to file        |
| `echo <text>`             | Print text                    |
| `whoami`                  | Show current user             |
| `date`                    | Show current date/time        |
| `history`                 | Show command history          |
| `clear`                   | Clear terminal                |
| `exit`                    | Close terminal                |

## Keyboard Shortcuts

- `Ctrl+Shift+N` - New terminal split
- `Ctrl+L` - Clear terminal
- `Ctrl+C` - Cancel current input
- `Tab` - Autocomplete
- `↑/↓` - Navigate command history

## Setup

1. Create a KV namespace in Cloudflare
2. Update `wrangler.json` with your KV namespace ID
3. Deploy: `npm run deploy`

## Authentication

Uses OAuth 2.0 with Agent Pod. Your app's hostname serves as the client_id.

## License

MIT
