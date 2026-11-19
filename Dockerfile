# syntax=docker/dockerfile:1
# Multi-stage build: install deps (postinstall copies flag SVGs) then ship a
# slim runtime image running as the non-root `node` user.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# postinstall runs `node scripts/copy-flags.mjs` and populates public/flags/
RUN npm ci --omit=dev
COPY . .
# sanity: the server must at least parse
RUN node --check server/index.js

FROM node:20-alpine
USER node
WORKDIR /app
COPY --from=build --chown=node:node /app ./
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server/index.js"]
