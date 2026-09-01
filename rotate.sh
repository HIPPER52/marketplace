set -euo pipefail

SECRET_FILE="${DB_PASSWORD_FILE:-./secrets/db_password}"
DB_NAME="${DB_NAME:-marketplace}"
DB_ROLE="${DB_USER:-marketplace_app}"
COMPOSE_DB_SERVICE="${COMPOSE_DB_SERVICE:-db}"
SUPERUSER="${POSTGRES_SUPERUSER:-postgres}"

psql_super() {
    docker compose exec -T "$COMPOSE_DB_SERVICE" \
        psql --username "$SUPERUSER" --dbname "$DB_NAME" --quiet --no-align --tuples-only "$@"
}

if [[ ! -f "$SECRET_FILE" ]]; then
    echo "No secret file at ${SECRET_FILE}. Run 'npm run setup:secrets' first." >&2
    exit 1
fi

new_password="$(openssl rand -hex 24)"
old_password="$(cat "$SECRET_FILE")"

echo "==> 1/3  ALTER ROLE ${DB_ROLE}"
psql_super --command "ALTER ROLE ${DB_ROLE} WITH PASSWORD '${new_password}';" > /dev/null

echo "==> 2/3  writing ${SECRET_FILE}"
umask 077
if ! printf '%s' "$new_password" > "$SECRET_FILE"; then
    echo "!!  Could not write ${SECRET_FILE}; rolling the database password back." >&2
    psql_super --command "ALTER ROLE ${DB_ROLE} WITH PASSWORD '${old_password}';" > /dev/null
    echo "!!  Rolled back. The service still holds a password the database accepts." >&2
    exit 1
fi

chmod 600 "$SECRET_FILE"

echo "==> 3/3  terminating existing ${DB_ROLE} sessions"
terminated="$(psql_super --command \
    "SELECT count(pg_terminate_backend(pid))
       FROM pg_stat_activity
      WHERE usename = '${DB_ROLE}' AND pid <> pg_backend_pid();")"

echo
echo "Rotated. ${terminated// /} session(s) closed; the pool will reconnect with the new"
echo "password on its next query. The service was not restarted — check that uptime kept"
echo "growing:"
echo
echo "    curl -s localhost:3000/readiness   # 200, goes to the database"
echo "    curl -s localhost:3000/health      # uptime_seconds larger than before"
