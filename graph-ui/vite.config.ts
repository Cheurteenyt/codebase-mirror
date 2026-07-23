import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:9749",
      // R26 (Bug #2 fix): proxy WebSocket connections to the backend.
      // Without this, useWebSocket tries to connect to localhost:5173 (Vite)
      // instead of localhost:9749 (UiServer), and real-time updates never work.
      // The `ws: true` flag tells Vite to upgrade HTTP to WebSocket.
      "/ws": {
        target: "ws://127.0.0.1:9749",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    // Match the TypeScript contract and the Chromium-family local runtime.
    // Avoid downlevelling modern syntax into larger helper expressions.
    target: "es2022",
    // Terser costs a small amount of build time but materially reduces the
    // transferred graph and manifest bytes. Multiple compression passes keep
    // dependency patch growth from consuming the production safety margin.
    minify: "terser",
    terserOptions: {
      compress: {
        passes: 2,
      },
      format: {
        comments: false,
      },
    },
    sourcemap: true,
    rollupOptions: {
      output: {
        // d3's force stack changes far less often than the Graph UI. Keeping it
        // in a stable async vendor chunk improves repeat-load caching while the
        // manifest-wide budget still accounts for every transferred byte.
        manualChunks(id) {
          if (id.includes("/node_modules/d3-")) return "graph-d3";
          if (
            id.endsWith("/src/lib/graph-stellar-layout.ts")
            || id.endsWith("/src/lib/graph-visual-mode.ts")
          ) return "graph-stellar";
        },
      },
    },
    // Bundle budgets resolve real entry and dynamic-entry assets from this
    // manifest instead of guessing from hash-prefixed directory names.
    manifest: true,
  },
  // R44 (Part C): Vitest configuration. The dependencies (@testing-library/react,
  // @testing-library/jest-dom, jsdom, vitest) were already installed in package.json
  // but the test block was missing — so `npm test` found no tests and the C1
  // regression (useGraphData unmounting GraphCanvas on every WS refetch) hid
  // for 3 rounds with no way to catch it.
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    css: false, // don't process Tailwind CSS in tests (speeds up suite)
    // R46: restrict test discovery to this project's src/ so vitest doesn't
    // pick up backend tests from sibling work directories.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
