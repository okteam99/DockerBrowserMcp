FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.64.1-noble
ENV NODE_ENV=production DATA_DIR=/data MCP_SOCKET=/tmp/browser-mcp/service.sock WEB_PORT=8080
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --from=build --chown=pwuser:pwuser /app/dist ./dist
COPY --chown=pwuser:pwuser package.json README.md ./
COPY --chown=pwuser:pwuser docs ./docs
RUN mkdir -p /data /config /tmp/browser-mcp && chown -R pwuser:pwuser /data /config /tmp/browser-mcp
USER pwuser
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD ["node", "dist/cli.js", "health"]
CMD ["node", "dist/cli.js", "daemon"]
