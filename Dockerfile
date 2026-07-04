# Dockerfile for Codebase Memory V2
# Provides a containerized cbm-v2 CLI + MCP server.

FROM node:20-slim AS builder

WORKDIR /app

# Copy package files and install dependencies
COPY v2/package.json v2/package-lock.json* ./
RUN npm ci

# Copy source and build
COPY v2/ ./
RUN npm run build

# ── Runtime image ──────────────────────────────────────────────────
FROM node:20-slim AS runtime

WORKDIR /app

# Install only production dependencies
COPY v2/package.json v2/package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Create a volume for the cache directory (SQLite DBs)
VOLUME ["/root/.cache/codebase-memory-mcp"]

# Default entrypoint — can be overridden for MCP mode
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["--help"]

# Labels for metadata
LABEL org.opencontainers.image.title="Codebase Memory V2"
LABEL org.opencontainers.image.description="Human memory graph + Obsidian sync for Codebase Memory MCP"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://gitlab.com/cheurteen1/cheurteen-project"
