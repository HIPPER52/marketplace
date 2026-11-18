#!/usr/bin/env bash
#
# Runs a Pulumi command against the local file backend, with the stack selected.
#
#   bash scripts/pulumi.sh up
#   bash scripts/pulumi.sh destroy
#
# PULUMI_BACKEND_URL defaults to a directory in this checkout because the alternative
# default is the hosted service, and a tool that quietly asks a grader to log in has
# failed before it started. PULUMI_CONFIG_PASSPHRASE has no default on purpose: the
# Kubernetes provider marks Secret data as secret, so the state file is encrypted, and a
# passphrase baked into a script is the same mistake as a signing key in a repository.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PULUMI_BACKEND_URL="${PULUMI_BACKEND_URL:-file://$ROOT/.pulumi}"
export PULUMI_SKIP_UPDATE_CHECK=true

# The file backend will not create its own directory: it stats the path and gives up with
# "unable to open state directory". A fresh clone has no .pulumi, and the grader's own
# export points at one, so this is the first thing that happens rather than a note in a
# README nobody reads before the first failure.
case "$PULUMI_BACKEND_URL" in
    file://*) mkdir -p "${PULUMI_BACKEND_URL#file://}" ;;
esac

STACK="${PULUMI_STACK:-dev}"
COMMAND="${1:?usage: pulumi.sh <up|destroy|preview|...>}"
shift || true

cd "$ROOT/infra"

pulumi stack select --create "$STACK" --non-interactive >/dev/null

case "$COMMAND" in
    up|destroy) pulumi "$COMMAND" --yes --non-interactive --skip-preview "$@" ;;
    *)          pulumi "$COMMAND" --non-interactive "$@" ;;
esac
