# Marketplace API

Contract-first API for a small marketplace. The OpenAPI document in
[`openapi/openapi.yaml`](openapi/openapi.yaml) is the source of truth; the service is a
thin layer behind a validator that enforces it.

| Assignment | What it added                                                                   |
| ---------- | ------------------------------------------------------------------------------- |
| HW-09      | the OpenAPI contract and runtime validation at the boundary                     |
| HW-11      | NestJS, a validated environment schema, and password rotation without a restart |
| HW-12      | the data layer: schema, seed, indexes, and EXPLAIN evidence                     |
| HW-13      | TypeORM over that schema: entities, relations, migrations, N+1                  |
| HW-14      | concurrency: a transactional checkout, a SKIP LOCKED worker pool, retries       |
| HW-15      | operations: PgBouncer, a nightly backup, and a restore drill that proves it     |
| HW-16      | integration, E2E and contract tests; the HTTP layer wired to the database       |
| **HW-18**  | **realtime: a WebSocket room per order, the same stream over SSE** — below      |

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
| [`db/indexes.sql`](db/indexes.sql)           | four indexes for those queries, one for a foreign key, nothing else     |
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

# no index was created "just in case" — this must be empty.
# Run it after the four EXPLAINs AND after one foreign-key check: idx_order_items_product_id
# is read by the RI trigger, which no SELECT in db/queries/ fires.
psql -c "BEGIN; DELETE FROM products WHERE id = md5('product:777')::uuid; ROLLBACK;"
psql -Atc "SELECT indexrelname FROM pg_stat_user_indexes
           WHERE schemaname='public' AND idx_scan = 0
             AND indexrelid NOT IN (SELECT conindid FROM pg_constraint WHERE conindid <> 0);"

# e-mail uniqueness is case-insensitive — this must fail on the second INSERT
psql -c "BEGIN;
         INSERT INTO users (email, display_name) VALUES ('A@example.com', 'upper');
         INSERT INTO users (email, display_name) VALUES ('a@example.com', 'lower');
         ROLLBACK;"

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
| q3    | `idx_users_email_lower`         | unique expression   | 280            | 4     | ×70  |
| q4    | `idx_products_search_vector`    | GIN over `tsvector` | 23 905         | 867   | ×28  |

A fifth index, `idx_order_items_product_id`, serves no query in `db/queries/` — it is what
the `order_items.product_id` foreign key check reads. Without it, deleting one product
sequentially scans all 400 001 line items (4 554 buffers); with it, 15.

Full plans, the index audit, the price of the stored `tsvector` column and the
`## Морфологія (morphology)` section are in [`db/OPTIMIZATIONS.md`](db/OPTIMIZATIONS.md).

Money is stored as `bigint` counts of minor units in columns named `*_cents`, matching
what `openapi/openapi.yaml` declares. That is the decision `numeric` exists to enforce —
exact decimal arithmetic, never binary floating point — taken one step further: an integer
count cannot drift in scale. `real`, `double precision` and the `money` type are
deliberately absent; the reasoning is written out at the top of
[`db/schema.sql`](db/schema.sql).

---

# ORM — HW-13

The HW-12 schema, now owned by code: entities, relations with a deliberate `onDelete` on
every foreign key, and migrations instead of `synchronize`.

## Grading

A grader has no access to the secret store. These lines replace it — the dev credentials of
the local stand, which live in [`docker-compose.yml`](docker-compose.yml) and
[`init.sql`](init.sql) on purpose and are not a secret:

```bash
docker compose up -d --wait
export DATABASE_URL=postgres://marketplace_app:local_dev_password@127.0.0.1:26432/marketplace
export DB_HOST=127.0.0.1 DB_PORT=26432 DB_USER=marketplace_app DB_PASSWORD=local_dev_password DB_NAME=marketplace
export BROKER_URL=amqp://marketplace_app:local_dev_password@127.0.0.1:25672
export SKIP_VAULT=1   # no access to the store: the values are already in the environment
npm ci
```

`--wait` matters more for RabbitMQ than it does for Postgres: between the TCP port opening
and the Erlang node accepting `basic.publish` there is a window in which a client gets
`ECONNRESET`. The broker's healthcheck asks `rabbitmq-diagnostics -q check_running` rather
than whether a port answers, which is what makes that flag mean something here.

Port **25672 is AMQP**; **25673** is the management UI, and it does not speak the protocol
— `BROKER_URL` pointed there does not fail cleanly, it hangs and then dies looking like an
outage, so the environment schema rejects that port by name.

Port **26432 is PgBouncer**, not Postgres — everything goes through the pooler. Two
variable shapes because two kinds of client read them: `DATABASE_URL` is a libpq URI and is
what `scripts/backup.sh` and `scripts/restore-drill.sh` hand to `pg_dump` and `psql`, while
the `DB_*` block is the validated contract `src/database/data-source.ts` reads. One store
fills both — see [Where the credentials come from](#where-the-credentials-come-from).

**Those exports are for the command-line tools, not for the HTTP service.** The URL above
carries a password inline, which is exactly what the service's own environment schema
refuses — the password belongs in the file named by `DB_PASSWORD_FILE` so that it can be
rotated under a running process. A real environment variable beats the `.env` file, so
`npm start` in the same shell exits with
`DATABASE_URL: must not carry a password`. Start the service from a shell that has not
exported it, or `unset DATABASE_URL` first.

That bare command raises Postgres, the pooler, RabbitMQ and the Pact broker, and stops
there: the
`app` service sits behind the `app` profile precisely because it bind-mounts
`secrets/db_password`, which a fresh clone does not have — Docker would create a
root-owned _directory_ in its place. Nothing below needs the HTTP service.

To run the service as well, two things have to happen first, in this order:

```bash
npm ci && npm run setup:secrets      # writes secrets/db_password from init.sql
docker compose --profile app up -d --wait
```

Then everything below runs on a fresh clone with no edits to any file:

```bash
npm ci                 # the `prepare` hook builds: generates types, then tsc
npx tsc --noEmit       # clean

npm run build
npm run migrate        # creates the schema from src/migrations/
npm run migrate:show   # [X] InitialSchema…
npm run seed && npm run seed

npm run demo:nplus1    # HW-13: query counts before and after the N+1 fix
npm run report         # HW-13: revenue by product, through QueryBuilder

npm run demo:race      # HW-14: 50 concurrent checkouts against 10 units of stock
npm run demo:workers   # HW-14: 4 workers draining one queue through SKIP LOCKED
npm run demo:retry     # HW-14: a serialization failure, caught and replayed

bash scripts/with-secrets.sh dev bash scripts/backup.sh        # HW-15: prints the archive path
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh # HW-15: prints MATCH

npm run demo:publish   # HW-19: 5 orders -> 5 events -> 5 effects; prefetch=10, dlq=0
npm run demo:dlq       # HW-19: a poison message, dead-lettered, reason read from x-death
npm run demo:duplicate # HW-19: one event, two deliveries, one effect
```

Each of the eight demos checks its own invariant and exits non-zero when it breaks, so
there is nothing to read carefully — a green exit code is the result.

Port **25432**, not 5432: the stand must not collide with a Postgres already running on
the machine. `DB_USER` is the application role, not the superuser — [`init.sql`](init.sql)
creates it and grants it `CREATE` on schema `public`, because Postgres 15 took away the
implicit grant and without it the very first migration statement fails.

## Where the credentials come from

`src/database/data-source.ts` reads five variables and nothing else: no host, no password,
no path to an env file. Filling them in is the job of
[`scripts/with-secrets.sh`](scripts/with-secrets.sh), and every npm script that reaches
the database goes through it:

```json
"migrate": "bash scripts/with-secrets.sh dev typeorm migration:run -d dist/database/data-source.js",
"seed":    "bash scripts/with-secrets.sh dev node dist/database/cli/seed.js"
```

The store is the one HW-11 built: `DATABASE_URL` carries host, port, role and database but
deliberately no password, and the password lives in the file named by `DB_PASSWORD_FILE`.
The wrapper turns that into the flat `DB_*` block — and `SKIP_VAULT=1` makes it step aside
entirely, which is the line above that lets a grader in.

The service and these tools therefore take different shapes out of one store, on purpose.
A migration run lives for two seconds and has no connection to rotate; the HTTP service
runs for weeks and re-reads the password file on every new connection, which is what makes
[`rotate.sh`](rotate.sh) work without a restart.

## Migrations, not synchronize

`synchronize: true` appears nowhere. It compares entities to the live schema and issues
whatever DDL closes the gap — and a column renamed in an entity is, to that comparison,
one column deleted and another added. The deletion takes the data with it, silently.

The schema is created by [`src/migrations/`](src/migrations/), generated with
`npm run migrate:generate` and then read. Two statements in it are hand-written and marked
`HAND-WRITTEN`, because decorators cannot express them: the unique index over
`lower(email)` and the GIN index over `search_vector`. Both entities declare those indexes
with `synchronize: false`, so the next `migration:generate` neither re-creates nor drops
them.

`down()` is not a stub:

```bash
npm run migrate         # [X] InitialSchema…
npm run migrate:revert  # only `migrations` and `typeorm_metadata` are left
npm run migrate:show    # [ ] InitialSchema…
npm run migrate         # the schema is back
```

## onDelete, one decision per foreign key

| Relation                   | Strategy   | Why                                                                     |
| -------------------------- | ---------- | ----------------------------------------------------------------------- |
| `order_items` → `orders`   | `CASCADE`  | a line item without its order means nothing; it follows the parent      |
| `order_items` → `products` | `RESTRICT` | a product that has been sold is history, and history is not deletable   |
| `orders` → `users`         | `RESTRICT` | deleting a person must not delete the record that they bought something |

`cascade: true` on `Order.items` is a different thing with a confusingly similar name: it
is about **saving** — `save(order)` writes its items in the same call. `onDelete` is about
deleting, and it lives in the database schema, so it holds for a `DELETE` typed into psql
that never passes through this code.

`order_items` is an explicit entity rather than `@ManyToMany`, because the relationship
carries data of its own — how many, and at what price. A bare join table has nowhere to
put either.

## N+1: measured, not asserted

```bash
npm run demo:nplus1
SHOW_SQL=1 npm run demo:nplus1   # every statement, not just the count
```

The graph is `order → items → product`: two levels, eight orders, seventeen line items.

| Strategy                            | 4 orders | 8 orders | What it does                                                |
| ----------------------------------- | -------- | -------- | ----------------------------------------------------------- |
| naive — `find()` in a loop          | **12**   | **26**   | 1 + one per order + one per line item                       |
| `relations: { items: { product } }` | **1**    | **1**    | one `LEFT JOIN`                                             |
| the same, with `take`               | 2        | 2        | a page of parent ids cannot be a `LIMIT` on a joined result |
| `leftJoinAndSelect` with `take`     | 2        | 2        | the same statement, with room for a `WHERE` on the relation |
| `relationLoadStrategy: 'query'`     | 5        | 5        | 1 + 2 × 2 levels; no row multiplication from the join       |

The number that matters is not 1 or 5 — it is that only the first row moves when the page
doubles. Nothing in the naive version looks wrong: there is no `query` call in it, only
`find`. The cost is invisible in the code and visible only in the SQL log, which is why
the script counts that log instead of trusting the code.

Pagination explains the 2. Asking for a page of orders _and_ their items cannot be one
statement with a `LIMIT` — the join multiplies rows, so a limit of four would cut line
items off mid-order. TypeORM selects the page of order ids first, then joins against it.

## Repository or QueryBuilder

`find()` returns a graph of objects: rows of one table and the rows they relate to, typed
as entities. The boundary is reached when the answer is no longer such a graph — and that
is a question about shape, not about difficulty.

[`src/database/cli/report.ts`](src/database/cli/report.ts) is past it. One line of its
output is not a product and not an order item; it is three aggregates over a join, grouped
by product. There is no entity to hydrate, so it is `createQueryBuilder()` with
`.groupBy()` and `getRawMany<RevenueRow>()`, and the row interface is declared next to the
query rather than imported from an entity.

```bash
npm run report
```

```
  product                          orders  units    revenue, UAH
  -------------------------------  ------  -----  --------------
  Бездротові навушники Рось M9712       2      2       13 800,00
  Класичні годинники Збруч M1888        1      1       12 400,00
  Шкіряні кросівки Дніпро M1042         2      3        7 800,00
```

Aggregates arrive as strings — `SUM()` over a `bigint` need not fit in a double, and the
driver will not narrow it silently. The entity columns convert (see
[`src/common/utils/money.util.ts`](src/common/utils/money.util.ts)); raw rows do not.

## Seed

```bash
npm run seed && npm run seed
```

6 users, 10 products, 8 orders, 17 line items — the same rows every run, and the second
run changes none of the counts. Idempotency is one `ON CONFLICT DO NOTHING` per table over
a key the data itself determines: `md5` of a slug for products and orders, the e-mail for
users, the `(order, product)` pair for line items.

```bash
# after two runs
psql -Atc "SELECT count(*) FROM users;"        # 6
psql -Atc "SELECT count(*) FROM products;"     # 10
psql -Atc "SELECT count(*) FROM orders;"       # 8
psql -Atc "SELECT count(*) FROM order_items;"  # 17
```

This is not [`db/seed.sql`](db/seed.sql) from HW-12 — that one pours 320 000 rows so that
`EXPLAIN` has something to say, and it is not idempotent at all. Two tools, two jobs.

## Where things are

| Path                                                                    | What                                                 |
| ----------------------------------------------------------------------- | ---------------------------------------------------- |
| `src/users/entities/`, `src/products/entities/`, `src/orders/entities/` | the four entities, each in its own module            |
| [`src/database/data-source.ts`](src/database/data-source.ts)            | `DataSource` with `synchronize: false`               |
| [`src/migrations/`](src/migrations/)                                    | the generated migration, with two statements by hand |
| [`src/database/cli/`](src/database/cli/)                                | `seed.ts`, `demo-nplus1.ts`, `report.ts`             |
| [`scripts/with-secrets.sh`](scripts/with-secrets.sh)                    | the store, and the `SKIP_VAULT=1` way past it        |

Entities live inside their modules rather than in one `src/entities/` folder, which is the
rule the rest of this repository already follows: every file sits in a folder named after
its kind, and the module that owns a concept owns its types. A central bucket has no owner,
nobody dares delete from it, and it stops a feature folder from being self-contained.

The HW-12 files in [`db/`](db/) are unchanged and still reproduce the `EXPLAIN` report.
They and `src/migrations/` describe the same four tables, so applying both to one database
is applying the schema twice — pick a path. The migration is the one the application
follows; `db/schema.sql` stays as the artefact its report was measured against.

---

# Concurrency — HW-14

Placing an order is one transaction: take the stock, take the money, write the order and
its line items, queue the receipt. Fifty callers at once, ten units of stock, and nobody
gets a unit that does not exist.

## Конкурентність (concurrency)

Numbers below are one run on this machine, from an empty volume through `migrate`, `seed`
and the three demos. Reproduce them with the commands in [Grading](#grading).

### `npm run demo:race` — fifty at once, ten units

| What                     | Value |
| ------------------------ | ----- |
| attempts                 | 50    |
| successful               | 10    |
| rejected, out of stock   | 40    |
| final stock              | 0     |
| rows with negative stock | 0     |
| orders created           | 10    |
| jobs queued              | 10    |
| elapsed                  | 75 ms |

No queue and no mutex in the application: `Promise.all` fires all fifty and the database
decides. Ten orders, ten receipts queued, and the other forty callers are told _why_ —
`out-of-stock`, as data, not as an exception they would have to parse.

Fifty concurrent calls arrive at a pool of ten connections — and since HW-15 that pool is
PgBouncer rather than the driver's. Forty of them wait their turn. That is why 75 ms rather
than fifty round trips' worth: the limit is the pool, and it changes nothing about the
outcome.

### `npm run demo:workers` — four workers, one queue

| What            | Value                                 |
| --------------- | ------------------------------------- |
| jobs            | 12, 100 ms of work each               |
| workers         | 4                                     |
| distribution    | w1=3 w2=3 w3=3 w4=3                   |
| processed twice | 0                                     |
| never processed | 0                                     |
| elapsed         | 376 ms against 1200 ms for one worker |

An even split and a 3.2× speed-up. Without `SKIP LOCKED` the same four workers would queue
behind the same head of the queue and finish in about the time one worker takes — the
lock would make them polite rather than parallel.

### `npm run demo:retry` — one serialization failure, replayed

| What           | Value                            |
| -------------- | -------------------------------- |
| isolation      | `REPEATABLE READ`                |
| retries caught | 1 — `40001` on B's attempt 1     |
| balance before | 99 892 000 cents                 |
| balance after  | 99 894 000 cents                 |
| expected       | 99 894 000 cents (+5 000 −3 000) |

Two transactions read the same balance, think, and write back a number they computed from
what they read. Under `READ COMMITTED` that is the lost update from the lecture — the
second write wins silently and fifty hryvnia disappear. Under `REPEATABLE READ` Postgres
refuses the second write, the wrapper replays the whole transaction, and the arithmetic
comes out right.

## Atomic UPDATE, not SELECT … FOR UPDATE

Both close the race; the difference is where the decision is made.

```sql
UPDATE products SET in_stock = in_stock - $2
 WHERE id = $1 AND in_stock >= $2
 RETURNING price_cents, currency
```

That one statement is the check and the write together, so the window between reading a
number and acting on it does not exist — not a narrow window, none at all. A concurrent
checkout blocks on the row lock, and when it resumes `READ COMMITTED` re-evaluates the
`WHERE` against the version that just committed. Zero rows back means "not any more",
decided by the database on current data rather than by this process on a stale read.

`SELECT … FOR UPDATE` would work too, and reads more obviously — lock, think, write. It
costs a round trip, holds the lock across it, and invites the next person to put
application logic between the two statements. That gap is exactly the shape that lost the
50 грн in the lecture.

What the atomic form gives up: zero rows is one answer to two different questions. "No
such product" and "not enough of it" are told apart by a second query — but only on the
failure path, where an extra read costs nothing.

**And if that predicate were ever wrong**, `products.in_stock` carries
`CHECK (in_stock >= 0)` and `users.balance_cents` carries `CHECK (balance_cents >= 0)`.
Postgres would answer `23514` and roll the transaction back. The invariant is held by the
schema; the query is only how it is held without waiting.

Line items are sorted by product id and products are always touched before the buyer, so
two checkouts take their locks in the same order and cannot form a cycle. Preventing a
deadlock is cheaper than recovering from one — and the retry wrapper is still there,
because "cheaper" is not "impossible".

## Why the retry catches exactly two codes

`src/database/utils/with-retry.util.ts` retries `40001` and `40P01`, and nothing else.

| Code    | What happened                                                                  | Why it is retryable                                                |
| ------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `40001` | serialization_failure — a snapshot went stale against a concurrent writer      | the transaction was **not** applied and its inputs are still valid |
| `40P01` | deadlock_detected — two transactions waited on each other, Postgres killed one | same: nothing was committed, and the cycle is unlikely to repeat   |

Both are the database saying "nothing is wrong, do it again". Everything else is not.
`23514` means the data broke a business rule and will break it identically on the next
attempt — retrying turns a clear rejection into a slow one. `55P03` means the caller used
`NOWAIT` to say explicitly that it would not wait, so waiting five more times is the one
thing it must not do. A retry list that grows past these two stops being a retry list and
becomes a way to hide errors.

The retry replays the **whole** transaction, reads included. Replaying only the write
would reuse a value read under a snapshot the database has already rejected — a lost
update wearing a retry's clothes.

## The queue is a table, on purpose

The receipt job is inserted in the same transaction as the order. A message broker cannot
join that transaction, so "the order committed but the broker call failed" is a state that
only a queue table can rule out. That is the transactional outbox pattern, and in #19 this
table becomes one in front of RabbitMQ.

Workers claim rows with `FOR UPDATE SKIP LOCKED` and hold the lock for the whole
transaction, which is what makes a crashed worker harmless: the lock dies with its
connection and the job returns to the queue, never having been marked done. The claim is
backed by a partial index — `idx_jobs_new ON jobs (id) WHERE status = 'new'` — because a
queue is mostly history, and indexing the done rows would be paying for what nobody
queries. The same reasoning as `idx_orders_pending_created_at` in HW-12.

## Where things are

| Path                                                                                 | What                                                   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| [`src/orders/services/checkout.service.ts`](src/orders/services/checkout.service.ts) | the one transaction                                    |
| [`src/jobs/`](src/jobs/)                                                             | the queue: entity, statuses, the worker                |
| [`src/database/utils/with-retry.util.ts`](src/database/utils/with-retry.util.ts)     | `40001` / `40P01`, backoff, nothing else               |
| [`src/database/cli/`](src/database/cli/)                                             | `demo-race.ts`, `demo-workers.ts`, `demo-retry.ts`     |
| [`src/migrations/`](src/migrations/)                                                 | `BalanceAndJobQueue` — the balance and the queue table |

The HTTP layer is deliberately untouched. `POST /orders` in
[`openapi/openapi.yaml`](openapi/openapi.yaml) declares `{ items, currency }` and
`security: []` — there is no buyer in the contract, and checkout has to know whose balance
to debit. Wiring the endpoint is a contract change, not a transaction change, and it waits
for the assignment that introduces authentication.

---

# Data layer ops — HW-15

Two things a database needs before anyone should call it production: a pooler in front of
it, and a backup somebody has actually restored.

## The three commands

```bash
docker compose up -d --wait db pgbouncer                        # Postgres + PgBouncer on 26432
bash scripts/with-secrets.sh dev bash scripts/backup.sh         # -> backups/marketplace-<date>.dump
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh  # -> MATCH
```

Nothing in `src/` or in the npm scripts knows a host or a password: the wrapper from HW-11
fills them in, and `SKIP_VAULT=1` steps aside for a grader. See
[Grading](#grading).

## PgBouncer, and why `pool_mode = transaction`

The application connects to **PgBouncer on 26432**, never to Postgres directly.
[`pgbouncer/pgbouncer.ini`](pgbouncer/pgbouncer.ini) holds the config; the published port is
in [`docker-compose.override.yml`](docker-compose.override.yml).

A Postgres connection is an operating-system process with its own memory, so a few hundred
of them is not a number Postgres is glad to hear. The pool inside the application already
reuses connections _within one process_; a pooler does the same thing across every process,
pod, migration run and CLI script at once. `max_client_conn = 200` in front of
`default_pool_size = 10` is the whole trade: client connections are cheap, server
connections are the resource being protected.

**Transaction mode** is what makes that ratio possible — a server connection is held only
for the length of a transaction and then handed to whoever is next. And that is exactly
what it breaks. Anything whose lifetime is the _session_ rather than the transaction stops
being reliable, because the next statement may land on a different server connection:

1. **Session state.** `SET`, `LISTEN`/`NOTIFY`, `WITH HOLD` cursors, temporary tables. A
   `SET statement_timeout` issued outside a transaction applies to whichever backend
   happened to serve it, and the next query may not be on that backend.
2. **Session-level advisory locks.** `pg_advisory_lock()` would be taken on one server
   connection and released on another — or never released at all. The transaction-scoped
   variant, `pg_advisory_xact_lock()`, is fine, which is a sharp illustration of where the
   line falls.
3. **Server-side prepared statements.** A driver that names its prepared statements
   prepares on one connection and executes on another, and the failure looks random.
   PgBouncer 1.21+ tracks them per client and replays them — `max_prepared_statements = 200`
   in the config is that insurance.

Everything this project does is transaction-scoped: the checkout, the `SKIP LOCKED` claim
and the retry wrapper all open a transaction and finish it. Measured, not assumed — all
five demos and both migration commands run through the pooler unchanged:

```bash
npm run migrate && npm run seed
npm run demo:nplus1 && npm run report
npm run demo:race && npm run demo:workers && npm run demo:retry   # all exit 0
```

The admin console is open on the same port:

```bash
psql -h 127.0.0.1 -p 26432 -U marketplace_app -d pgbouncer -c "SHOW POOLS"
```

```
  database   |      user       | cl_active | sv_idle |  pool_mode
-------------+-----------------+-----------+---------+-------------
 marketplace | marketplace_app |         0 |      10 | transaction
```

`admin_users` is the application role here because this is a single-tenant local stand. In
production it is a separate role — the console can `PAUSE` and `KILL`.

## Backup

[`scripts/backup.sh`](scripts/backup.sh) writes a compressed, selectively restorable `-Fc`
archive to `backups/`, named with the date it was taken, and prints the path.

`-Fc` rather than plain SQL because `pg_restore` can read its table of contents, filter it
and restore one table out of it; a `.sql` file can do none of those. The script reads that
table of contents back before it reports success — an archive nobody has opened is a hope,
not a backup.

`pg_dump` runs **inside the `db` container, straight at Postgres**, deliberately skipping
the pooler. Two reasons: a dump is maintenance, and maintenance belongs on a session that
nobody will take away mid-snapshot; and it means this repository does not require anyone to
have a version-matched `pg_dump` installed. The role and database still come from
`DATABASE_URL` — it is the route that is chosen, not the identity.

`backups/` is git-ignored. Dumps are data.

[`backup.cron`](backup.cron) is the schedule: 03:17 nightly, through the same wrapper,
because cron has no profile, no `.env` and no access to anything it is not handed.

## Restore drill

[`scripts/restore-drill.sh`](scripts/restore-drill.sh) takes the newest archive, starts a
`postgres:17-alpine` container that has never seen the data, restores into it, compares
control totals against the live database, prints **MATCH**, and removes the container.

The totals are `count(*)` **and** a sum per table. A count alone would pass if every amount
were zeroed; a sum alone would pass if rows were swapped.

Restoring into a volume that already holds the data is the easy way to write a drill that
proves nothing — and the usual source of `duplicate key` errors that look like a corrupt
dump. This one creates and destroys its own container, so the second run is as honest as
the first.

Measured on 320 000 rows: a 35 MB archive, **7 s** to restore, **9 s** end to end.
[`RESTORE-DRILL.md`](RESTORE-DRILL.md) has the full protocol with **RTO** and **RPO** —
including why the honest RTO is about thirty minutes while the database takes nine seconds,
and why the RPO of a nightly schedule is 24 hours no matter how many replicas exist.

A replica would not change that number at all. Replication copies the mistake as faithfully
as the data: `DROP TABLE users` reaches the standby in milliseconds. Replicas protect
against a node dying, backups against a person, and they are not substitutes.

## Where things are

| Path                                                   | What                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| [`pgbouncer/pgbouncer.ini`](pgbouncer/pgbouncer.ini)   | the pooler's config, `pool_mode = transaction`                         |
| `pgbouncer/userlist.txt`                               | generated from `init.sql` by `npm run setup:secrets`, never hand-typed |
| [`scripts/backup.sh`](scripts/backup.sh)               | `-Fc` dump, dated, verified                                            |
| [`scripts/restore-drill.sh`](scripts/restore-drill.sh) | restore into a throwaway cluster, compare, `MATCH`                     |
| [`backup.cron`](backup.cron)                           | 03:17 nightly                                                          |
| [`RESTORE-DRILL.md`](RESTORE-DRILL.md)                 | the protocol: date, size, time, RTO, RPO                               |

---

# Testing — HW-16

A green test is not a true test. This section is the ladder from the cheapest answer to
the most trustworthy one, and what each rung costs.

| Command                    | Who answers                                       | Cost               |
| -------------------------- | ------------------------------------------------- | ------------------ |
| `npm run test:integration` | a real Postgres, raised from inside the tests     | ~1.3 s a container |
| `npm run test:e2e`         | the whole Nest application over HTTP              | + a boot           |
| `npm run test:contract`    | a mock server standing in for this service        | milliseconds       |
| `npm run verify:provider`  | the real service, against the consumer's contract | + a boot           |

All four need Docker running and nothing else. No database has to be up first: every
suite starts its own `postgres:17-alpine` through `@testcontainers/postgresql`, on a port
the library picks, and ryuk removes the container even when a run is killed.

**`postgres:17-alpine`, not 16.** It is the version in `docker-compose.yml` and the
version the restore drill restores into. Testing against another major is the mock's lie
wearing a different hat — everything passes, against a database nobody deploys.

## Isolation: TRUNCATE between tests, and why not a transaction

Each test starts from an empty database: `TRUNCATE … RESTART IDENTITY CASCADE` in
`beforeEach`, one container per file in `beforeAll`.

The lecture's cheaper option — wrap each test in `BEGIN … ROLLBACK` — cannot work here,
and the reason is in this repository rather than in taste. `CheckoutService` opens its
**own** transaction and commits it, then replays the whole thing on `40001`; a test that
wrapped it in an outer transaction would be testing a transaction that never ends, and
the retry wrapper's entire subject could not occur inside one. TRUNCATE costs single-digit
milliseconds on tables this size, works for code that commits and code that does not, and
leaves nothing behind — which is exactly what makes the second run identical to the first:

```bash
npm run test:integration && npm run test:integration   # both green, no cleanup between
```

## Builders, not a wall of fixtures

`test/testkit/builders.ts` gives `aUser()`, `aProduct()` and `anOrder()`: valid defaults,
a counter so `user-1@example.com` and `user-2@…` never collide with the unique index over
`lower(email)`, and a `with*()` chain for the one field a test is actually about.

```ts
const product = await aProduct().withPrice(260_000).withStock(10).insertVia(manager);
```

The test then reads as its own specification. `withStock(10)` says this test is about
stock; the title, the description and the currency are the builder's business.

## What the integration suite catches that a mock cannot

Nine tests across two repositories, and three of them exist because a mock would answer
whatever the author believed:

- **`price_cents` is a number.** It is `bigint` in Postgres, which the driver hands over
  as the string `'260000'`. Only the transformer makes it `260000`, and only a real
  database proves the transformer ran.
- **The constraints are real.** A second line item for the same product in one order is
  `23505` against `order_items_one_line_per_product`; a line item naming a product that
  does not exist is `23503`; a negative price is `23514`. None of the three is expressible
  in application code, and all three are the schema's promises.
- **The JOIN returns what the API serves.** `findById` loads an order and its line items
  through `relationLoadStrategy: 'query'` — two statements for any page size, which is the
  HW-13 result turned into a test rather than a measurement.

## E2E: nothing substituted

`test/e2e/orders.e2e.test.ts` builds the application through
`Test.createTestingModule({ imports: [AppModule] })` and then calls `configureApp()` — the
same function `src/main.ts` calls. No provider is overridden. The OpenAPI validator runs
on every request **and** every response, `DATABASE_URL` comes from the container, and the
order that comes back was written by the transaction that moved the stock:

```
✓ POST /orders places an order and GET /orders/{id} reads it back
✓ the same Idempotency-Key replays the first order instead of placing a second
✓ GET /orders/{id} answers 404 as a problem document
✓ POST /orders without Idempotency-Key is refused by the contract, not by an if
```

The last one is worth a sentence: there is no `if` in any handler checking for that
header. The spec says it is required, the validator reads the spec, and the 400 comes with
the validator's own detail.

`configureApp()` exists for this suite. The four steps it performs are order-dependent and
two of them were found the hard way — see `src/common/utils/configure-app.util.ts`. An E2E
suite that assembled them itself would drift from `main.ts`, and the day it did, the tests
would describe an application nobody deploys.

## The contract

E2E lives in one repository and can only ever prove that this code agrees with itself. The
contract is the rung above: `test/contract/consumer.test.ts` is written from the point of
view of a storefront that does not exist here, against a mock server, and what it leaves
in `pacts/` is what the real service is then held to.

```bash
npm run test:contract      # writes pacts/marketplace-web-marketplace-api.json
npm run verify:provider    # the real service answers every interaction in it
```

Two interactions, both on `GET /products/{productId}` from the HW-09 spec: the product
that exists, and the one that does not, answered in RFC 7807 as the API conventions
promise. The matchers are `integer()` and `string()` rather than literals — a contract
pinned to values breaks whenever somebody edits a seed, and a contract that breaks for no
reason is one people learn to ignore.

`provider states` are satisfied by writing rows. `given('product … exists')` runs an
`INSERT … ON CONFLICT DO UPDATE` against the testcontainer, which is the only way that
sentence can mean anything; a state handler that primed an in-memory store would be
verifying the mock again, one layer up.

**`pacts/` is committed.** It is generated, but it is also the artefact the provider is
held to, and a reviewer should see it change in a diff when the expectations change.
`npm run test:contract` regenerates it; CI does too, and publishes that copy.

## The broker and the gate

```bash
docker compose up -d --wait        # db, pgbouncer, pact-broker — all healthy
open http://127.0.0.1:29292        # the broker's own UI
```

`docker compose up -d --wait` raises the **data layer and the broker** and stops there.
The `app` service sits behind a profile, because it bind-mounts `secrets/db_password`,
which is git-ignored and does not exist in a fresh clone. The service itself is
`docker compose --profile app up -d`.

### Both answers, in order

The point of a gate is that it says no. This sequence shows it saying both things about
the same contract — the step numbers matter, and step 4 cannot be skipped.

```bash
export PACT_BROKER_URL=http://127.0.0.1:29292
# A version per commit, not a constant. The broker outlives the run: with a fixed version
# the prod tag from last time is still there, can-i-deploy answers "yes" before anything
# has verified today's contract, and the gate has nothing left to refuse. CI passes
# github.sha for the same reason.
export PACT_VERSION="$(git rev-parse --short HEAD)"

# 1 — publish the contract the consumer test wrote
curl -s -o /dev/null -w '%{http_code}\n' \
  -X PUT "$PACT_BROKER_URL/pacts/provider/marketplace-api/consumer/marketplace-web/version/$PACT_VERSION" \
  -H 'Content-Type: application/json' \
  --data-binary @pacts/marketplace-web-marketplace-api.json
# 201

# 2 — ask before anything has verified it
curl -s "$PACT_BROKER_URL/can-i-deploy?pacticipant=marketplace-web&version=$PACT_VERSION&to=prod"
```

```json
{
    "summary": {
        "deployable": null,
        "reason": "There is no verified pact between version 1.0.0 of marketplace-web and the latest version of marketplace-api with tag prod (no such version exists)",
        "success": 0,
        "failed": 0,
        "unknown": 1
    }
}
```

```bash
# 3 — the real service answers the contract, and the result goes back to the broker
npm run verify:provider   # exit 0; it reads PACT_BROKER_URL and PACT_VERSION

# 4 — say which provider version is in prod. Without this the answer stays unknown
#     forever: `to=prod` asks about the version that is there, and there is none.
curl -s -o /dev/null -w '%{http_code}\n' \
  -X PUT "$PACT_BROKER_URL/pacticipants/marketplace-api/versions/$PACT_VERSION/tags/prod" \
  -H 'Content-Type: application/json'
# 201

# 5 — the same question as step 2
curl -s "$PACT_BROKER_URL/can-i-deploy?pacticipant=marketplace-web&version=$PACT_VERSION&to=prod"
```

```json
{
    "summary": {
        "deployable": true,
        "reason": "All required verification results are published and successful",
        "success": 1,
        "failed": 0,
        "unknown": 0
    }
}
```

`unknown` before the tag and `true` after it is the proof that this is a gate rather than
a step that is always green.

**That pair holds on a broker with no history of this contract** — `docker compose up -d`
after `docker volume rm marketplace_pactbrokerdata`, which is what CI gets from a fresh
runner every time. Run it twice against the same broker and step 2 answers `true`, for a
reason worth knowing: **the broker attaches a verification result to the _content_ of a
pact, not to the consumer version that published it.** Republishing an unchanged contract
under a new version inherits the old verification, so bumping the version alone does not
re-open the gate.

The question that stays honest is the one about the build being shipped:

```bash
curl -s "$PACT_BROKER_URL/can-i-deploy?pacticipant=marketplace-api&version=$PACT_VERSION&to=prod"
```

Measured against a broker that already carried a prod-tagged version from an earlier run:

```
consumer <sha> -> prod : deployable=true    All required verification results are published
provider <sha> -> prod : deployable=false   No pacts or verifications have been published
                                            for version <sha> of marketplace-api
```

So `.github/workflows/contract.yml` asks about the **provider version it has just built**,
before and after verification, and fails the job if the answer is `true` too early. That is
`false` → `true`, and no amount of broker history can make it green by accident.

### Where the broker's address and token come from

`PACT_BROKER_URL` and `PACT_BROKER_TOKEN` are read from `process.env` and from nowhere
else — there is no default broker in the code, so `npm run verify:provider` with neither
set verifies against the local `pacts/` file and needs nothing running but Docker.

There are two legal ways to supply them, and both are used here:

| Form                                                       | For                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `bash scripts/with-secrets.sh dev npm run verify:provider` | the normal path — the HW-11 store, same wrapper as everything else |
| `PACT_BROKER_URL=… npm run verify:provider`                | CI, and anyone who has the values already                          |

The wrapper exports every `KEY=value` it finds in `.env`, so adding `PACT_BROKER_URL`
there is all it takes; under `SKIP_VAULT=1` it steps aside and runs the identical command.
In GitHub Actions the token is `${{ secrets.PACT_BROKER_TOKEN }}` and the URL is a
loopback port on the runner — an address, not a secret.

One wrinkle is worth knowing about, because it only appears on the wrapped form: the
wrapper exports `LOG_LEVEL=log` along with everything else in `.env`, and
`@pact-foundation/pact-core` builds a pino logger out of that variable the moment it is
imported. pino has no level called `log`. `test/testkit/jest-setup.ts` takes the variable
away before any test module loads — the service gets it back from `.env` when the
application module boots, well after pact's logger exists.

They are deliberately **not** in `.env.example`. That file is checked against the zod
schema in `src/config/schemas/env.schema.ts` by `npm run check:env`, and these two are
tooling variables that nothing in `src/` reads; adding them would mean claiming the
service has a contract it does not have.

## What this assignment changed outside `test/`

The HTTP layer used to answer from an array in memory while the data layer from HW-13 to
HW-15 ran beside it. That is no longer possible to test honestly: a provider state seats a
row in Postgres and the service has to be the thing that finds it. So the five operations
in the spec now read and write through TypeORM — `ProductsRepository`, `OrdersRepository`
and, for `POST /orders`, the transactional `CheckoutService` from HW-14.

`POST /orders` debits one deterministic account, created by its own migration and named by
`DEMO_BUYER_ID`. There is no authentication in this project yet and the contract describes
no customer resource; inventing a header or a `buyer_id` field would put a second source of
truth next to `openapi.yaml`. When authentication lands, that constant is the single place
that stops being right.

## Where things are

| Path                                                               | What                                                       |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| [`jest.config.js`](jest.config.js)                                 | `reporters: ['default']`, `maxWorkers: 1`, and why         |
| [`test/testkit/pg-container.ts`](test/testkit/pg-container.ts)     | one call, one real Postgres, every migration applied       |
| [`test/testkit/builders.ts`](test/testkit/builders.ts)             | `aUser()`, `aProduct()`, `anOrder()`                       |
| [`test/integration/`](test/integration/)                           | two repositories, nine tests, three of them constraints    |
| [`test/e2e/`](test/e2e/)                                           | the whole app through supertest                            |
| [`test/contract/`](test/contract/)                                 | the consumer test and the provider verification            |
| `pacts/`                                                           | the contract itself — generated, and committed             |
| [`.github/workflows/contract.yml`](.github/workflows/contract.yml) | publish → verify → can-i-deploy, with the refusal in front |

---

# Realtime — HW-18

A status change used to be something the buyer discovered by pressing F5. It now reaches
them while they are looking at the page, over either of two transports that carry the
same events from the same bus.

## The commands

The application has to be running — see
[Running the service](#running-the-service), and note the warning in
[Grading](#grading) if this shell has already exported `DATABASE_URL`. Then:

```bash
curl -sN -H 'X-User-Id: 1' http://localhost:3000/orders/<id>/events   # watch one order
curl -X PATCH http://localhost:3000/orders/<id> \
     -H 'content-type: application/json' -d '{"status":"shipped"}'

node scripts/realtime-demo.mjs               # the proof: two rooms, one event
node scripts/realtime-demo.mjs --same-room   # the control run — see below
```

`X-User-Id` is not decoration: an order's events belong to its buyer, and the stream
enforces that the same way the WebSocket `join` does. See
[one rule, two transports](#one-rule-two-transports).

## WebSocket: a room per order, and who is allowed in

The gateway is Nest's, on the socket.io platform, attached to the same HTTP server the
API answers on. A client connects, sends `join` with an order id, and gets an
acknowledgement saying whether it is in:

```js
const socket = io("http://localhost:3000", { auth: { userId: "1" } });
socket.emit("join", { orderId }, (ack) => console.log(ack));
socket.on("order.status", (event) => console.log(event));
```

The room is `orders:<id>` and the socket enters it **only after the gateway has confirmed
the order belongs to the person asking**. `server.emit` would tell every connected client
when anybody's order shipped; `server.to(room).emit` tells the one order's watchers, and
the membership of that room is decided server-side.

Three refusals, all answered in the `join` acknowledgement rather than by silence:

```
anonymous       {"ok":false,"error":"unauthenticated", ...}
someone else    {"ok":false,"error":"forbidden","detail":"Order … does not belong to user 999."}
the real owner  {"ok":true,"room":"orders:…"}
```

**Where the identity comes from is a placeholder, and the placeholder does not ship.**
There is no authentication in this project yet — the contract describes no customer
resource and carries no credentials — so the identity is a _claim_: `auth: { userId }` in
the handshake, `X-User-Id` over HTTP. A claim is exactly as strong as the client's
honesty, which is to say not at all; anyone can type somebody else's id.

That is harmless while it cannot reach anyone, so it is not allowed to:

```
NODE_ENV=development   SSE as owner -> 200,  demo -> A_RECEIVED=1 B_RECEIVED=0
NODE_ENV=production     SSE as owner -> 403,  join -> {"ok":false,"error":"unauthenticated"}
```

Outside development and test **no claim is accepted and both transports refuse
everyone**, with a warning at boot saying why. Realtime notifications are simply not
available until there is a way to prove who is asking. A feature that is missing is an
honest state; one that looks like it enforces ownership and does not is a lie told to
whoever reads the code next. [`ClaimedIdentityService`](src/orders/services/claimed-identity.service.ts)
is the single place #24 changes — it starts verifying a token, and every refusal above
keeps working untouched.

**Socket.IO does not start on a WebSocket.** Engine.IO opens with HTTP long-polling and
upgrades afterwards, so the first request is `GET /socket.io/?EIO=4&transport=polling`.
That path is not in `openapi.yaml`, so the validator answered it `404`, the upgrade never
happened, and the symptom was a client that silently never connected. `/socket.io` is now
in `ignorePaths` beside `/health` and `/readiness`.

## SSE: the same events over plain HTTP

`GET /orders/{id}/events` is in the contract like every other operation — a `200` whose
content is `text/event-stream`. It is written against the raw response rather than Nest's
`@Sse()` decorator for two reasons: the order is looked up **before** a byte is written,
so an unknown id is an honest `404` instead of an empty stream carrying a `200`; and
`retry:` leads the body, which is how the server sets the client's reconnect pace instead
of leaving it at the browser default of several seconds.

```
retry: 1000

id: 1
event: order.status
data: {"id":1,"order_id":"92619690-…","status":"paid","at":"2026-10-11T15:45:16.900Z"}
```

`id:` counts **within one order**, from 1 — not across all of them. The number is what a
reconnecting client sends back in `Last-Event-ID`, and it has to mean something for this
order alone; a global counter would give each client a sequence full of gaps it could not
tell apart from lost events.

```bash
# after four changes to this order
curl -sN --max-time 2 -H 'X-User-Id: 1' -H 'Last-Event-ID: 3' \
     http://localhost:3000/orders/<id>/events | grep '^id:' | head -1
# id: 4   — the one it missed, and no duplicates of the three it had
```

A `Last-Event-ID` that is not a whole number never reaches the handler: the contract
declares it `integer` with `minimum: 0`, so `Last-Event-ID: abc` is
`400 request/headers/last-event-id must be integer`. Behind that, the code treats an
unreadable value as "live only" rather than "from the start" — a client that has seen
_something_ we cannot identify is better served a gap it will notice than duplicates it
cannot.

The buffer behind that promise is in the process: a hundred events per order, a thousand
orders, least-recently-written evicted first. **It does not survive a restart and it is
not shared between instances** — a client that reconnects to a fresh process gets the live
stream and nothing older. That is the honest limit of an in-memory bus, and #19 is where
it becomes a queue that does survive.

## One rule, two transports

An order's events are its buyer's, over either transport, and the two checks are the same
check:

| Asking                         | WebSocket `join`                         | `GET /orders/{id}/events`                  |
| ------------------------------ | ---------------------------------------- | ------------------------------------------ |
| without saying who you are     | `{"ok":false,"error":"unauthenticated"}` | `400` — the header is required by the spec |
| as somebody else               | `{"ok":false,"error":"forbidden"}`       | `403 application/problem+json`             |
| for an order that is not there | `{"ok":false,"error":"not-found"}`       | `404 application/problem+json`             |
| as the buyer                   | `{"ok":true,"room":"orders:…"}`          | `200 text/event-stream`                    |

The identity itself is the placeholder described above — a claim in the handshake, a
header over HTTP. What matters is that neither transport is the easy way around the other:
a stream that answered anyone would make the gateway's check decorative, because the same
events are one `curl` away.

## Isolation, proved twice

One script, two runs. The flag changes one value — which room the second client joins —
and the expectation checked against it:

```bash
node scripts/realtime-demo.mjs;             echo "exit=$?"
# A_RECEIVED=1
# B_RECEIVED=0
# exit=0

node scripts/realtime-demo.mjs --same-room; echo "exit=$?"
# A_RECEIVED=1
# B_RECEIVED=1
# exit=0
```

The control run is not a bonus feature. A script that simply printed `B_RECEIVED=0` would
pass the first check and look like working isolation; it fails the second one. Only the
pair proves the script is measuring rather than asserting.

## Trade-offs: WebSocket vs SSE

| Criterion                | WebSocket (socket.io)                                           | SSE (`text/event-stream`)                                       |
| ------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------- |
| Direction                | full duplex — the client talks back on the same connection      | server to client only; the client answers with an ordinary POST |
| Reconnect and recovery   | socket.io reconnects; replaying what was missed is your code    | `EventSource` reconnects and resends `Last-Event-ID` for free   |
| Infrastructure           | `Upgrade` must survive every proxy; sticky sessions on 2+ nodes | ordinary HTTP — anything that proxies a response proxies this   |
| Cost per event           | a frame, from two bytes of header                               | a few text lines, plus a keep-alive comment on an idle stream   |
| Addressing one recipient | rooms, server-side, built in                                    | one stream per subscriber; the URL already names the resource   |
| Browser API              | a library, and its own protocol on top                          | `new EventSource(url)` — no dependency                          |

**For order notifications I would keep SSE in production.** The channel is one-directional
— the buyer is told, they never answer down the same pipe — and that is precisely the case
where the standard hands you reconnection and gap-free replay for nothing, over transport
that every proxy and load balancer in the path already understands. The WebSocket is here
because the moment the client starts talking back — a support chat, a live cart shared
between two devices — SSE would need a second channel for the upstream half, and then two
transports are carrying one conversation.

## Two instances, and what breaks

Nothing above needs a Redis adapter today, because there is one process. **With two
instances behind a load balancer a room stops working: `orders:42` is an in-memory label
on one instance's sockets, so an event published on instance A never reaches the client
that happens to be connected to instance B** — the cure is `@socket.io/redis-adapter`,
which forwards emits between instances over Pub/Sub (and sticky sessions on the balancer,
because the Engine.IO handshake is more than one request). The same split hits SSE harder:
its buffer would have to leave the process entirely. That is #23's subject.

## Where things are

| Path                                                                                         | What                                                                     |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [`src/orders/gateways/orders.gateway.ts`](src/orders/gateways/orders.gateway.ts)             | `join`, the ownership check, the fan-out into rooms                      |
| [`src/orders/services/order-events.service.ts`](src/orders/services/order-events.service.ts) | the bus: a Subject plus the replay buffer, shared by both transports     |
| [`src/orders/services/order-status.service.ts`](src/orders/services/order-status.service.ts) | writes the status and announces it — the emit lives here, not in a route |
| [`src/orders/controllers/orders.controller.ts`](src/orders/controllers/orders.controller.ts) | `PATCH /orders/{id}` and the SSE stream                                  |
| [`scripts/realtime-demo.mjs`](scripts/realtime-demo.mjs)                                     | the isolation proof and its control run                                  |

---

# Async-події через RabbitMQ — HW-19

In #18 an order's status reached whoever happened to be connected: no receiver, no
delivery. Here a broker sits between the service and its readers and **keeps the message
until somebody takes responsibility for it**. That is the entire difference between a
transport and a broker, and it is paid for in three separate currencies — work that can
vanish, work that can run twice, and work that can get stuck forever.

```bash
npm run demo:publish     # 5 orders -> 5 events -> 5 effects, nothing in the DLQ
npm run demo:dlq         # one message that can never succeed, and the contour it leaves by
npm run demo:duplicate   # one event, two deliveries, one effect
```

Each one brings its own state to clean, prints `key=value` lines, checks its own invariant
and exits non-zero when it breaks. A green exit code is the result; the numbers below are
there so a reader can tell what the run was supposed to look like.

## `npm run demo:publish` — the event leaves the business operation

```
published=5
buffered=5
delivered=5
effect=5
skipped=0
acked=5
work=0
dlq=0
prefetch=10
```

The five events come from five real checkouts, not from a loop calling the publisher. The
event leaves `CheckoutService` — the same code path `POST /orders` runs — so it leaves
whether the order came from HTTP, from a demo, or from whatever calls checkout next. A
route that published would make the announcement a property of one entry point.

`buffered=5` is the line worth reading twice: **nothing is subscribed at that moment**. The
five messages are sitting in a durable queue with no consumer in existence, and they are
all carried out when one arrives. That is the sentence #18 could not say.

`published` counts confirms, not intentions. The channel is a confirm channel and every
publish is `mandatory: true` with a listener on `basic.return`, so the number only moves
after the broker has both taken the message and routed it. Each publish awaits **its own**
confirm, through the callback form of `publish`, rather than `waitForConfirms()` — that
method resolves only when every publish outstanding on the channel has been answered, and
the channel is shared by every concurrent checkout, so one slow confirm would hold up
orders that have nothing to do with it. Without that pair a publish is
a write to a socket — and worse, **an unroutable message is discarded while the publisher
is told everything is fine**: the broker's responsibility for a message no binding matched
is precisely to throw it away, and it issues a positive confirm having done so. There is
no error, no log and no dead-letter, because a dead-letter exchange belongs to a queue and
the message never reached one. The three cures are `mandatory` plus a return handler, an
alternate exchange on the exchange itself, and an `unroutable` metric; the first is used
here, and the demo would fail with a sentence rather than silently print `published=5`.

## `npm run demo:dlq` — a message that can never succeed

```
published=1
delivered=4
rejected=4
effect=0
work=0
dlq=1
dlq-reason=delivery_limit
```

```
x-first-death-reason : delivery_limit
x-first-death-queue  : shop.order-placed
x-death[0].count     : 1
handler said         : insert or update on table "order_receipts" violates foreign key
                       constraint "FK_d7b2656cc5c1aee6b36f76581a3"
```

The poison is real rather than staged. The event names an order that does not exist, and
`order_receipts.order_id` is a foreign key into `orders` — so no consumer, on any machine,
at any time, can write that receipt. A handler that threw on a magic value would only have
proved that a handler can throw.

What the run shows is that the failure is **bounded**, and that the bound comes from one
specific call. Every rejection is `reject(msg, true)`. Both `reject` and `nack` return a
message to the queue and they look identical in a diff, but only `reject` moves the quorum
queue's delivery counter, so only `reject` ever reaches `x-delivery-limit` and the
dead-letter exchange. `nack(msg, false, true)` leaves the counter where it is: the message
comes back forever, warm and invisible. That is why `OrderPlacedConsumer` rejects and never
nacks. Limit 3, four deliveries, then out — and the cause of death is read off the message
rather than guessed from a log.

RabbitMQ has exactly four reasons for dead-lettering: `rejected`, `expired` (message TTL),
`maxlen` and `delivery_limit`. There is no fifth, and **queue TTL is not one of them** — a
queue that expires disappears taking its contents with it and dead-letters nothing.

Reading `x-death` has one trap worth naming. **`x-death[0]` is the most recent death, not
the first.** RabbitMQ keeps one entry per `{queue, reason}` pair and moves the one it just
touched to the front, so indexing by position is right exactly while a message has died
only once — and starts describing a different hop the moment it dies again, with nothing in
the output looking wrong. Measured on a scratch topology, one message rejected out of two
queues in turn:

```
x-first-death-queue = xd.a
x-death             = [{"q":"xd.b",…},{"q":"xd.a",…}]
```

`x-first-death-queue` and `x-first-death-reason` are the headers that genuinely mean "the
first one" and never move; the counter that belongs beside them is found by looking up the
entry they name, which is what `demo:dlq` does.

The handler makes no attempt to tell a transient failure from a permanent one. It cannot: a
foreign key violation and a dropped connection both arrive as a rejected promise. The
delivery limit is what makes the distinction unnecessary — a transient failure succeeds
within three attempts, a permanent one lands in the DLQ with its reason attached.

One honest limit, since it is invisible from the output. Dead-lettering here runs at the
default `at-most-once` strategy: the message is removed from the work queue as soon as it
has been published to the dead-letter target, without publisher confirms, so a dead-letter
target that is unavailable loses it. The `at-least-once` strategy exists, but it silently
falls back unless the queue also carries `overflow: reject-publish` — the broker accepts
the policy, shows it in `effective_policy_definition`, and mentions the fallback only in
its log. The default is right for this assignment; knowing it is the default is the point.

## `npm run demo:duplicate` — one event, two deliveries, one effect

```
published=1
deliveries=2
effect=1
skipped=1
receipts=1
work=0
dlq=0
prefetch=10
```

The duplicate is caused the way production causes it. A **separate process** takes the
delivery, writes the receipt, and is killed with `SIGKILL` before it acknowledges anything.
`channel.close()` would also have returned the message — closing a channel requeues what it
holds — but a graceful close is not what happens at three in the morning. A process that
disappears leaves the operating system to close the socket, the broker sees a dropped
connection rather than a protocol goodbye, and that is the path a real redelivery takes.

`deliveries=1` would not be a nicer-looking pass. It would mean no duplicate occurred and
the run demonstrated nothing; the usual cause is `noAck: true`, under which the message is
gone at the moment of delivery and there is nothing left to return.

## Why this is at-least-once and not exactly-once

**Exactly-once delivery does not exist — not in RabbitMQ, not in Kafka, not in SQS.** The
AWS documentation says both things two pages apart: "FIFO queues deliver each message
once" on one page, "at-least-once delivery model… no absolute guarantee that a message
won't be delivered more than once" on the next. What this project has is at-least-once
delivery plus an idempotent effect, and together those produce an exactly-once **result**.

There are exactly three places where the outcome is uncertain, and one technique closes all
three:

| Where               | What goes wrong                                        | What this repository does                     |
| ------------------- | ------------------------------------------------------ | --------------------------------------------- |
| producer → broker   | the confirm is lost, the retry publishes a second copy | `eventId` derived from the order, not drawn   |
| broker → consumer   | the ack is lost, the work is handed out again          | the effect is idempotent, so a repeat is free |
| consumer → database | the row is written and the process dies before the ack | same — `demo:duplicate` is exactly this case  |

So: **what had to be done for the result to be one.** The effect is expressed through a
natural key. `order_receipts.order_id` is the primary key, an order has one receipt by
definition, and the consumer writes it with `INSERT … ON CONFLICT (order_id) DO NOTHING`.
Applying that twice is indistinguishable from applying it once, with no registry of seen
message ids to keep in step and nothing to expire.

Two words that are easy to run together, and are not the same thing:

- **idempotency is a property of an operation.** It either has it or it does not.
  `UPDATE orders SET status = 'packed' WHERE id = 42` has it; `UPDATE … SET qty = qty - 1`
  does not, and no amount of care at the call site gives it to it.
- **an idempotency key is a tool** for making an operation that lacks the property safe to
  repeat — and it has to be built. `Idempotency-Key` on `POST /orders` from #09 is one of
  those; `order_receipts.order_id` is not a key at all, it is the first case.

A deduplication set held in the consumer's memory would be neither. It lasts exactly as
long as one instance, does not exist between two replicas, and does not survive a restart —
which is the one event it is supposed to be insurance against.

### Where this stops, honestly

Two gaps are left open on purpose, both of them #22's subject:

- **The order commits and the event is published afterwards.** A broker cannot join a
  Postgres transaction, so there is a window in which the order exists and nobody was told.
  Publishing inside the transaction would be worse — it would announce an order a later
  `40001` rolled back. The repair is a transactional outbox: the event written as a row
  beside the order, a separate process publishing it. Until then a failed publish is logged
  loudly and the customer is still answered, because the order is already committed and
  refusing to answer would trade a repairable failure for an unrecoverable one.
- **"Marked as processed" and "effect applied" are one write here, and would not always
  be.** Because the effect _is_ the mark, this consumer has no gap. The moment a consumer
  needs a separate `processed_messages` row, the two have to share a COMMIT — and a
  separate registry in a separate statement is a window where the key says done and nothing
  happened.

## Why `prefetch=10`

The broker's default is `0`, and **zero means no limit** — measured on this stand:

```bash
docker compose exec rabbitmq rabbitmqctl eval \
  'application:get_env(rabbit, default_consumer_prefetch).'
# {ok,{false,0}}
```

Left at the default, the first consumer to subscribe is handed the entire queue and the
second one idles with nothing to do, however many replicas are running.

**Ten, because the handler is a single INSERT of about 5 ms through the pooler, and ten of
them in flight keep the socket busy across the round trip without parking work on a
consumer that may die holding it** — the safety check is `prefetch × handler time <
consumer_timeout`, which here is 10 × 5 ms = 50 ms against a stock timeout of 30 minutes.
`prefetch=1` is the right answer when a message takes minutes and the wrong one when it
takes milliseconds; at 2 ms per message it would spend a round trip per message. The hard
ceiling on a quorum queue is 2000.

## The topology, and who declares it

```
                 shop.events (topic)
                        │  order.placed
                        ▼
              shop.order-placed  (quorum, x-delivery-limit 3)
                        │  x-dead-letter-exchange
                        ▼
              shop.events.dlx (topic)  ──#──▶  shop.order-placed.dlq (quorum)
```

**The consumer declares it, never the producer.** The moment checkout declares the queue it
publishes into, adding a second reader means editing checkout — and the coupling a broker
was introduced to remove is back with extra steps. The publisher names an exchange and a
routing key and nothing else.

The order of declaration is load-bearing: exchange, then the dead-letter queue, then the
work queue that points at it, then the binding. Publishing before the binding exists is the
silent discard described above.

**Who empties the queue in a deployment:** `npm run start:worker`, its own process. The
three demos each raise a consumer for the length of one run, and the API process
deliberately does not subscribe — two subscribers on one queue would make a demo's numbers
depend on which process won the race, and a consumer wedged on a slow handler must not be
able to stop `/health` from answering. A consumer and an HTTP service scale on different
numbers and fail in different ways, so they are different processes.

It stops the way a container orchestrator expects. On `SIGTERM` the subscription is
cancelled first, so no new delivery arrives, and only then does it wait for the deliveries
already in hand; anything still unacknowledged goes back to the queue, because an ack is
"stop sending me this" and a process on its way out is in no position to say it. That is
the exact opposite of what `demo:duplicate` does on purpose — both end with the message
back in the queue, and only one of them leaves the work half-done.

Quorum queues, not classic: classic queues stopped replicating in 4.0, and
`x-delivery-limit` — the thing that bounds a poison message — is a quorum feature. Classic
mirroring (`ha-mode`) is not an alternative; it was removed in the same release. The broker
is **4.2**, the LTS series with commercial support to 30.06.2030, rather than the current
4.3 — the same reasoning that pins every other version here.

A queue's `x-arguments` cannot be changed once it exists. Changing `x-delivery-limit` and
re-running is answered with `406 PRECONDITION_FAILED`, which is not a client bug and not
something a retry fixes; `declareTopology` catches that one code and prints what to do
about it. A policy can be rewritten in place, which is why production settings usually live
there rather than in a declaration.

## Where things are

| Path                                                                                                                 | What                                                         |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [`src/messaging/services/topology.service.ts`](src/messaging/services/topology.service.ts)                           | exchange, queues, bindings, the dead-letter contour          |
| [`src/messaging/services/order-event-publisher.service.ts`](src/messaging/services/order-event-publisher.service.ts) | confirm channel, `mandatory`, the return listener            |
| [`src/messaging/services/order-placed-consumer.service.ts`](src/messaging/services/order-placed-consumer.service.ts) | prefetch, manual ack after the effect, `reject` never `nack` |
| [`src/orders/entities/order-receipt.entity.ts`](src/orders/entities/order-receipt.entity.ts)                         | the natural key that makes a duplicate free                  |
| [`src/orders/services/checkout.service.ts`](src/orders/services/checkout.service.ts)                                 | where `order.placed` leaves the business operation           |
| [`src/messaging/cli/worker.ts`](src/messaging/cli/worker.ts)                                                         | the process that drains the queue in a deployment            |
| [`src/messaging/cli/`](src/messaging/cli/)                                                                           | the three demos, and the consumer that dies on purpose       |

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
| `BROKER_URL`       | no\*     | —                       | **secrets store**; the dev stand's value is in `docker-compose.yml`                                        | where RabbitMQ is, with credentials inline         |
| `DB_PASSWORD_FILE` | no       | `./secrets/db_password` | **secrets store** — the file itself, rotated by `rotate.sh`                                                | path to the file holding the password              |
| `DB_POOL_MAX`      | no       | `10`                    | environment                                                                                                | maximum pooled connections                         |
| `LOG_LEVEL`        | no       | `log`                   | environment                                                                                                | `error` \| `warn` \| `log` \| `debug` \| `verbose` |

\* `BROKER_URL` is optional **for the HTTP service** and required by the three HW-19 demo
scripts. An order that was placed is still an order when the asynchronous channel is
unreachable, so the service logs that `order.placed` could not be published and still
answers the customer; the demos exist to exercise the broker and have nothing to say
without one. It is also the one connection string here that carries its password inline —
AMQP has no per-connection re-read to hang a rotated secret off, so there is nothing for
`rotate.sh` to hold.

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
docker compose --profile app up -d   # service + Postgres, dev mode with hot-reload
curl -s localhost:3000/health
```

Both of those files are git-ignored, so a fresh clone has neither — and the first run of
the _service_ needs both. `secrets/db_password` especially: Docker silently creates a
_directory_ when a bind-mount source is missing, and the service then fails reading it.
That is why the `app` service sits behind the `app` profile: plain
`docker compose up -d --wait` raises the database, the pooler and the Pact broker, needs
no secret, and is the one line everything else in this file begins with.

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
npm run start:dev     # nest start --watch
npm run typecheck     # generate types from the spec, then tsc --noEmit
npm run lint          # Biome - TypeScript, JavaScript, JSON
npm run format        # Prettier - YAML and Markdown
npm run check         # all of the above plus the spec lint
```

```bash
npm run test:integration   # repositories against a real Postgres
npm run test:e2e           # the whole app through supertest
npm run test:contract      # the consumer test; writes pacts/
npm run verify:provider    # the real service against that contract
```

```bash
npm run start:worker       # drains shop.order-placed; SIGTERM finishes what it holds
npm run demo:publish       # RabbitMQ: 5 orders -> 5 events -> 5 effects
npm run demo:dlq           # a poison message and the contour it leaves by
npm run demo:duplicate     # one event, two deliveries, one effect
```

The demos raise consumers of their own, so a worker left running alongside one will take
messages the demo is counting. Stop it first.

The stack also runs in Docker: `docker compose up -d --wait` raises the data layer, RabbitMQ
(AMQP on 25672, management UI on <http://localhost:25673>) and the Pact broker, `docker compose --profile app up -d` adds the service with hot-reload
alongside Postgres 17, and `docker compose -f docker-compose.yml --profile app up -d --build`
is the production path.
