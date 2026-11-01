# Rove MarkdownEdit

## Version number

- On Windows, increment the patch version before a release build if there are uncommitted changes (see `AGENTS.md`). Update it in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` (the build updates `Cargo.lock`).
- On Mac, never change the version for a release build.

## Rebuilding the release exe (Windows)

- Build with `npm run tauri build -- --no-bundle`. Don't build the installer.
- You are always allowed to close a running `rove-markdownedit.exe` (Windows locks the exe while it runs), rebuild, and start it again afterwards. Close it gracefully (e.g. `CloseMainWindow()`) so it saves the open file.
- After changing the icon (`npx tauri icon app-icon.png`), delete `src-tauri/target/release/build/rove-markdownedit-*` before building; otherwise cargo keeps the old icon embedded in the exe.
- The Start menu shortcut and the `.md` association point at `src-tauri/target/release/rove-markdownedit.exe` (set up by `scripts/register.ps1`), so a rebuild is all that's needed.

## Rebuilding the release app (Mac)

- Build with `npm run tauri build -- --bundles app`. This builds only the `.app` (no DMG); the `.md` association needs the bundle's Info.plist.
- The app is written to `src-tauri/target/release/bundle/macos/Rove MarkdownEdit.app`. The `Rove MarkdownEdit.app` symlink in the repo root and the `.md`/`.markdown` association point there, so a rebuild is all that's needed.
- Quit the running app before rebuilding (e.g. `osascript -e 'quit app "Rove MarkdownEdit"'`) so it saves the open file, and start it again afterwards.
