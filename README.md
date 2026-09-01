# Marketplace API — HW-09

Contract-first API for a small marketplace. The OpenAPI document in
[`openapi/openapi.yaml`](openapi/openapi.yaml) is the source of truth; the service is a
thin layer behind a validator that enforces it.

## Contract part: **option Б — runtime validation at the boundary**

`express-openapi-validator` checks every request **and every response** against the spec,
and an error handler turns its rejections into RFC 7807 `application/problem+json`
documents. Nothing in the handlers re-implements those rules with `if` statements — the
spec is what rejects a bad request.

The service is written in TypeScript, and the request/response types are **generated from
the same spec** (`npm run gen:types` → `src/generated/api.ts`, run automatically by
`build`). So the contract is enforced twice: by the compiler before the code ships, and by
the validator at runtime.

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

## Configuration

Every variable the service reads is declared in one place —
[`src/config/schemas/env.schema.ts`](src/config/schemas/env.schema.ts) — and validated
before the DI graph is built. A missing or malformed variable stops the process at
startup with the name and the reason, rather than surfacing on the first request in
production. Nothing outside that schema touches `process.env`.

### Variables

| Variable           | Required | Default                 | Meaning                                            |
| ------------------ | -------- | ----------------------- | -------------------------------------------------- |
| `NODE_ENV`         | no       | `development`           | `development` \| `test` \| `production`            |
| `PORT`             | no       | `3000`                  | HTTP port                                          |
| `DB_HOST`          | **yes**  | —                       | Postgres hostname                                  |
| `DB_PORT`          | no       | `5432`                  | Postgres port                                      |
| `DB_NAME`          | **yes**  | —                       | database name                                      |
| `DB_USER`          | **yes**  | —                       | role the service connects as                       |
| `DB_PASSWORD_FILE` | no       | `./secrets/db_password` | file holding the password — **not** the password   |
| `DB_POOL_MAX`      | no       | `10`                    | maximum pooled connections                         |
| `LOG_LEVEL`        | no       | `log`                   | `error` \| `warn` \| `log` \| `debug` \| `verbose` |

[`.env.example`](.env.example) is the contract: every variable above, each with a
comment, secret values faked. Copy it and fill it in — `cp .env.example .env`. The real
`.env` is git-ignored and never enters the Docker image.

**The database password is deliberately not an environment variable.** It lives in a
file, and `pg.Pool` is given a _function_ that re-reads that file for every new
connection — which is what makes rotation possible without a restart.

### Running

```bash
cp .env.example .env          # the variable contract, filled in
npm run setup:secrets         # creates secrets/db_password with the value init.sql expects
docker compose up -d          # service + Postgres, dev mode with hot-reload
curl -s localhost:3000/health
```

Both of those files are git-ignored, so a fresh clone has neither — and the first run
needs both. `secrets/db_password` especially: Docker silently creates a _directory_ when
a bind-mount source is missing, and the service then fails reading it.

Without Docker, against a Postgres you supply:

```bash
cp .env.example .env
npm run setup:secrets
npm install                   # `prepare` builds: generates types, then tsc
npm start                     # npm run build && node dist/main.js
```

### Rotating the database password

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

### Verifying the configuration

```bash
# The schema stops a broken environment at startup, with a non-zero exit code.
mv .env /tmp                      # dotenv would otherwise supply the value silently
env -u DB_HOST npm run start      # names DB_HOST, DB_NAME, DB_USER; echo $? -> 1
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

## Development

```bash
npm run dev           # tsx watch
npm run typecheck     # generate types from the spec, then tsc --noEmit
npm run lint          # Biome - TypeScript, JavaScript, JSON
npm run format        # Prettier - YAML and Markdown
npm run check         # all of the above plus the spec lint
```

The stack also runs in Docker: `docker compose up -d` starts the service with hot-reload
alongside Postgres 17; `docker compose -f docker-compose.yml up -d --build` is the
production path. Postgres backs `/readiness` and the password rotation described above;
the data schema and migrations arrive in a later assignment.
