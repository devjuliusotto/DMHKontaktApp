import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 4000,
    strictPort: true,
    watch: {
      // Rust owns this directory and locks its DLLs while compiling. Tauri
      // watches Rust sources itself, so Vite must not attempt to watch it.
      ignored: ["**/src-tauri/target/**", "**/src-tauri/target-dev/**"]
    }
  },
  envPrefix: ["VITE_", "TAURI_"],
  worker: {
    format: "es"
  },
  build: {
    target: process.env.TAURI_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_DEBUG,
    sourcemap: !!process.env.TAURI_DEBUG
  }
});
