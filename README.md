# Rove MarkdownEdit

A Markdown editor built with Tauri 2, Vite and CodeMirror 6.

- **Outline tab**: every heading in the document. It updates as you type, and clicking a heading jumps to it.
- **Files tab**: recently opened files, newest first. Clicking one saves the current file and opens it.
- **Single instance**: opening a `.md` file while the app is running sends it to the open window. The window saves the current file and opens the new one.
- **Live formatting**: the markers of `code`, bold, italic, strikethrough and `<u>`underline`</u>` spans, and the ``` fences of code blocks, are hidden unless the cursor is inside. HTML entities such as `&rarr;` are drawn as their character, and typing `->` or `<-` turns into `&rarr;` or `&larr;`.
- **Spell check**: misspelled words you type get a wavy underline, but text that was already in the file or was pasted does not. Right-click an underlined word to pick a correction or add it to your dictionary. Code, URLs, acronyms and camelCase words are skipped.
- **Saving**: changes save automatically 1.5 s after you stop typing, and also when you switch files or close the window.

## Shortcuts

| Keys            | Action                                                  |
| --------------- | ------------------------------------------------------- |
| Ctrl+S          | Save                                                    |
| Ctrl+O          | Open…                                                   |
| Ctrl+N          | New file                                                |
| Ctrl+B          | Bold / unbold the selection or word                     |
| Ctrl+I          | Italicize / unitalicize the selection or word           |
| Ctrl+U          | Underline / ununderline the selection or word (`<u>`)   |
| Ctrl+1 … Ctrl+5 | Make the line a heading of that level (again to remove) |

## Development

```sh
npm install
npm run tauri dev      # run with hot reload
npm run tauri build    # release build + NSIS installer
```

To use the release build without an installer:

```sh
npm run tauri build -- --no-bundle
powershell -ExecutionPolicy Bypass -File scripts/register.ps1
```

`register.ps1` adds a Start menu shortcut to `src-tauri/target/release/rove-markdownedit.exe` and makes it the default app for `.md`/`.markdown` files for the current user. Close the app before rebuilding, because Windows locks the running exe.

The installer is written to `src-tauri/target/release/bundle/nsis/`. The installer registers the `.md`/`.markdown` file association, so `tauri dev` does not set it up.

The recent files list is stored in `%APPDATA%\com.rove.markdownedit\recent.json`, and words added to the dictionary in `dictionary.txt` in the same folder, one per line.
