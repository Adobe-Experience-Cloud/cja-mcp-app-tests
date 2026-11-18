import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

// The CJA MCP server's ui:// resource is a thin HTML shell with a single
// module script. That script is either:
//   * dev:   <vite dev server>/src/run-visual-report.ts (through ngrok), or
//   * built: <GitHub Pages site>/run-visual-report.js (this project's `vite build`).
// The MCP host renders the widget in a sandboxed iframe on its own origin
// (claude.ai uses *.claudemcpcontent.com), so every request is cross-origin.
export default defineConfig({
  // Bump "version" in package.json to change the tag shown in the widget footer.
  define: { __WIDGET_VERSION__: JSON.stringify(pkg.version) },
  server: {
    port: 5174,
    strictPort: true,
    cors: true,
    allowedHosts: true,
  },
  build: {
    target: "es2022", // top-level await (await app.connect())
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: "src/run-visual-report.ts",
      output: {
        // Stable, unhashed name: the server's shell references it directly.
        entryFileNames: "run-visual-report.js",
        inlineDynamicImports: true,
      },
    },
  },
});
