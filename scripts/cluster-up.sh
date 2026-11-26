#!/usr/bin/env bash
#
# Creates the local cluster and puts the image inside it.
#
#   npm run cluster:up
#
# The second half is the one people lose a morning to: an image built on the host does not
# exist in the cluster. kind runs its node as a container with its own image store, so
# without `kind load docker-image` the pod sits in ErrImagePull for ever — and
# imagePullPolicy: IfNotPresent does not help, because it is not present.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CLUSTER="$(node -p 'require("./k8s/stack.json").cluster')"
IMAGE="$(node -p 'const s=require("./k8s/stack.json"); `${s.image}:${s.tag}`')"
NODE_PORT="$(node -p 'require("./k8s/stack.json").nodePort')"

# One port, two files, and nothing at runtime would say they disagree: the Service would
# be created happily and the load generator would get connection refused from a host port
# that forwards nowhere.
if ! grep -q "hostPort: ${NODE_PORT}\b" k8s/kind-config.yaml; then
    echo "k8s/kind-config.yaml does not publish hostPort ${NODE_PORT}, which is the" >&2
    echo "nodePort in k8s/stack.json. Change both or neither." >&2
    exit 1
fi

if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
    echo "cluster ${CLUSTER} already exists"
else
    kind create cluster --name "$CLUSTER" --config k8s/kind-config.yaml --wait 180s
fi

kubectl config use-context "kind-${CLUSTER}" >/dev/null

# A promoted digest is the node's business, not ours.
#
# `IMAGE_REF` set means the Deployment names bytes in a registry rather than a tag that
# only exists on this machine, so there is nothing here to hand over: the kubelet pulls
# it, with the credential the Pulumi program put in the namespace. Loading a tag nothing
# references would copy a couple of hundred megabytes into the node to be ignored.
if [ -n "${IMAGE_REF:-}" ]; then
    echo "IMAGE_REF=${IMAGE_REF} — the node pulls that digest itself; nothing to load"
    exit 0
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "image ${IMAGE} is not on this machine. Run: npm run image:build" >&2
    exit 1
fi

kind load docker-image "$IMAGE" --name "$CLUSTER"
echo "loaded ${IMAGE} into ${CLUSTER}"
