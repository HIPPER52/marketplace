# Marketplace API

Contract-first API for a small marketplace. The OpenAPI document in
[`openapi/openapi.yaml`](openapi/openapi.yaml) is the source of truth; the service is a
thin layer behind a validator that enforces it.

| Assignment | What it added                                                                   |
| ---------- | ------------------------------------------------------------------------------- |
| HW-09      | the OpenAPI contract and runtime validation at the boundary                     |
| HW-11      | NestJS, a validated environment schema, and password rotation without a restart |
| **HW-12**  | **the data layer: schema, seed, indexes, and EXPLAIN evidence** — below         |

---

# Database — HW-12

Four tables, 320 000 seeded rows, four real API queries, and the `EXPLAIN` output that
shows what each index did to each of them.

- **Main table: `orders`** — 200 000 rows.
- **Search table (the one `q4` searches): `products`** — 120 000 rows.

## Raise the database

```bash
docker compose up -d --wait db
```

## Connect to it

```bash
docker compose exec -T db psql -U postgres -d marketplace
```

Both lines work on a fresh clone with no edits to any file: the Postgres dev credentials
live in [`docker-compose.yml`](docker-compose.yml) on purpose — they are a local stand, not
a secret (what _is_ a secret is covered under [Configuration](#configuration)).

`./db` is bind-mounted at the container's working directory, so every command below can be
typed with the same relative path the repository uses. Defining this alias once makes the
rest of the section copy-paste:

```bash
alias psql='docker compose exec -T db psql -U postgres -d marketplace'
psql -Atc "SELECT 1"        # 1
```

## Files

| File                                         | Purpose                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| [`db/schema.sql`](db/schema.sql)             | four tables, three FOREIGN KEYs, CHECKs, generated `tsvector`           |
| [`db/seed.sql`](db/seed.sql)                 | 20 000 users, 120 000 products, 200 000 orders, 400 001 items           |
| [`db/queries/q1.sql`](db/queries/q1.sql)     | one customer's orders for a period                                      |
| [`db/queries/q2.sql`](db/queries/q2.sql)     | admin queue: `pending` orders from the last 30 days                     |
| [`db/queries/q3.sql`](db/queries/q3.sql)     | find a customer by e-mail, case-insensitively                           |
| [`db/queries/q4.sql`](db/queries/q4.sql)     | full-text search over the catalogue                                     |
| [`db/indexes.sql`](db/indexes.sql)           | the four indexes that cure them, and nothing else                       |
| [`db/OPTIMIZATIONS.md`](db/OPTIMIZATIONS.md) | four `EXPLAIN` pairs, the index audit, and `## Морфологія (morphology)` |

## Reproduce every number in the report

The cycle below starts from an empty volume and ends at the last plan. It takes about
half a minute.

```bash
docker compose down -v && docker compose up -d --wait db
alias psql='docker compose exec -T db psql -U postgres -d marketplace'

psql -f db/schema.sql
psql -f db/seed.sql                       # ~17 s; ends with VACUUM (ANALYZE)

# before: every one of the four is a Seq Scan
for q in q1 q2 q3 q4; do
  psql -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/$q.sql)"
done

psql -f db/indexes.sql
psql -c "ANALYZE;"

# after: no Seq Scan, and each plan names an index from db/indexes.sql
for q in q1 q2 q3 q4; do
  psql -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/$q.sql)"
done
```

`seed.sql` ends with `VACUUM (ANALYZE)`, not a bare `ANALYZE`: `ANALYZE` gives the planner
its statistics, but only `VACUUM` sets the visibility map, and without it an Index Only
Scan still visits the heap for every row it returns.

Run `q4` two or three times and take the last: the first call after `CREATE INDEX` reads a
cold GIN and is an order of magnitude slower than the truth.

## What the checks say here

```bash
psql -Atc "SELECT count(*) FROM information_schema.table_constraints
           WHERE constraint_type='FOREIGN KEY' AND table_schema='public';"     # 3
psql -Atc "SELECT count(*) FROM orders;"                                       # 200000
psql -Atc "SELECT count(*) FROM products;"                                     # 120000

# no index was created "just in case" — this must be empty
psql -Atc "SELECT indexrelname FROM pg_stat_user_indexes
           WHERE schemaname='public' AND idx_scan = 0
             AND indexrelid NOT IN (SELECT conindid FROM pg_constraint WHERE conindid <> 0);"

# a partial or expression index exists (2: idx_orders_pending_created_at, idx_users_email_lower)
psql -Atc "SELECT count(*) FROM pg_indexes WHERE schemaname='public'
             AND indexdef NOT ILIKE '%USING gin%'
             AND (indexdef ILIKE '% WHERE %' OR indexdef ~ '\((\w+)\(');"      # 2

# the search index is GIN over tsvector
psql -Atc "SELECT count(*) FROM pg_index i
             JOIN pg_class c ON c.oid = i.indexrelid
             JOIN pg_am am ON am.oid = c.relam
             JOIN pg_opclass o ON o.oid = i.indclass[0]
            WHERE am.amname='gin' AND o.opcintype='tsvector'::regtype;"        # 1

grep -c 'Execution Time' db/OPTIMIZATIONS.md                                   # 8
```

## The short version of the report

| Query | Index that entered the plan     | Type                | Buffers before | after | Gain |
| ----- | ------------------------------- | ------------------- | -------------- | ----- | ---- |
| q1    | `idx_orders_user_id_created_at` | composite B-tree    | 2 121          | 26    | ×82  |
| q2    | `idx_orders_pending_created_at` | partial B-tree      | 2 121          | 52    | ×41  |
| q3    | `idx_users_email_lower`         | expression B-tree   | 280            | 4     | ×70  |
| q4    | `idx_products_search_vector`    | GIN over `tsvector` | 23 902         | 854   | ×28  |

Full plans, the index audit, the price of the stored `tsvector` column and the
`## Морфологія (morphology)` section are in [`db/OPTIMIZATIONS.md`](db/OPTIMIZATIONS.md).

Money is stored as `bigint` counts of minor units in columns named `*_cents`, matching
what `openapi/openapi.yaml` declares. That is the decision `numeric` exists to enforce —
exact decimal arithmetic, never binary floating point — taken one step further: an integer
count cannot drift in scale. `real`, `double precision` and the `money` type are
deliberately absent; the reasoning is written out at the top of
[`db/schema.sql`](db/schema.sql).

---

# The contract — HW-09

`express-openapi-validator` checks every request **and every response** against the spec,
and an error handler turns its rejections into RFC 7807 `application/problem+json`
documents. Nothing in the handlers re-implements those rules with `if` statements — the
spec is what rejects a bad request.

The service is written in TypeScript, and the request/response types are **generated from
the same spec** (`npm run gen:types` → `src/generated/api.ts`, run automatically by
`build`). So the contract is enforced twice: by the compiler before the code ships, and by
the validator at runtime.

The HTTP layer still serves the in-memory catalogue in
[`src/common/store/catalog.store.ts`](src/common/store/catalog.store.ts); wiring the
handlers to the schema above is HW-13 (TypeORM entities) and HW-14 (transactional
checkout).

## Quick start

```bash
npm install     # also builds: the `prepare` hook runs `gen:types` + `tsc`
npm start       # http://localhost:3000
```

No other manual step is needed.

| Operation            | Notes                                                     |
| -------------------- | --------------------------------------------------------- |
| `GET /products`      | cursor pagination via `limit` and `cursor`                |
| `GET /products/{id}` | `404` as problem+json                                     |
| `GET /orders`        | cursor pagination, newest first                           |
| `POST /orders`       | requires `Idempotency-Key`; `201`, or `422` on key misuse |
| `GET /orders/{id}`   | `404` as problem+json                                     |
| `GET /health`        | liveness, outside the contract on purpose                 |

A seeded product id for copy-paste: `6f1c2a34-0d51-4b8e-9a7d-1f2e3c4b5a60`.

## Checks

Every command below works on a clean checkout after `npm install`.

### The spec is valid

```bash
npx @redocly/cli lint openapi/openapi.yaml
```

### Scope: at least 2 resources and 5 operations

```bash
npx @redocly/cli bundle openapi/openapi.yaml -o spec.json
node -e "const s=require('./spec.json'),M=['get','post','put','patch','delete'];\
const ops=Object.entries(s.paths).flatMap(([p,v])=>Object.keys(v).filter(m=>M.includes(m)).map(m=>[p,m]));\
const idem=ops.flatMap(([p,m])=>s.paths[p][m].parameters??[]).find(x=>x.in==='header'&&/idempotency-key/i.test(x.name));\
console.log('operations:',ops.length,'resources:',new Set(Object.keys(s.paths).map(p=>p.split('/')[1])).size);\
console.log('Idempotency-Key: required =',idem?.required,'description length =',(idem?.description??'').trim().length)"
```

```
operations: 5 resources: 2
Idempotency-Key: required = true description length = 414
```

### The contract carries the three lecture patterns

```bash
grep -c 'Idempotency-Key'          openapi/openapi.yaml   # 3
grep -c 'next_cursor'              openapi/openapi.yaml   # 7
grep -c 'application/problem+json' openapi/openapi.yaml   # 4
```

### Runtime: the validator rejects what the spec forbids

Start the service with `npm start`, then:

```bash
PRODUCT=6f1c2a34-0d51-4b8e-9a7d-1f2e3c4b5a60

# no Idempotency-Key -> 400 application/problem+json
curl -s -i -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"product_id\":\"$PRODUCT\",\"quantity\":2}]}"

# empty items -> 400 with the validator's own detail
curl -s -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 11111111-1111-4111-8111-111111111111' \
  -d '{"items":[]}'

# valid request -> 201
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 22222222-2222-4222-8222-222222222222' \
  -d "{\"items\":[{\"product_id\":\"$PRODUCT\",\"quantity\":2}]}"
```

The first two answer `Content-Type: application/problem+json` with exactly:

```
request/headers must have required property 'idempotency-key'
request/body/items must NOT have fewer than 1 items
```

### Idempotency semantics (the optional challenge)

```bash
KEY=44444444-4444-4444-8444-444444444444
BODY="{\"items\":[{\"product_id\":\"$PRODUCT\",\"quantity\":1}]}"

# first call -> 201, no replay header
curl -s -i -X POST http://localhost:3000/orders -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" -d "$BODY" | head -1

# same key, same body -> 201 + Idempotency-Replay: true, identical order
curl -s -i -X POST http://localhost:3000/orders -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" -d "$BODY" | grep -iE 'HTTP/|idempotency-replay'

# same key, different body -> 422 problem+json
curl -s -X POST http://localhost:3000/orders -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" \
  -d "{\"items\":[{\"product_id\":\"$PRODUCT\",\"quantity\":9}]}"
```

### Cursor pagination

```bash
curl -s 'http://localhost:3000/products?limit=2'
# {"items":[…two products…],"next_cursor":"b2Zmc2V0OjI"}

curl -s 'http://localhost:3000/products?limit=2&cursor=b2Zmc2V0OjI'
# the next page; next_cursor is null once the collection is exhausted
```

The cursor is opaque: hand back a `next_cursor` verbatim. A token this API did not issue
is answered with `400` problem+json.

### Response validation is real

`validateResponses: true` means the service cannot return anything the spec does not
describe. Renaming `total_cents` to `totalCents` in the order handler is caught twice —
`tsc` fails with `TS2561: 'totalCents' does not exist in type …`, and if the type checker
is bypassed the runtime answers `500` with
`detail: "/response must have required property 'total_cents'"`.

---

# Configuration

Every variable the service reads is declared in one place —
[`src/config/schemas/env.schema.ts`](src/config/schemas/env.schema.ts) — and validated
before the DI graph is built. A missing or malformed variable stops the process at
startup with the name and the reason, rather than surfacing on the first request in
production. Nothing outside that schema touches `process.env`.

## Variables

| Variable           | Required | Default                 | Source                                                                                                     | Meaning                                            |
| ------------------ | -------- | ----------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `NODE_ENV`         | no       | `development`           | environment                                                                                                | `development` \| `test` \| `production`            |
| `PORT`             | no       | `3000`                  | environment                                                                                                | HTTP port                                          |
| `DATABASE_URL`     | **yes**  | —                       | **secrets store for the credential**; host and role from `docker-compose.yml` (dev/prod) or `.env` (local) | where the database is and which role to connect as |
| `DB_PASSWORD_FILE` | no       | `./secrets/db_password` | **secrets store** — the file itself, rotated by `rotate.sh`                                                | path to the file holding the password              |
| `DB_POOL_MAX`      | no       | `10`                    | environment                                                                                                | maximum pooled connections                         |
| `LOG_LEVEL`        | no       | `log`                   | environment                                                                                                | `error` \| `warn` \| `log` \| `debug` \| `verbose` |

[`.env.example`](.env.example) is the contract: every variable above, each with a comment.
Copy it and fill it in — `cp .env.example .env`. The real `.env` is git-ignored, never
enters the Docker image, and no env file in this repository — `.env.example` included —
carries a database password.

**The database password is deliberately not part of `DATABASE_URL`, and not an environment
variable at all.** It lives in a file, and `pg.Pool` is given a _function_ that re-reads
that file for every new connection — which is what makes rotation possible without a
restart. A `DATABASE_URL` that does carry a password is rejected at startup rather than
silently ignored: a credential that looks like it is in use but is not is worse than no
credential at all.

```bash
git ls-files | grep -E '\.env($|\.)'                # only .env.example
for f in $(git ls-files | grep -E '\.env($|\.)' | grep -vE '\.example$'); do
  grep -IE '^(DATABASE_URL|DB_URL)=' "$f"
done                                                # empty
grep -cE '^(DATABASE_URL|DB_URL)=' .env.example     # 1
```

## Running the service

```bash
cp .env.example .env          # the variable contract, filled in
npm run setup:secrets         # creates secrets/db_password with the value init.sql expects
docker compose up -d          # service + Postgres, dev mode with hot-reload
curl -s localhost:3000/health
```

Both of those files are git-ignored, so a fresh clone has neither — and the first run of
the _service_ needs both. `secrets/db_password` especially: Docker silently creates a
_directory_ when a bind-mount source is missing, and the service then fails reading it.
Raising only the database (the two lines at the top of this file) needs neither.

Postgres is published on host port **25432**, not 5432, so this stack cannot collide with
a Postgres already running on the machine — or with the lecture's own stack.

Without Docker, against a Postgres you supply:

```bash
cp .env.example .env
npm run setup:secrets
npm install                   # `prepare` builds: generates types, then tsc
npm start                     # npm run build && node dist/main.js
```

## Rotating the database password

`rotate.sh` changes the password in three ordered steps, and the service keeps serving
throughout — no restart, no dropped uptime.

```bash
curl -s localhost:3000/health          # note uptime_seconds
bash rotate.sh
curl -s localhost:3000/readiness       # 200 — this one goes to the database
curl -s localhost:3000/health          # uptime_seconds is larger than before
```

What the script does, and why in this order:

1. **`ALTER ROLE`** — the database begins accepting the new password.
2. **Write `secrets/db_password`** — the pool will read it on the next connection.
3. **`pg_terminate_backend`** — live sessions are cut, forcing that next connection.

Reversing steps 1 and 2 would leave a window where the pool offers a password the
database does not know yet. Closing the window entirely needs two alternating roles;
that is a later lecture.

Two things worth knowing:

- After `docker compose down -v` the volume is gone and `init.sql` re-creates the role
  with its original password, while `secrets/db_password` still holds the rotated one.
  That mismatch is the usual `password authentication failed` — restore the file to
  `local_dev_password` or rotate again.
- Terminating sessions makes the pool emit an `error` event for each dropped idle
  client. `createPool` registers a listener for exactly that reason; without one, Node
  would take the process down and rotation would look broken when it is not.

## Verifying the configuration

```bash
# The schema stops a broken environment at startup, with a non-zero exit code.
mv .env /tmp                            # dotenv would otherwise supply the value silently
env -u DATABASE_URL npm run start       # names DATABASE_URL; echo $? -> 1
mv /tmp/.env .

# .env.example has not drifted from the schema.
npm run check:env                 # exit 0; delete any line from the file -> exit 1

# The secret is not in git.
git status --ignored --porcelain | grep -E '^!! .*\.env$'   # finds it
git ls-files | grep -c '\.env$'                             # 0 — only .env.example

# The secret is not in the image.
docker build -t myapp .
docker run --rm myapp ls -a /app                  # .env.example yes; .env and secrets/ no
docker run --rm myapp sh -c 'cat /app/.env' 2>&1  # No such file or directory
docker inspect --format '{{.Config.Env}}' myapp   # base image variables only
docker history --no-trunc myapp | grep -i password  # empty
```

---

# Development

```bash
npm run dev           # tsx watch
npm run typecheck     # generate types from the spec, then tsc --noEmit
npm run lint          # Biome - TypeScript, JavaScript, JSON
npm run format        # Prettier - YAML and Markdown
npm run check         # all of the above plus the spec lint
```

The stack also runs in Docker: `docker compose up -d` starts the service with hot-reload
alongside Postgres 17; `docker compose -f docker-compose.yml up -d --build` is the
production path.
