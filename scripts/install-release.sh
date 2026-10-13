#!/bin/bash
set -euo pipefail

# Run on the VPS after uploading artifacts. No install or build runs here.
cd "$(dirname "$0")/.."
artifact_dir=$(cd "${1:?Usage: bash scripts/install-release.sh ARTIFACT_DIRECTORY}" && pwd)
revision=$(cat "$artifact_dir/revision")
dependencies_key=$(cat "$artifact_dir/dependencies-key")
runtime_image=$(cat "$artifact_dir/runtime-image")
[[ "$revision" =~ ^[a-f0-9]{40}$ && "$dependencies_key" =~ ^[a-f0-9]{64}$ ]] || exit 1
[[ "$runtime_image" =~ ^node@sha256:[a-f0-9]{64}$ ]] || exit 1
for file in app.tar.gz runtime-image dependencies-key revision SHA256SUMS; do
  test -f "$artifact_dir/$file"
done
# A replacement frees the old app's resident memory. Leave room for other
# services even when the new app reaches its hard 384 MiB container limit.
available_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
project=${COMPOSE_PROJECT_NAME:-$(basename "$(pwd)")}
old_id=$(docker ps -q --filter label=com.docker.compose.service=messenger --filter "label=com.docker.compose.project=$project")
old_rss_kb=0
if [ -n "$old_id" ]; then
  for old_pid in $(docker top "$old_id" -eo pid | awk 'NR > 1 {print $1}'); do
    rss=$(awk '/^VmRSS:/ {print $2}' "/proc/$old_pid/status" 2>/dev/null || true)
    old_rss_kb=$((old_rss_kb + ${rss:-0}))
  done
fi
required_kb=$(((384 + ${DEPLOY_RESERVE_MB:-128}) * 1024))
if [ "$((available_kb + old_rss_kb))" -lt "$required_kb" ]; then
  echo "Deploy refused: available $((available_kb / 1024)) MiB + old app $((old_rss_kb / 1024)) MiB; need $((required_kb / 1024)) MiB. Running container unchanged." >&2
  exit 1
fi
(cd "$artifact_dir" && sha256sum --check --ignore-missing SHA256SUMS)
dependencies_dir="$(pwd)/releases/dependencies/$dependencies_key"
if [ ! -f "$dependencies_dir/.complete" ]; then
  test -f "$artifact_dir/dependencies.tar.gz"
  mkdir -p "$dependencies_dir"
  tar -xzf "$artifact_dir/dependencies.tar.gz" -C "$dependencies_dir"
  chmod -R a+rX "$dependencies_dir"
  touch "$dependencies_dir/.complete"
fi
app_checksum=$(sha256sum "$artifact_dir/app.tar.gz" | cut -d ' ' -f 1)
release_dir="$(pwd)/releases/$revision-${app_checksum:0:12}"
if [ ! -f "$release_dir/.complete" ]; then
  mkdir -p "$release_dir"
  tar -xzf "$artifact_dir/app.tar.gz" -C "$release_dir"
  mkdir -p "$release_dir/node_modules" "$release_dir/data" "$release_dir/.next/cache"
  chmod -R a+rX "$release_dir"
  touch "$release_dir/.complete"
fi
test -r "$release_dir/.next/BUILD_ID"
test -r "$dependencies_dir/node_modules/.bin/prisma"
docker image inspect "$runtime_image" >/dev/null 2>&1 || docker pull --platform linux/amd64 "$runtime_image"
test -d data || { mkdir data; chown 1001:1001 data; }
test "$(stat -c %u data)" = 1001 || { echo "data/ must be owned by uid 1001" >&2; exit 1; }
mkdir -p deploy
printf 'MESSENGER_RUNTIME_IMAGE=%s\nMESSENGER_RELEASE_DIR=%s\nMESSENGER_DEPENDENCIES_DIR=%s\n' \
  "$runtime_image" "$release_dir" "$dependencies_dir/node_modules" > deploy/release.env.next
if [ -f deploy/release.env ] && ! cmp -s deploy/release.env deploy/release.env.next; then
  cp deploy/release.env deploy/release.env.previous
fi
mv deploy/release.env.next deploy/release.env
compose() { docker compose -p "$project" --env-file .env --env-file deploy/release.env "$@"; }
rollback() {
  if [ -f deploy/release.env.previous ]; then
    cp deploy/release.env.previous deploy/release.env
    compose up -d --no-build --no-deps messenger
    echo "Previous release restored; check its health." >&2
  elif [ -f releases/legacy-compose.yml ]; then
    docker compose -p "$project" -f releases/legacy-compose.yml up -d --no-build --no-deps messenger
    rm -f deploy/release.env
    echo "Previous image restored; check its health." >&2
  fi
}
if ! compose up -d --no-build --no-deps messenger; then
  rollback
  exit 1
fi
for attempt in {1..18}; do
  id=$(compose ps -q messenger)
  if [ -n "$id" ] && [ "$(docker inspect "$id" --format '{{.State.Health.Status}}')" = healthy ]; then
    echo "Release $revision is healthy. Only Messenger was recreated."
    exit 0
  fi
  sleep 5
done
echo "New release failed health checks." >&2
rollback
exit 1
