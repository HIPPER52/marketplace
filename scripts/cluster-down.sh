#!/usr/bin/env bash
#
# Removes the cluster, and with it everything inside — including the Pulumi resources,
# which is why `npm run destroy` comes first if the stack state is to stay truthful.
#
#   npm run cluster:down

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER="$(node -p "require('$ROOT/k8s/stack.json').cluster")"

if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
    kind delete cluster --name "$CLUSTER"
else
    echo "cluster ${CLUSTER} is not running"
fi
