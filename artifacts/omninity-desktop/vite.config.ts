import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  base: "/omninity-desktop/",
  server: {
    host: "0.0.0.0",
    port: Number(process.env["PORT"] ?? 8099),
    strictPort: true,
    allowedHosts: true,
    hmr: false,
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
});
