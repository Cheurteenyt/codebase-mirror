# Simple Dockerfile for Codebase Memory V2
# Tests basic Docker build + CLI + non-root

FROM node:20 AS builder
WORKDIR /app
COPY v2/package.json v2/package-lock.json ./
RUN npm ci
COPY v2/ ./
RUN npm run build
RUN npm prune --omit=dev

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
