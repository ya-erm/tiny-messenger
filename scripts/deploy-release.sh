#!/bin/bash
set -euo pipefail

host=${1:?Usage: bash scripts/deploy-release.sh HOST REMOTE_REPO ARTIFACT_DIRECTORY}
remote_repo=${2:?Missing remote repository directory}
artifact_dir=$(cd "${3:?Missing artifact directory}" && pwd)
[[ "$host" =~ ^[a-zA-Z0-9@._-]+$ && "$remote_repo" =~ ^/[a-zA-Z0-9/_-]+$ ]] || exit 1
revision=$(cat "$artifact_dir/revision")
dependencies_key=$(cat "$artifact_dir/dependencies-key")
[[ "$revision" =~ ^[a-f0-9]{40}$ && "$dependencies_key" =~ ^[a-f0-9]{64}$ ]] || exit 1
incoming="$remote_repo/releases/incoming/$revision"
ssh_options=(-o BatchMode=yes -o ConnectTimeout=15 -o ControlPath=none)
# Preserve the old generated Compose config before the first migration to
# bind-mounted releases. It contains secrets and stays on the server only.
ssh "${ssh_options[@]}" "$host" "cd '$remote_repo' && git diff --quiet HEAD -- && mkdir -p '$incoming' && if [ ! -f deploy/release.env ] && [ ! -f releases/legacy-compose.yml ]; then umask 077; docker compose config > releases/legacy-compose.yml; fi"
scp "${ssh_options[@]}" "$artifact_dir/"{app.tar.gz,runtime-image,dependencies-key,revision,SHA256SUMS} "$host:$incoming/"
if ! ssh "${ssh_options[@]}" "$host" "test -f '$remote_repo/releases/dependencies/$dependencies_key/.complete'"; then
  scp "${ssh_options[@]}" "$artifact_dir/dependencies.tar.gz" "$host:$incoming/"
fi
ssh "${ssh_options[@]}" "$host" "cd '$remote_repo' && git pull --ff-only && test \"\$(git rev-parse HEAD)\" = '$revision' && bash scripts/install-release.sh '$incoming'"
