# syntax=docker/dockerfile:1

# --- dependencies -----------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# `npm ci` when a lockfile is present, `npm install` otherwise, so the image
# builds from a fresh clone either way. Production deps only.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# --- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# wget is used by the compose healthcheck; tini reaps zombies and forwards
# SIGTERM so the graceful shutdown in server.js actually runs.
RUN apk add --no-cache tini wget

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY db ./db

USER node
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
