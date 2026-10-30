# Rove MarkdownEdit

## Rebuilding the release exe

- Build with `npm run tauri build -- --no-bundle`. Don't build the installer.
- You are always allowed to close a running `rove-markdownedit.exe` (Windows locks the exe while it runs), rebuild, and start it again afterwards. Close it gracefully (e.g. `CloseMainWindow()`) so it saves the open file.
- After changing the icon (`npx tauri icon app-icon.png`), delete `src-tauri/target/release/build/rove-markdownedit-*` before building; otherwise cargo keeps the old icon embedded in the exe.
- The Start menu shortcut and the `.md` association point at `src-tauri/target/release/rove-markdownedit.exe` (set up by `scripts/register.ps1`), so a rebuild is all that's needed.
