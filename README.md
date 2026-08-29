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
production path. Postgres is not used yet - it lands with the database schema in a later
assignment.
