# syntax=docker/dockerfile:1.7
# Production images for the web app, API, and worker. Build from the repository root:
#   docker compose -f deploy/compose.yaml build
# Node 22 LTS (Node 20 reached end of life in April 2026).
ARG NODE_IMAGE=node:22-bookworm-slim

# ---- Dependencies (all workspaces, including build tools) ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
RUN npm ci --no-audit --no-fund

# ---- Compile shared packages, API, and worker ----
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build:packages \
  && npm run build --workspace @venture-studio/api \
  && npm run build --workspace @venture-studio/worker

# ---- Next.js standalone build ----
# The API address is baked into the /v1, /api/auth and /socket.io rewrites at build time.
FROM build AS web-build
ARG VSO_API_ORIGIN=http://api:4000
ARG NEXT_PUBLIC_ENABLE_DEMO=false
ENV NODE_ENV=production \
    VSO_NEXT_OUTPUT=standalone \
    VSO_API_ORIGIN=${VSO_API_ORIGIN} \
    NEXT_PUBLIC_ENABLE_DEMO=${NEXT_PUBLIC_ENABLE_DEMO} \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build --workspace @venture-studio/web

# ---- Runtime dependencies only (shared by the API and worker images) ----
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- API ----
FROM prod-deps AS api
ENV NODE_ENV=production
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/apps/api/dist apps/api/dist
WORKDIR /app/apps/api
USER node
EXPOSE 4000
CMD ["node", "dist/src/server.js"]

# ---- Worker (reminders, email, push) ----
FROM prod-deps AS worker
ENV NODE_ENV=production
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
WORKDIR /app/apps/worker
USER node
CMD ["node", "dist/src/index.js"]

# ---- Web ----
FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=web-build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
