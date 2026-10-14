#!/bin/bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != --compare-sqlite ]; }; then
  echo 'Usage: bash scripts/run-telegram-backup.sh [--compare-sqlite]' >&2
  exit 1
fi
exec 9>/run/lock/tiny-messenger-telegram-backup.lock
flock -n 9 || { echo 'Backup already running'; exit 1; }
source deploy/release.env
secrets=${TELEGRAM_BACKUP_SECRETS:-/root/.config/tiny-messenger/telegram-backup.env}
test -r "$secrets"
test "$(stat -c %a "$secrets")" = 600
test -d "$MESSENGER_DEPENDENCIES_DIR"
# Keep a reserve for the app, Valheim and the remaining services.
available_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
test "$available_kb" -ge $((256 * 1024)) || { echo 'Backup refused: less than 256 MiB available'; exit 1; }
install -d -m 700 backups/telegram
control_dir=$(mktemp -d /run/lock/tiny-messenger-backup.XXXXXX)
cleanup() {
  status=$?
  trap - EXIT
  if [ -s "$control_dir/container" ]; then
    docker stop --time 10 "$(cat "$control_dir/container")" >/dev/null 2>&1 || true
  fi
  rm -rf "$control_dir"
  exit "$status"
}
trap cleanup EXIT
# Only use the already deployed official image and dependency directory.
# Read-only mounts include the live WAL/SHM; SQLite reads one transaction.
timeout --signal=TERM --kill-after=15s 600s docker run --rm --pull=never \
  --name tiny-messenger-telegram-backup --platform linux/amd64 \
  --cidfile "$control_dir/container" \
  --memory=128m --memory-swap=128m --cpus=0.25 --pids-limit=64 \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --tmpfs /tmp:size=16m --env-file "$secrets" \
  --env NODE_OPTIONS=--max-old-space-size=64 \
  --mount "type=bind,src=$(pwd)/data,dst=/data,readonly" \
  --mount "type=bind,src=$(pwd)/scripts,dst=/app/scripts,readonly" \
  --mount "type=bind,src=$MESSENGER_DEPENDENCIES_DIR,dst=/app/node_modules,readonly" \
  --mount "type=bind,src=$(pwd)/backups/telegram,dst=/backups" \
  --workdir /app "$MESSENGER_RUNTIME_IMAGE" node scripts/telegram-backup.mjs "$@"
