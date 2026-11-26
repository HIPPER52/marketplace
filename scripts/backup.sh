#!/usr/bin/env bash
#
# A compressed, restorable dump of the marketplace database.
#
#   bash scripts/with-secrets.sh dev bash scripts/backup.sh
#
# Prints the path of the artefact it created, and nothing else on stdout, so a caller can
# use the last line. `backup.cron` runs this nightly.
#
# ## Where the connection comes from
#
# DATABASE_URL — the one the HW-11 store fills in, or the one a grader exports. The role
# and the database name are taken from it.
#
# The route is not. pg_dump runs inside the `db` container and connects to Postgres over
# 127.0.0.1:5432 there, deliberately bypassing PgBouncer, for two reasons:
#
#   1. A backup is maintenance, and maintenance belongs on a direct connection. A dump is
#      one long session that sets session parameters and holds a repeatable-read snapshot
#      across every table. Transaction-mode pooling is designed to take the server
#      connection away between transactions — a plain `pg_dump` survives it (measured), but
#      `pg_dump -j` does not, and neither does anything that depends on a `SET` outliving
#      the statement that issued it.
#   2. It removes a dependency the repository should not have. No pg_dump on the machine is
#      needed — the stack already ships a version-matched one, and a client older than the
#      server refuses to dump at all.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
DB_SERVICE="${DB_SERVICE:-db}"

if [ -z "${DATABASE_URL:-}" ]; then
    echo "backup.sh: DATABASE_URL is not set." >&2
    echo "Run it through the store — bash scripts/with-secrets.sh dev bash scripts/backup.sh" >&2
    echo "— or export DATABASE_URL and SKIP_VAULT=1 as the 'Grading' section of README says." >&2
    exit 1
fi

# postgres://user[:password]@host:port/dbname  ->  user, dbname
rest="${DATABASE_URL#*://}"
userinfo="${rest%%@*}"
hostpart="${rest#*@}"
DB_USER="${userinfo%%:*}"
DB_NAME="${hostpart#*/}"
DB_NAME="${DB_NAME%%\?*}"

# A password in the URL wins; otherwise PGPASSWORD, which with-secrets.sh fills from the
# secrets store.
url_password=""
case "$userinfo" in
    *:*) url_password="${userinfo#*:}" ;;
esac
PGPASSWORD="${url_password:-${PGPASSWORD:-}}"

if [ -z "$DB_USER" ] || [ -z "$DB_NAME" ]; then
    echo "backup.sh: could not read a role and a database out of DATABASE_URL." >&2
    exit 1
fi

if ! docker compose ps --status running --services 2>/dev/null | grep -qx "$DB_SERVICE"; then
    echo "backup.sh: the '$DB_SERVICE' service is not running." >&2
    echo "Start the stack first:  docker compose up -d --wait db pgbouncer" >&2
    exit 1
fi

mkdir -p "$BACKUP_DIR"

# The date is in the name because an artefact whose age you cannot read is an artefact you
# cannot reason about: RPO is a statement about the newest backup's timestamp.
stamp="$(date +%Y-%m-%d_%H%M%S)"
archive="$BACKUP_DIR/${DB_NAME}-${stamp}.dump"

# -Fc: the custom format. Compressed, and pg_restore can read its table of contents, filter
# it and restore selectively — a plain SQL file is none of those things.
# --no-owner: the drill restores into a cluster where these roles do not exist.
docker compose exec -T -e PGPASSWORD="$PGPASSWORD" "$DB_SERVICE" \
    pg_dump -Fc --no-owner -h 127.0.0.1 -p 5432 -U "$DB_USER" -d "$DB_NAME" > "$archive"

if [ ! -s "$archive" ]; then
    echo "backup.sh: pg_dump produced an empty file at $archive." >&2
    rm -f "$archive"
    exit 1
fi

# An artefact nobody has read is a hope, not a backup. Reading the table of contents is the
# cheapest proof that the archive is a valid -Fc archive and not a truncated stream;
# scripts/restore-drill.sh proves the stronger thing, that it restores.
# pg_restore cannot read a custom-format archive from a pipe — it seeks around the table of
# contents — so the archive goes to a temporary file inside the container first.
if ! docker compose exec -T "$DB_SERVICE" sh -c \
    'cat > /tmp/verify.dump && pg_restore --list /tmp/verify.dump > /dev/null; status=$?; rm -f /tmp/verify.dump; exit $status' \
    < "$archive"; then
    echo "backup.sh: $archive is not a readable pg_dump archive." >&2
    exit 1
fi

size="$(wc -c < "$archive" | tr -d ' ')"
echo "backup.sh: ${size} bytes, table of contents reads back clean" >&2
echo "$archive"
