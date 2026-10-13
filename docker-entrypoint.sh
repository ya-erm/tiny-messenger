#!/bin/sh
set -eu

mkdir -p /app/data
test -r /app/.next/BUILD_ID || { echo "Missing compiled release" >&2; exit 1; }
test -w /app/data || { echo "Data directory must be writable by uid 1001" >&2; exit 1; }

# Bring the SQLite schema up to date before the app opens it. Only applies
# migrations that have not run yet; a no-op on every later start. Litestream
# may briefly hold SQLite's write lock when both containers restart together,
# so retry the migration check before letting Docker restart the whole service.
migration_attempt=1
migration_attempts=6

until node_modules/.bin/prisma migrate deploy; do
  if [ "$migration_attempt" -ge "$migration_attempts" ]; then
    echo "Prisma migrations failed after $migration_attempts attempts" >&2
    exit 1
  fi

  migration_attempt=$((migration_attempt + 1))
  echo "Prisma migrations failed; retrying in 5 seconds (attempt $migration_attempt/$migration_attempts)" >&2
  sleep 5
done

exec "$@"
