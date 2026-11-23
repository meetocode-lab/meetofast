# syntax=docker/dockerfile:1

# ==============================================================================
# Stage 1: Dependencies & Workspace Build
# ==============================================================================
FROM node:24-bookworm-slim AS builder

WORKDIR /app

COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/cli/package.json ./packages/cli/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

RUN npm install

COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/cli ./packages/cli
COPY apps/api ./apps/api
COPY apps/web ./apps/web

RUN npm run build --workspace=@meofast/shared \
  && npm run build --workspace=@meofast/cli \
  && npm run build --workspace=@meofast/api \
  && npm run build --workspace=@meofast/web

# ==============================================================================
# Target: api (Hono Modular Monolith + Kysely Multi-DB)
# ==============================================================================
FROM node:24-bookworm-slim AS api

WORKDIR /app
ENV NODE_ENV=production
ENV API_PORT=4781
ENV MEOFAST_DATA_DIR=/app/data

RUN mkdir -p /app/data && chown -R node:node /app

COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder --chown=node:node /app/apps/api/dist ./apps/api/dist

USER node
EXPOSE 4781

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4781/api/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/api/dist/index.js"]

# ==============================================================================
# Target: web (Next.js App Router + Blue Aurora UI)
# ==============================================================================
FROM node:24-bookworm-slim AS web

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4780
ENV HOSTNAME=0.0.0.0
ENV INTERNAL_API_URL=http://api:4781

COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=node:node /app/apps/web/package.json ./apps/web/package.json
COPY --from=builder --chown=node:node /app/apps/web/.next ./apps/web/.next
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=node:node /app/apps/web/next.config.ts ./apps/web/next.config.ts

USER node
EXPOSE 4780

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4780/api/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "run", "start", "--workspace=@meofast/web"]
