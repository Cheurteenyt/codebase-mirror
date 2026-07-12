# Dockerfile for Codebase Memory V2
# Provides a containerized cbm-v2 CLI + MCP server + Graph UI.

# ── Stage 1: Build graph-ui ────────────────────────────────────────
FROM node:20-slim AS ui-builder
WORKDIR /graph-ui
COPY graph-ui/package.json graph-ui/package-lock.json ./
RUN npm ci
COPY graph-ui/ ./
RUN npm run build

# ── Stage 2: Build v2 backend ──────────────────────────────────────
# node:20 (full) includes build tools for native modules (better-sqlite3)
FROM node:20 AS builder
WORKDIR /app
COPY v2/package.json v2/package-lock.json ./
RUN npm ci
COPY v2/ ./
RUN npm run build
COPY --from=ui-builder /graph-ui/dist ./dist/ui
# Prune to production deps for runtime
RUN npm ci --omit=dev && npm cache clean --force

# ── Stage 3: Runtime (no build tools needed) ───────────────────────
FROM node:20-slim AS runtime
WORKDIR /app
COPY v2/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
RUN useradd -m -u 1000 cbm \
 && mkdir -p /home/cbm/.cache/codebase-memory-mcp \
 && chown -R cbm:cbm /home/cbm/.cache
USER cbm
VOLUME ["/home/cbm/.cache/codebase-memory-mcp"]
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["--help"]
LABEL org.opencontainers.image.title="Codebase Memory V2"
LABEL org.opencontainers.image.description="Codebase Memory V2 — hybrid code intelligence (native WASM indexer + human memory graph + Obsidian sync + Graph UI)"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/Cheurteenyt/codebase-mirror"
