import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icon-192.png", "icon-512.png"],
      manifest: {
        name: "Aura",
        short_name: "Aura",
        description: "One-tap migraine tracker",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
        // Long-press the installed icon to log without opening and navigating.
        // The app consumes ?action=start on load, so this is one long-press + one tap.
        // (Premonition has no shortcut yet: its outbox sync can double-post when a
        // reconcile races on launch, which would corrupt the premonition dataset.)
        shortcuts: [
          {
            name: "Log migraine",
            short_name: "Migraine",
            description: "Start a migraine now",
            url: "/?action=start",
            icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api/],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: { "@": new URL("./src/client", import.meta.url).pathname },
  },
  build: { outDir: "dist/client", emptyOutDir: true },
  // In dev, `vite` serves the client and proxies API calls to `wrangler dev` (8787).
  server: { proxy: { "/api": "http://localhost:8787" } },
});
