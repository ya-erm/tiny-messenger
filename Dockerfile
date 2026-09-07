FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# better-sqlite3 is a native module; prebuilt binaries cover glibc and musl,
# the toolchain is only a fallback in case a prebuild is missing.
FROM base AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS prod-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME="0.0.0.0"
ENV PORT=3000
ENV DATABASE_URL="file:/app/data/messenger.db"
ENV MESSENGER_REALTIME_FILE="/app/data/realtime.json"

RUN apk add --no-cache su-exec \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs \
  && mkdir -p /app/data \
  && chown nextjs:nodejs /app/data

COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/next.config.ts ./next.config.ts
# Migrations run at container start (docker-entrypoint.sh) and need the
# schema, the migration history and the config that resolves DATABASE_URL.
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/database-url.ts ./src/lib/database-url.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/ws-gateway.mjs ./scripts/ws-gateway.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/realtime-service.mjs ./scripts/realtime-service.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/server.mjs ./scripts/server.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/import-json-store.mjs ./scripts/import-json-store.mjs
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "scripts/server.mjs"]
