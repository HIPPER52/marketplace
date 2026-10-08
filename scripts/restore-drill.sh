#!/usr/bin/env bash
#
# Proves that the newest backup restores — into a database that did not exist a moment ago.
#
#   bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
#   bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh backups/some.dump
#
# Prints MATCH and exits 0, or prints the mismatch and exits non-zero.
#
# ## Why a throwaway container
#
# A drill that restores into the database it dumped proves nothing: the rows were already
# there. This one starts a brand-new Postgres with an empty data directory, restores into
# it, compares control totals against the live database, and removes the container. Nothing
# survives the run, so the second run is as honest as the first.
#
# An untruthful version of this script is easy to write by accident — restore into a volume
# that already holds the data and every `duplicate key` error looks like a bug in the dump
# rather than proof the drill was never clean.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
DB_SERVICE="${DB_SERVICE:-db}"
DRILL_CONTAINER="${DRILL_CONTAINER:-marketplace-restore-drill}"
DRILL_IMAGE="${DRILL_IMAGE:-postgres:17-alpine}"
DRILL_PASSWORD="drill_only_never_leaves_this_script"
WAIT_SECONDS=60

if [ -z "${DATABASE_URL:-}" ]; then
    echo "restore-drill.sh: DATABASE_URL is not set." >&2
    echo "Run it through the store, or export DATABASE_URL and SKIP_VAULT=1 — see the" >&2
    echo "'Grading' section of README.md." >&2
    exit 1
fi

rest="${DATABASE_URL#*://}"
userinfo="${rest%%@*}"
hostpart="${rest#*@}"
DB_USER="${userinfo%%:*}"
DB_NAME="${hostpart#*/}"
DB_NAME="${DB_NAME%%\?*}"

url_password=""
case "$userinfo" in
    *:*) url_password="${userinfo#*:}" ;;
esac
PGPASSWORD="${url_password:-${PGPASSWORD:-}}"

# ---- the archive ------------------------------------------------------------------------
archive="${1:-}"

if [ -z "$archive" ]; then
    archive="$(ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null | head -n 1 || true)"
fi

if [ -z "$archive" ] || [ ! -f "$archive" ]; then
    echo "restore-drill.sh: no dump to restore." >&2
    echo "Make one first:  bash scripts/with-secrets.sh dev bash scripts/backup.sh" >&2
    exit 1
fi

archive_bytes="$(wc -c < "$archive" | tr -d ' ')"
echo "archive:   $archive (${archive_bytes} bytes)"

# ---- control totals from the live database -----------------------------------------------
# count(*) and a sum per table: a row count alone would pass even if every amount were
# zeroed, and a sum alone would pass if rows were swapped.
CHECKSUM_SQL="
SELECT 'users'       || '=' || count(*) || '|' || coalesce(sum(balance_cents), 0)  FROM users
UNION ALL
SELECT 'products'    || '=' || count(*) || '|' || coalesce(sum(price_cents), 0)    FROM products
UNION ALL
SELECT 'orders'      || '=' || count(*) || '|' || coalesce(sum(total_cents), 0)    FROM orders
UNION ALL
SELECT 'order_items' || '=' || count(*) || '|' || coalesce(sum(subtotal_cents), 0) FROM order_items
UNION ALL
SELECT 'jobs'        || '=' || count(*) || '|' || coalesce(sum(processed), 0)      FROM jobs
ORDER BY 1"

before="$(docker compose exec -T -e PGPASSWORD="$PGPASSWORD" "$DB_SERVICE" \
    psql -At -h 127.0.0.1 -p 5432 -U "$DB_USER" -d "$DB_NAME" -c "$CHECKSUM_SQL")"

echo "before:"
echo "$before" | sed 's/^/  /'

# ---- a Postgres that has never seen this data --------------------------------------------
cleanup() {
    docker rm -f "$DRILL_CONTAINER" > /dev/null 2>&1 || true
}
trap cleanup EXIT

# Any leftover from an interrupted run would make this drill a lie.
cleanup

started_at="$(date +%s)"

docker run -d --rm \
    --name "$DRILL_CONTAINER" \
    -e POSTGRES_PASSWORD="$DRILL_PASSWORD" \
    -e POSTGRES_DB="$DB_NAME" \
    "$DRILL_IMAGE" > /dev/null

printf 'drill:     waiting for a fresh %s' "$DRILL_IMAGE"

ready=0
for _ in $(seq 1 "$WAIT_SECONDS"); do
    if docker exec "$DRILL_CONTAINER" pg_isready -U postgres -d "$DB_NAME" > /dev/null 2>&1; then
        ready=1
        break
    fi
    printf '.'
    sleep 1
done
printf '\n'

if [ "$ready" -ne 1 ]; then
    echo "restore-drill.sh: the drill container never became ready." >&2
    exit 1
fi

# The dump carries GRANTs naming the application role, which does not exist in a fresh
# cluster. Creating it is cheaper than restoring with --no-privileges and pretending the
# grants were never part of the schema.
docker exec -i "$DRILL_CONTAINER" psql -U postgres -d "$DB_NAME" -q -c \
    "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$DB_USER') THEN EXECUTE format('CREATE ROLE %I LOGIN', '$DB_USER'); END IF; END \$\$;"

# --no-owner: the objects belong to roles this cluster does not have. --exit-on-error so a
# half-restored database cannot be mistaken for a successful drill.
restore_started="$(date +%s)"
docker exec -i "$DRILL_CONTAINER" \
    pg_restore --no-owner --exit-on-error -U postgres -d "$DB_NAME" < "$archive"
restore_seconds=$(( $(date +%s) - restore_started ))

after="$(docker exec -i "$DRILL_CONTAINER" psql -At -U postgres -d "$DB_NAME" -c "$CHECKSUM_SQL")"

echo "after:"
echo "$after" | sed 's/^/  /'

total_seconds=$(( $(date +%s) - started_at ))

# ---- the verdict --------------------------------------------------------------------------
if [ "$before" != "$after" ]; then
    echo
    echo "MISMATCH — the restored database is not the one that was dumped." >&2
    diff <(echo "$before") <(echo "$after") >&2 || true
    exit 1
fi

echo
echo "MATCH"
echo "restore:   ${restore_seconds}s"
echo "drill:     ${total_seconds}s end to end (container start + restore + verify)"
