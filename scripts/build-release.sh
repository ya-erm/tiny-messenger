#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."
revision=$(git rev-parse HEAD)
if ! git diff --quiet HEAD --; then
  echo "Commit tracked changes before building a release." >&2
  exit 1
fi
memory_mb=${BUILD_MEMORY_MB:-1536}
cpus=${BUILD_CPUS:-1}
runtime_tag=${RUNTIME_IMAGE:-node:22-bookworm-slim}
[[ "$memory_mb" =~ ^[1-9][0-9]*$ && "$cpus" =~ ^[0-9]+([.][0-9]+)?$ ]] || exit 1
docker image inspect "$runtime_tag" >/dev/null 2>&1 || docker pull --platform linux/amd64 "$runtime_tag"
runtime_image=$(docker image inspect "$runtime_tag" --format '{{index .RepoDigests 0}}')
available_kb=$(docker run --rm --platform linux/amd64 --network none --memory 16m --cpus 0.1 \
  --entrypoint sh "$runtime_image" -c "awk '/^MemAvailable:/ {print \$2}' /proc/meminfo")
if [ "$available_kb" -lt "$(((memory_mb + 256) * 1024))" ]; then
  echo "Build refused: insufficient available Docker VM memory, including 256 MiB reserve." >&2
  exit 1
fi
node_version=$(docker run --rm --platform linux/amd64 --network none --memory 32m --cpus 0.1 "$runtime_image" node -p process.versions.node)
build_tag="node:${node_version}-bookworm"
docker image inspect "$build_tag" >/dev/null 2>&1 || docker pull --platform linux/amd64 "$build_tag"
build_image=$(docker image inspect "$build_tag" --format '{{index .RepoDigests 0}}')
dependencies_key=$({ git show HEAD:pnpm-lock.yaml; printf '%s\n' "$runtime_image" "$build_image" linux/amd64; } | shasum -a 256 | cut -d ' ' -f 1)
output="$(pwd)/releases/artifacts/$revision"
dependencies="$(pwd)/releases/artifacts/dependencies/$dependencies_key.tar.gz"
mkdir -p "$output" "$(dirname "$dependencies")"
work=$(mktemp -d)
container="tm-release-build-$$"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git archive HEAD -o "$work/source.tar"
package_dependencies=0
[ -f "$dependencies" ] || package_dependencies=1
docker volume create "tm-dependencies-$dependencies_key" >/dev/null
echo "Local Linux build: ${memory_mb} MiB RAM, ${cpus} CPU, no swap; official Node ${node_version}."
docker create --name "$container" --platform linux/amd64 \
  --memory "${memory_mb}m" --memory-swap "${memory_mb}m" --cpus "$cpus" \
  --workdir /app --mount "type=volume,src=tm-dependencies-$dependencies_key,dst=/app/node_modules" \
  --env NODE_OPTIONS=--max-old-space-size=768 --env NEXT_TELEMETRY_DISABLED=1 \
  --env "PACKAGE_DEPENDENCIES=$package_dependencies" "$build_image" \
  sh -c 'tar -xf /tmp/source.tar -C /app && sh scripts/build-in-container.sh' >/dev/null
docker cp "$work/source.tar" "$container:/tmp/source.tar"
docker start -a "$container"
test "$(docker inspect "$container" --format '{{.State.ExitCode}}')" = 0
docker cp "$container:/artifacts/app.tar.gz" "$output/app.tar.gz"
if [ "$package_dependencies" = 1 ]; then
  docker cp "$container:/artifacts/dependencies.tar.gz" "$dependencies"
fi
cp "$dependencies" "$output/dependencies.tar.gz"
printf '%s\n' "$runtime_image" > "$output/runtime-image"
printf '%s\n' "$dependencies_key" > "$output/dependencies-key"
printf '%s\n' "$revision" > "$output/revision"
(cd "$output" && shasum -a 256 app.tar.gz dependencies.tar.gz runtime-image dependencies-key revision > SHA256SUMS)
echo "Release ready: $output"
