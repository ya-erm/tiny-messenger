#!/bin/sh
set -eu

# Invoked only by build-release.sh inside the official Linux Node image.
if [ ! -f node_modules/.release-dependencies-ready ]; then
  corepack pnpm install --frozen-lockfile
  touch node_modules/.release-dependencies-ready
fi
corepack pnpm build
mkdir -p /artifacts
tar --exclude=.next/cache --exclude=.next/dev --exclude='*.tsbuildinfo' \
  -czf /artifacts/app.tar.gz .next public package.json next.config.ts \
  prisma prisma.config.ts src/lib/database-url.ts scripts docker-entrypoint.sh
if [ "$PACKAGE_DEPENDENCIES" = 1 ]; then
  tar -czf /artifacts/dependencies.tar.gz node_modules
fi
