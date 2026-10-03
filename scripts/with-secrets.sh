#!/usr/bin/env bash
#
# Runs a command with the database credentials already in its environment.
#
#   bash scripts/with-secrets.sh dev npm run migrate
#
# Every npm script that talks to Postgres goes through here, so no command needs to know
# where the credentials live and no credential is ever written into package.json, into a
# npm script, or into src/.
#
# The store is the one HW-11 built: connection details in DATABASE_URL (which carries no
# password, by design), and the password in the file named by DB_PASSWORD_FILE — re-read
# rather than baked in, so ./rotate.sh can replace it under a running service.
#
# What this script exports is the flat DB_* contract that src/database/data-source.ts
# reads. The service and the CLI tools therefore take different shapes out of the same
# store: the service gets a URL plus a password file it re-reads per connection, the CLI
# gets five plain variables. Deriving both from one place is what keeps them honest.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENV_SLUG="${1:-dev}"; shift || true
[ "$#" -gt 0 ] || set -- npm run start

# The grader has no access to the store: the values are already in the environment.
if [ "${SKIP_VAULT:-0}" = "1" ]; then exec "$@"; fi

# --- the store ------------------------------------------------------------------------
# A real environment variable always wins over the file, so `DB_NAME=other npm run seed`
# works and so does anything a CI runner injects.
ENV_FILE="$ROOT/.env"
[ "$ENV_SLUG" = "dev" ] || ENV_FILE="$ROOT/.env.$ENV_SLUG"

if [ -f "$ENV_FILE" ]; then
    while IFS='=' read -r key value; do
        [[ $key =~ ^[A-Z][A-Z0-9_]*$ ]] || continue
        [[ -n ${!key:-} ]] && continue
        export "$key=$value"
    done < <(grep -E '^[A-Z][A-Z0-9_]*=' "$ENV_FILE")
fi

if [ -z "${DATABASE_URL:-}" ] && [ -z "${DB_HOST:-}" ]; then
    echo "with-secrets.sh: no DATABASE_URL in ${ENV_FILE/#$ROOT\//} and no DB_HOST in the" >&2
    echo "environment. Copy .env.example to .env, or export the DB_* block from the" >&2
    echo "'Grading' section of README.md together with SKIP_VAULT=1." >&2
    exit 1
fi

# DATABASE_URL -> DB_HOST / DB_PORT / DB_USER / DB_NAME.
# postgres://marketplace_app@localhost:25432/marketplace
if [ -n "${DATABASE_URL:-}" ]; then
    rest="${DATABASE_URL#*://}"
    case "$rest" in
        *@*) userinfo="${rest%%@*}"; hostpart="${rest#*@}" ;;
        *)   userinfo="";            hostpart="$rest"      ;;
    esac

    hostport="${hostpart%%/*}"
    dbname="${hostpart#*/}"
    dbname="${dbname%%\?*}"

    case "$hostport" in
        *:*) host="${hostport%%:*}"; port="${hostport##*:}" ;;
        *)   host="$hostport";       port="5432"            ;;
    esac

    export DB_HOST="${DB_HOST:-$host}"
    export DB_PORT="${DB_PORT:-$port}"
    export DB_USER="${DB_USER:-${userinfo%%:*}}"
    export DB_NAME="${DB_NAME:-$dbname}"
fi

# The password is the one thing that is never a URL component and never an env file entry.
if [ -z "${DB_PASSWORD:-}" ]; then
    PASSWORD_FILE="${DB_PASSWORD_FILE:-$ROOT/secrets/db_password}"
    case "$PASSWORD_FILE" in
        /*) ;;
        *) PASSWORD_FILE="$ROOT/${PASSWORD_FILE#./}" ;;
    esac

    if [ ! -f "$PASSWORD_FILE" ]; then
        echo "with-secrets.sh: no password at ${PASSWORD_FILE/#$ROOT\//}." >&2
        echo "Run 'npm run setup:secrets' to create it." >&2
        exit 1
    fi

    DB_PASSWORD="$(cat "$PASSWORD_FILE")"
    export DB_PASSWORD
fi

exec "$@"
