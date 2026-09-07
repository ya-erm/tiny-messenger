#!/bin/sh
set -eu

mkdir -p /app/data
chown -R nextjs:nodejs /app/data

# Bring the SQLite schema up to date before the app opens it. Only applies
# migrations that have not run yet; a no-op on every later start.
su-exec nextjs:nodejs node_modules/.bin/prisma migrate deploy

exec su-exec nextjs:nodejs "$@"
