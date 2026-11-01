# Rove MarkdownEdit

## Version number

- Every time you do a release build and there are uncommitted changes (check `git status`), increment the patch version first. Update it in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` (the build updates `Cargo.lock`).
- If the working tree is clean, build without changing the version.
