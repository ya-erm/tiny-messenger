#!/bin/bash
set -eu

# Restore and inspection commands must also work with Messenger stopped.
if [ "${1:-}" != "replicate" ]; then
  exec /usr/local/bin/litestream "$@"
fi

# Docker's restart policy does not apply Compose depends_on ordering at boot.
# Leave SQLite unopened until Messenger has finished its startup migrations.
# Bash and timeout are included in the pinned Litestream image.
echo "Waiting for Messenger to finish startup before opening SQLite"
until timeout 5 /bin/bash -c '
  exec 3<>/dev/tcp/messenger/3000
  printf "GET /api/health HTTP/1.0\r\nHost: messenger\r\n\r\n" >&3
  IFS= read -r status <&3
  case "$status" in
    "HTTP/1.0 200 "*|"HTTP/1.1 200 "*) exit 0 ;;
    *) exit 1 ;;
  esac
' >/dev/null 2>&1; do
  sleep 2
done

echo "Messenger is ready; starting Litestream"
exec /usr/local/bin/litestream "$@"
