#!/usr/bin/env bash
set -euo pipefail
# Publish to Docker Hub using existing Docker credentials, or a supplied token.
# Never prints passwords or tokens. Cross-platform images are pushed by buildx.
image='bdpgogoup/dockerbrowsermcp'
release_tz="${RELEASE_TZ:-Asia/Shanghai}"
tag="${RELEASE_TAG:-$(TZ="$release_tz" date +%Y%m%d%H%M%S)}"
platforms="${PLATFORMS:-linux/amd64,linux/arm64}"
builder="${BUILDER_NAME:-dockerbrowsermcp-release}"
dry_run=false
if [[ "${1:-}" == '--dry-run' ]]; then dry_run=true; shift; fi
if [[ $# -ne 0 || ! "$tag" =~ ^[0-9]{14}$ ]]; then
  printf '%s\n' 'Usage: bash scripts/publish-docker.sh [--dry-run]; RELEASE_TAG must be YYYYMMDDHHMMSS.' >&2
  exit 2
fi
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
command=(docker buildx build --builder "$builder" --platform "$platforms" --tag "$image:$tag" --push "$repo_dir")
printf 'Image: %s:%s\nPlatforms: %s\nTimezone: %s\n' "$image" "$tag" "$platforms" "$release_tz"
if "$dry_run"; then printf '%q ' "${command[@]}"; printf '\n'; exit 0; fi
docker info >/dev/null
docker buildx version >/dev/null
if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
  docker buildx create --name "$builder" --driver docker-container >/dev/null
fi
if [[ -n "${DOCKERHUB_TOKEN:-}" ]]; then
  printf '%s' "$DOCKERHUB_TOKEN" | docker login --username bdpgogoup --password-stdin
fi
# No token provided: use docker login credentials already held by Docker.
"${command[@]}"
printf '\nPublished: %s:%s\n' "$image" "$tag"
printf 'docker run -d --init --name docker-browser-mcp --restart unless-stopped --shm-size=1g -p 8080:8080 -e BASE_URL=https://browser.example.com -e WEB_PASSWORD=CHANGE_ME -v browser-mcp-data:/data %s:%s\n' "$image" "$tag"
