import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Base path the app is served under. Root by default (local/kind); the GKE image
// is built with VITE_BASE=/daboss/ so it lives at app-stg…/daboss. Everything
// browser-facing (assets, router, API, WS) derives from import.meta.env.BASE_URL.
export default defineConfig({
  base: process.env.VITE_BASE || "/",
  plugins: [react(), tailwindcss()],
  server: {
    port: 3848,
    proxy: {
      "/api": "http://localhost:3847",
      "/ws": {
        target: "http://localhost:3847",
        ws: true,
      },
    },
  },
});
