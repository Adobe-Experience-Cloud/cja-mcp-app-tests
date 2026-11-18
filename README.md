# cja-mcp-app-tests

Test widgets for MCP Apps on the Customer Journey Analytics MCP server. Each widget is a TypeScript and Chart.js module that renders inside the sandboxed iframe an MCP host (such as claude.ai) opens when a tool with a UI is called.

The UI is deployed independently of the MCP server. The server's `ui://` resource is a thin HTML shell with one module script, and that script points at this project's published bundle. Pushing to `main` builds the bundle and publishes it to GitHub Pages:

```
https://adobe-experience-cloud.github.io/cja-mcp-app-tests/run-visual-report.js
```

The bundle contains rendering code only. Report data reaches the widget through the MCP host's tool result, never from this site.

## Widgets

| File | Tool | What it draws |
|---|---|---|
| `run-visual-report.js` | `runVisualReport` | Line chart for time dimensions, bar chart otherwise |

## How it works

```
MCP host ──MCP──> CJA MCP server
  │                  ├─ tools/call runVisualReport           -> report JSON (structuredContent)
  │                  └─ resources/read ui://cja-mcp/run-visual-report -> HTML shell
  ▼
sandboxed iframe
  └─ <script type="module" src="https://adobe-experience-cloud.github.io/cja-mcp-app-tests/run-visual-report.js">
```

The resource's `_meta.ui.csp` allows only this site's origin. GitHub Pages sends `Access-Control-Allow-Origin: *`, which module scripts need when loaded cross-origin.

## Development

```bash
cd ui-src
npm install
npm run dev        # Vite dev server on 5174, serves /src/run-visual-report.ts
npm run build      # dist/run-visual-report.js, one file with CSS included
npm run typecheck
```

## Version tag

The widget footer shows the version from `ui-src/package.json`, so you can tell which deploy the iframe loaded. `0.1.0` shows as `v0.1` while in development; set it to `1.0.0` for `v1`.

GitHub Pages caches files for up to 10 minutes, so a new deploy can take that long to reach the iframe.
