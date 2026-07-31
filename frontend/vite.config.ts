import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4173,
    proxy: {
      "/api-local": {
        target: "http://127.0.0.1:17300",
        changeOrigin: true,
      },
      "/api-online": {
        target: "http://127.0.0.1:17300",
        changeOrigin: true,
      },
      "/api": {
        target: "http://127.0.0.1:17300",
        changeOrigin: true,
      },
      "/health": {
        target: "http://127.0.0.1:17300",
        changeOrigin: true,
      },
    },
  },
});
