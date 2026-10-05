#!/usr/bin/env bash
#
# Creates secrets/db_password for the local stand.
#
#   npm run setup:secrets
#
# The password is read out of init.sql rather than written here, because init.sql is where
# the role is created with it. Two copies of a credential are two things to keep in step,
# and the one that drifts is always the one nobody is looking at: the stand would come up,
# the service would fail to authenticate, and the difference would be a character in a npm
# script nobody reads.
#
# This is the dev stand's credential, not a secret — the same value sits in plain sight in
# docker-compose.yml and init.sql so that a fresh clone comes up without a vault. The real
# one never lives in this repository at all; see "Configuration" in README.md.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INIT_SQL="$ROOT/init.sql"
SECRET_FILE="$ROOT/secrets/db_password"

if [ ! -f "$INIT_SQL" ]; then
    echo "setup-secrets.sh: no init.sql at ${INIT_SQL#"$ROOT/"}." >&2
    exit 1
fi

# `|| true`: grep exits 1 when it matches nothing, and under `set -e` with `pipefail` that
# would kill the script here — one line before the message that explains what went wrong.
password="$(grep -oE "PASSWORD[[:space:]]*'[^']*'" "$INIT_SQL" | head -n 1 | sed -E "s/.*'([^']*)'.*/\1/" || true)"

if [ -z "$password" ]; then
    echo "setup-secrets.sh: no PASSWORD '…' found in init.sql." >&2
    echo "That file creates the marketplace_app role; the password belongs there." >&2
    exit 1
fi

mkdir -p "$(dirname "$SECRET_FILE")"
umask 077
printf '%s' "$password" > "$SECRET_FILE"
chmod 600 "$SECRET_FILE"

echo "Wrote ${SECRET_FILE#"$ROOT/"} from init.sql (role marketplace_app)."
echo "Rotate it with ./rotate.sh — after which init.sql no longer matches, by design."
