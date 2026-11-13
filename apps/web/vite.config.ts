import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    fs: { allow: ["../.."] },
    // The deployed site serves /api from the same Worker; `pnpm dev:api` runs it locally.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
  build: {
    target: "es2023",
  },
});
