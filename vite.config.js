import { defineConfig } from "vite";

// Tauri expects a fixed dev port and should not watch the Rust side.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2021",
  },
});
