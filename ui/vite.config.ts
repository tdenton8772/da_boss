import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
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
