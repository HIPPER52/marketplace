#!/usr/bin/env bash
#
# Creates the local stand's credential files: secrets/db_password and
# pgbouncer/userlist.txt.
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
USERLIST_FILE="$ROOT/pgbouncer/userlist.txt"

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

role="$(grep -oE "CREATE ROLE[[:space:]]+[A-Za-z0-9_]+" "$INIT_SQL" | head -n 1 | awk '{print $3}' || true)"
role="${role:-marketplace_app}"

# PgBouncer needs the same password in its own file, and a third hand-typed copy of a
# credential is a third thing to forget. Derived from init.sql like the one above, so the
# two cannot drift: change the role's password there and re-run this script.
#
# Committed to the repository on purpose — a fresh clone has to be able to `docker compose
# up` without running anything first, and this is the local stand's password, which already
# sits in plain sight in init.sql and docker-compose.yml.
mkdir -p "$(dirname "$USERLIST_FILE")"
printf '"%s" "%s"\n' "$role" "$password" > "$USERLIST_FILE"
chmod 644 "$USERLIST_FILE"

echo "Wrote ${SECRET_FILE#"$ROOT/"} and ${USERLIST_FILE#"$ROOT/"} from init.sql (role ${role})."
echo "Rotate the first with ./rotate.sh — after which init.sql no longer matches, by design."
