#!/usr/bin/env bash
#
# Builds the production image from docker/Dockerfile.
#
#   npm run image:build
#
# The build-stage secret is passed with --mount=type=secret and never with --build-arg:
# the whole of `npm run demo:image` is three zeros proving the difference. There is no
# private registry behind this project, so the token is a decoy — a random string whose
# only job is to be searched for afterwards, in the image history, in the image config and
# in the unpacked layers.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE="$(node -p 'const s=require("./k8s/stack.json"); `${s.image}:${s.tag}`')"
TOKEN_FILE="$ROOT/.npm_token"

if [ ! -s "$TOKEN_FILE" ]; then
    head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' > "$TOKEN_FILE"
    echo "wrote a decoy registry token to .npm_token (git-ignored)"
fi

# --provenance=false keeps the result a plain image rather than a manifest list with an
# attestation beside it. Nothing here needs provenance, and `docker save` of a list is a
# different layout — the leak search in demo/image.mjs would have to know which.
docker build \
    --file docker/Dockerfile \
    --target runtime \
    --provenance=false \
    --secret "id=npm_token,src=$TOKEN_FILE" \
    --tag "$IMAGE" \
    "$ROOT"

echo "built $IMAGE"
