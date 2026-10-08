# Marketplace API

Contract-first API for a small marketplace. The OpenAPI document in
[`openapi/openapi.yaml`](openapi/openapi.yaml) is the source of truth; the service is a
thin layer behind a validator that enforces it.

| Assignment | What it added                                                                           |
| ---------- | --------------------------------------------------------------------------------------- |
| HW-09      | the OpenAPI contract and runtime validation at the boundary                             |
| HW-11      | NestJS, a validated environment schema, and password rotation without a restart         |
| HW-12      | the data layer: schema, seed, indexes, and EXPLAIN evidence                             |
| HW-13      | TypeORM over that schema: entities, relations, migrations, N+1                          |
| HW-14      | concurrency: a transactional checkout, a SKIP LOCKED worker pool, retries               |
| **HW-15**  | **operations: PgBouncer, a nightly backup, and a restore drill that proves it** — below |

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

A grader has no access to the secret store. These four lines replace it — the dev
credentials of the local stand, which live in [`docker-compose.yml`](docker-compose.yml)
and [`init.sql`](init.sql) on purpose and are not a secret:

```bash
docker compose up -d --wait db pgbouncer
export DATABASE_URL=postgres://marketplace_app:local_dev_password@127.0.0.1:26432/marketplace
export DB_HOST=127.0.0.1 DB_PORT=26432 DB_USER=marketplace_app DB_PASSWORD=local_dev_password DB_NAME=marketplace
export SKIP_VAULT=1   # no access to the store: the values are already in the environment
```

Port **26432 is PgBouncer**, not Postgres — everything goes through the pooler. Two
variable shapes because two kinds of client read them: `DATABASE_URL` is a libpq URI and is
what `scripts/backup.sh` and `scripts/restore-drill.sh` hand to `pg_dump` and `psql`, while
the `DB_*` block is the validated contract `src/database/data-source.ts` reads. One store
fills both — see [Where the credentials come from](#where-the-credentials-come-from).

`--wait db pgbouncer` names the two services rather than raising everything: the `app`
service bind-mounts `secrets/db_password`, which a fresh clone does not have. Nothing below
needs the HTTP service.

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
```

Each of the five demos checks its own invariant and exits non-zero when it breaks, so
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
