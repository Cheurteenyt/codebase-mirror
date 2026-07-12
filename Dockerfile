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
FROM node:20-slim AS builder

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY v2/package.json v2/package-lock.json ./
RUN npm ci

COPY v2/ ./
RUN npm run build

# Copy graph-ui dist into v2/dist/ui
COPY --from=ui-builder /graph-ui/dist ./dist/ui

# ── Stage 3: Runtime ───────────────────────────────────────────────
FROM node:20-slim AS runtime

# Install build tools for native modules in production
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY v2/package.json v2/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Remove build tools after native modules are compiled
RUN apt-get purge -y python3 make g++ && apt-get autoremove -y

# Copy built files from builder (includes dist/ui from graph-ui)
COPY --from=builder /app/dist ./dist

# Create non-root user and cache directory
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
