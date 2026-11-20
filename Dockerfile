# syntax=docker/dockerfile:1
# Multi-stage build: install deps (postinstall copies flag SVGs) then ship a
# slim runtime image running as the non-root `node` user.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# postinstall is skipped here because scripts/ is not copied yet (it runs
# `node scripts/copy-flags.mjs`); the flags are copied explicitly after
# COPY . . below, so the build does not fail with MODULE_NOT_FOUND.
RUN npm ci --omit=dev --ignore-scripts
COPY . .
RUN node scripts/copy-flags.mjs
RUN node --check server/index.js

FROM node:20-alpine
USER node
WORKDIR /app
COPY --from=build --chown=node:node /app ./
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/healthz || exit 1
CMD ["node", "server/index.js"]
