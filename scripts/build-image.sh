#!/bin/sh
set -eu

repo_dir=${REPO_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
image=${1:-tiny-messenger-messenger:latest}
memory_mb=${BUILD_MEMORY_MB:-1024}
cpu_quota=${BUILD_CPU_QUOTA:-50000}
reserve_mb=${BUILD_RESERVE_MB:-512}

for value in "$memory_mb" "$cpu_quota" "$reserve_mb"; do
  case "$value" in
    ''|*[!0-9]*) echo "Build limits must be positive integers" >&2; exit 1 ;;
  esac
  if [ "$value" -eq 0 ]; then
    echo "Build limits must be positive integers" >&2
    exit 1
  fi
done

# On Linux this script is intended to run on the Docker host itself. A Mac
# uses a Docker VM, so query that VM rather than the Mac's available memory.
if [ -r /proc/meminfo ]; then
  available_kb=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)
else
  available_kb=$(docker run --rm --network none --memory 32m --cpus 0.1 \
    --entrypoint /bin/sh node:22-alpine \
    -c "awk '/^MemAvailable:/ { print \$2 }' /proc/meminfo")
fi
case "$available_kb" in
  ''|*[!0-9]*) echo "Cannot determine available Docker host memory" >&2; exit 1 ;;
esac
required_kb=$(((memory_mb + reserve_mb) * 1024))
if [ "$available_kb" -lt "$required_kb" ]; then
  echo "Build refused: available $((available_kb / 1024)) MiB, required $((required_kb / 1024)) MiB including reserve. No builder started." >&2
  exit 1
fi

builder="tiny-messenger-build-$$"
cleanup() {
  docker buildx rm "$builder" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

echo "Build limits: ${memory_mb} MiB RAM, no swap, CPU quota ${cpu_quota}/100000, one build stage at a time."
docker buildx create --name "$builder" --driver docker-container \
  --driver-opt "memory=${memory_mb}m,memory-swap=${memory_mb}m,cpu-period=100000,cpu-quota=${cpu_quota},cpu-shares=128" \
  --buildkitd-config "$repo_dir/deploy/buildkitd.toml"
docker buildx build --builder "$builder" --load --progress plain \
  --tag "$image" "$repo_dir"
