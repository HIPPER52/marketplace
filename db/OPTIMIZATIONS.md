# Query optimisation: EXPLAIN before and after

Four real Marketplace API queries against a database holding 200 000 orders and 120 000
products. For each one: the full `EXPLAIN (ANALYZE, BUFFERS)` before `db/indexes.sql` is
applied and after, and an account of which index entered the plan, what left the plan, and
where the buffers went.

What matters here is **buffers**, not milliseconds. Milliseconds depend on the machine and
on what happens to be in cache; the number of 8 KB pages a query touches depends on the
shape of the data. Times are quoted alongside only to confirm the order of magnitude.

Every number below comes from one run on Postgres 17 (`postgres:17-alpine`, Docker Desktop,
Apple Silicon) starting from an empty volume. The "Database — HW-12" section of
[README.md](../README.md) reproduces that run from the first command. `seed.sql` uses
`random()`, so the exact figures on another machine will differ; what does not differ is
what is being measured — the shape of the plan and the order of magnitude.

## Summary

| Query | Index that entered the plan     | Kind                | Buffers before | after | Gain | Time before | after    |
| ----- | ------------------------------- | ------------------- | -------------- | ----- | ---- | ----------- | -------- |
| q1    | `idx_orders_user_id_created_at` | composite B-tree    | 2 121          | 26    | ×82  | 7.567 ms    | 0.117 ms |
| q2    | `idx_orders_pending_created_at` | partial B-tree      | 2 121          | 52    | ×41  | 9.632 ms    | 0.182 ms |
| q3    | `idx_users_email_lower`         | unique expression   | 280            | 4     | ×70  | 6.238 ms    | 0.055 ms |
| q4    | `idx_products_search_vector`    | GIN over `tsvector` | 23 905         | 867   | ×28  | 51.134 ms   | 2.494 ms |

## q1 — one customer's orders for a period

`db/queries/q1.sql`

```sql
SELECT id, status, total_cents, currency, created_at
FROM orders
WHERE user_id = 42
  AND created_at >= now() - interval '180 days'
ORDER BY created_at DESC
LIMIT 20
```

The most common request the account page makes: "show me my orders from the last six months". Customer 42 has 42 of them out of 200 000 — a selectivity of 0.02%, and without an index 100% of the table is read to find them: `Rows Removed by Filter: 99979` on each of the two workers.

### Before the indexes

```
                                                           QUERY PLAN
---------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=5437.35..5439.54 rows=19 width=43) (actual time=6.117..7.529 rows=20 loops=1)
   Buffers: shared hit=2121
   ->  Gather Merge  (cost=5437.35..5439.54 rows=19 width=43) (actual time=6.116..7.527 rows=20 loops=1)
         Workers Planned: 1
         Workers Launched: 1
         Buffers: shared hit=2121
         ->  Sort  (cost=4437.34..4437.39 rows=19 width=43) (actual time=5.076..5.077 rows=15 loops=2)
               Sort Key: created_at DESC
               Sort Method: quicksort  Memory: 27kB
               Buffers: shared hit=2121
               Worker 0:  Sort Method: quicksort  Memory: 26kB
               ->  Parallel Seq Scan on orders  (cost=0.00..4436.94 rows=19 width=43) (actual time=0.435..5.024 rows=21 loops=2)
                     Filter: ((user_id = 42) AND (created_at >= (now() - '180 days'::interval)))
                     Rows Removed by Filter: 99979
                     Buffers: shared hit=2084
 Planning:
   Buffers: shared hit=99
 Planning Time: 0.295 ms
 Execution Time: 7.567 ms
(19 rows)
```

### After the indexes

```
                                                                   QUERY PLAN
-------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=0.42..82.60 rows=20 width=43) (actual time=0.033..0.085 rows=20 loops=1)
   Buffers: shared hit=26
   ->  Index Scan using idx_orders_user_id_created_at on orders  (cost=0.42..185.32 rows=45 width=43) (actual time=0.032..0.083 rows=20 loops=1)
         Index Cond: ((user_id = 42) AND (created_at >= (now() - '180 days'::interval)))
         Buffers: shared hit=26
 Planning:
   Buffers: shared hit=153
 Planning Time: 0.491 ms
 Execution Time: 0.117 ms
(9 rows)
```

### What changed

The node that appeared is **`idx_orders_user_id_created_at`**, the composite `(user_id, created_at DESC)`. Both conditions moved out of `Filter` and into `Index Cond`, taking `Rows Removed by Filter` with them — and behind that went the `Sort` and `Gather Merge` nodes as well: the index already hands rows back ordered by `created_at DESC`, so there is nothing left to sort and nothing worth parallelising. Buffers fell from 2 121 to 26 — instead of 2 084 heap pages the plan now reads three levels of a B-tree plus exactly the pages holding the 20 rows it wants.

The column order is the contract here: equality on the left, range on the right. `(created_at, user_id)` would have had to walk every order in the window and filter it.

Buffers: **2 121 → 26**. Time: **7.567 ms → 0.117 ms**.

## q2 — the admin queue: pending orders from the last 30 days

`db/queries/q2.sql`

```sql
SELECT id, user_id, total_cents, created_at
FROM orders
WHERE status = 'pending'
  AND created_at >= now() - interval '30 days'
ORDER BY created_at DESC
LIMIT 50
```

What an operator stares at all day. `pending` is 10 151 rows, 5.1% of the table, and 840 of those fall in the last 30 days. The other 95% is what this screen never opens — and a Seq Scan reads all of it anyway.

### Before the indexes

```
                                                            QUERY PLAN
-----------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=5453.83..5459.58 rows=50 width=40) (actual time=8.133..9.581 rows=50 loops=1)
   Buffers: shared hit=2121
   ->  Gather Merge  (cost=5453.83..5512.25 rows=508 width=40) (actual time=8.131..9.576 rows=50 loops=1)
         Workers Planned: 1
         Workers Launched: 1
         Buffers: shared hit=2121
         ->  Sort  (cost=4453.82..4455.09 rows=508 width=40) (actual time=7.040..7.042 rows=39 loops=2)
               Sort Key: created_at DESC
               Sort Method: top-N heapsort  Memory: 30kB
               Buffers: shared hit=2121
               Worker 0:  Sort Method: top-N heapsort  Memory: 31kB
               ->  Parallel Seq Scan on orders  (cost=0.00..4436.94 rows=508 width=40) (actual time=0.034..6.942 rows=420 loops=2)
                     Filter: ((status = 'pending'::text) AND (created_at >= (now() - '30 days'::interval)))
                     Rows Removed by Filter: 99580
                     Buffers: shared hit=2084
 Planning:
   Buffers: shared hit=99
 Planning Time: 0.339 ms
 Execution Time: 9.632 ms
(19 rows)
```

### After the indexes

```
                                                                    QUERY PLAN
---------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=0.29..167.00 rows=50 width=40) (actual time=0.027..0.157 rows=50 loops=1)
   Buffers: shared hit=52
   ->  Index Scan using idx_orders_pending_created_at on orders  (cost=0.29..2947.76 rows=884 width=40) (actual time=0.026..0.152 rows=50 loops=1)
         Index Cond: (created_at >= (now() - '30 days'::interval))
         Buffers: shared hit=52
 Planning:
   Buffers: shared hit=150
 Planning Time: 0.445 ms
 Execution Time: 0.182 ms
(9 rows)
```

### What changed

The node that appeared is **`idx_orders_pending_created_at`**, the partial `(created_at DESC) WHERE status = 'pending'`. The status condition vanished from the plan entirely: it is baked into the index itself, so `Index Cond` carries only the date range and there is no `Filter` line at all. `Sort` and `Gather Merge` went with it, and buffers fell from 2 121 to 52.

The price is 240 kB against the 6 320 kB a full `(status, created_at)` would take: the index holds only the 5% of rows the query asks about, and only that 5% is paid for on every `INSERT`. The other side of that bargain — the same query asked for `status = 'cancelled'` will not see this index at all. A partial index is used only when the query's `WHERE` literally covers the index's `WHERE`.

Buffers: **2 121 → 52**. Time: **9.632 ms → 0.182 ms**.

## q3 — find a customer by e-mail, whatever case they typed

`db/queries/q3.sql`

```sql
SELECT id, email, display_name, created_at
FROM users
WHERE lower(email) = lower('OKSANA.BONDARENKO42@EXAMPLE.COM')
```

The address is stored the way the customer wrote it and searched for in any case at all. An index over `email` cannot answer that question: a B-tree holds exactly the keys it was built from, and `Oksana.Bondarenko42@example.com` is not `oksana.bondarenko42@example.com`. This is the second way the planner says no — a function over a column, an index over the column, and a condition that lands in `Filter`.

### Before the indexes

```
                                             QUERY PLAN
----------------------------------------------------------------------------------------------------
 Seq Scan on users  (cost=0.00..580.00 rows=100 width=81) (actual time=0.017..6.219 rows=1 loops=1)
   Filter: (lower(email) = 'oksana.bondarenko42@example.com'::text)
   Rows Removed by Filter: 19999
   Buffers: shared hit=280
 Planning:
   Buffers: shared hit=69
 Planning Time: 0.274 ms
 Execution Time: 6.238 ms
(8 rows)
```

### After the indexes

```
                                                          QUERY PLAN
------------------------------------------------------------------------------------------------------------------------------
 Index Scan using idx_users_email_lower on users  (cost=0.41..8.43 rows=1 width=81) (actual time=0.015..0.016 rows=1 loops=1)
   Index Cond: (lower(email) = 'oksana.bondarenko42@example.com'::text)
   Buffers: shared hit=4
 Planning:
   Buffers: shared hit=94
 Planning Time: 0.331 ms
 Execution Time: 0.055 ms
(7 rows)
```

### What changed

The node that appeared is **`idx_users_email_lower`**, an expression index over `lower(email)`. The condition moved from `Filter` to `Index Cond`, `Rows Removed by Filter: 19999` disappeared, and buffers fell from 280 — the whole table — to 4: three levels of the tree and one heap page. Index the expression the query actually uses, not the column it is derived from.

That index is also `UNIQUE`, and that half of it is not an optimisation at all. Uniqueness on `email` would be the wrong rule: it admits `A@example.com` and `a@example.com` as two rows, and then this very query returns two people for one address. Postgres offers no UNIQUE table constraint over an expression — only a unique index — so the constraint and the index this query needs are necessarily one object, and it is declared in `db/indexes.sql` because that is where it physically lives.

Buffers: **280 → 4**. Time: **6.238 ms → 0.055 ms**.

## q4 — full-text search over the catalogue

`db/queries/q4.sql`

```sql
SELECT id, title, ts_rank(search_vector, plainto_tsquery('simple', 'шкіряні кросівки')) AS rank
FROM products
WHERE search_vector @@ plainto_tsquery('simple', 'шкіряні кросівки')
ORDER BY rank DESC, id
LIMIT 20
```

A shopper types two words and the storefront answers with 20 cards. `plainto_tsquery` turns "шкіряні кросівки" into `'шкіряні' & 'кросівки'` — 856 matches out of 120 000, or 0.71% of the catalogue. Without an index Postgres has to unpack and test the `search_vector` of all 120 000 products: `Rows Removed by Filter: 119144`.

### Before the indexes

```
                                                       QUERY PLAN
------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=25422.26..25422.31 rows=20 width=69) (actual time=51.072..51.075 rows=20 loops=1)
   Buffers: shared hit=11066 read=12839
   ->  Sort  (cost=25422.26..25424.26 rows=799 width=69) (actual time=51.071..51.072 rows=20 loops=1)
         Sort Key: (ts_rank(search_vector, '''шкіряні'' & ''кросівки'''::tsquery)) DESC, id
         Sort Method: top-N heapsort  Memory: 29kB
         Buffers: shared hit=11066 read=12839
         ->  Seq Scan on products  (cost=0.00..25401.00 rows=799 width=69) (actual time=0.048..50.864 rows=856 loops=1)
               Filter: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
               Rows Removed by Filter: 119144
               Buffers: shared hit=11060 read=12839
 Planning:
   Buffers: shared hit=94
 Planning Time: 0.413 ms
 Execution Time: 51.134 ms
(14 rows)
```

### After the indexes

```
                                                                     QUERY PLAN
----------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=2855.94..2855.99 rows=20 width=69) (actual time=2.452..2.455 rows=20 loops=1)
   Buffers: shared hit=867
   ->  Sort  (cost=2855.94..2858.00 rows=824 width=69) (actual time=2.451..2.452 rows=20 loops=1)
         Sort Key: (ts_rank(search_vector, '''шкіряні'' & ''кросівки'''::tsquery)) DESC, id
         Sort Method: top-N heapsort  Memory: 29kB
         Buffers: shared hit=867
         ->  Bitmap Heap Scan on products  (cost=25.85..2834.02 rows=824 width=69) (actual time=0.836..2.313 rows=856 loops=1)
               Recheck Cond: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
               Heap Blocks: exact=846
               Buffers: shared hit=861
               ->  Bitmap Index Scan on idx_products_search_vector  (cost=0.00..25.64 rows=824 width=0) (actual time=0.771..0.771 rows=856 loops=1)
                     Index Cond: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
                     Buffers: shared hit=15
 Planning:
   Buffers: shared hit=149
 Planning Time: 0.537 ms
 Execution Time: 2.494 ms
(17 rows)
```

### What changed

The node that appeared is **`idx_products_search_vector`**, a GIN index over `tsvector`, entering the plan as a `Bitmap Index Scan`. The `Seq Scan` was replaced by a pair — `Bitmap Index Scan` (15 index pages) feeding `Bitmap Heap Scan` (`Heap Blocks: exact=846`) — and 23 905 pages became 867.

The gain here is more modest than the other three, 28× rather than eighty, and that is not a shortcoming of the index. The 856 matches are scattered across the whole heap, and a product row carrying a description and a `tsvector` leaves room for only about five rows per 8 KB page, so nearly every match costs a page of its own. The floor here is the physical layout of the rows, not the structure of the index. Measured in time the gain is larger (20×), because the `@@` test no longer runs against 119 144 documents that were never going to match.

Buffers: **23 905 (11 066 hit + 12 839 read) → 867**. Time: **51.134 ms → 2.494 ms**.

## The fifth index: the one no query asks for

`db/indexes.sql` holds one more index than there are queries, and it is worth being
explicit about why.

`order_items.product_id` references `products.id`. Postgres indexes the referenced side of
a foreign key automatically — it has to be a primary key or unique — and the referencing
side not at all. So every `DELETE` of a product, and every update of a product id, fires an
`ON DELETE RESTRICT` check that has to find the referencing line items. With no index on
`product_id`, that check is a sequential scan of all 400 001 of them:

```
 LockRows  (actual time=0.511..14.335 rows=4 loops=1)
   Buffers: shared hit=136 read=4418
   ->  Seq Scan on order_items x
         Filter: (product_id = '5380cef9-…'::uuid)
         Rows Removed by Filter: 399997
 Execution Time: 14.350 ms
```

`order_items_one_line_per_product` does not help: it is `(order_id, product_id)`, and a
composite B-tree can only be entered from its leading column. With
`idx_order_items_product_id` in place the same check reads 15 pages instead of 4 554:

```
 LockRows  (actual time=0.050..0.090 rows=4 loops=1)
   Buffers: shared hit=14 read=1
   ->  Bitmap Heap Scan on order_items x
         ->  Bitmap Index Scan on idx_order_items_product_id
               Index Cond: (product_id = '5380cef9-…'::uuid)
```

That is a 300× difference on an operation the four queries in `db/queries/` never perform —
which is the point worth keeping. An index audit run after four `SELECT`s will report this
index as unused, and it is not: the referential integrity trigger reads it and increments
the same `idx_scan` counter as any other reader. Measured on this database:

```sql
-- after the four EXPLAIN (ANALYZE) statements and nothing else
SELECT indexrelname FROM pg_stat_user_indexes
 WHERE schemaname = 'public' AND idx_scan = 0
   AND indexrelid NOT IN (SELECT conindid FROM pg_constraint WHERE conindid <> 0);
-- idx_order_items_product_id

BEGIN;
DELETE FROM products WHERE id = md5('product:777')::uuid;   -- rejected by the FK, as intended
ROLLBACK;

-- the same query again
-- (0 rows)
```

"Unused" is always relative to the workload you exercised. Four read queries are not the
workload of a marketplace.

## What the indexes cost

An index is not free decoration: it is a second copy of the data that every `INSERT` and
`UPDATE` has to maintain. So `db/indexes.sql` holds exactly five indexes — four for the
four queries and one for the foreign key above — and none of them is dead once every kind
of reader has run.

The `pg_constraint` subquery in that audit excludes the indexes behind `PRIMARY KEY` and
`UNIQUE` constraints: they hold a constraint rather than serve a query, and zero scans on
them is normal. Without that filter the output would also list `users_pkey`,
`order_items_pkey` and `order_items_one_line_per_product`, and a genuinely dead index would
be easy to miss in that noise. Note that `idx_users_email_lower` is _not_ excluded by it —
a unique index created with `CREATE UNIQUE INDEX` has no `pg_constraint` row — and it does
not need to be: q3 reads it.

| Index                           | Size    | Note                                                                         |
| ------------------------------- | ------- | ---------------------------------------------------------------------------- |
| `idx_orders_user_id_created_at` | 6184 kB | composite, over the whole table                                              |
| `idx_orders_pending_created_at` | 240 kB  | partial — a full `(status, created_at)` takes 6320 kB, twenty-six times more |
| `idx_users_email_lower`         | 1176 kB | unique expression — a constraint and q3's index in one object                |
| `idx_products_search_vector`    | 9776 kB | GIN over `tsvector`                                                          |
| `idx_order_items_product_id`    | 6728 kB | read by the foreign key check, not by any query in `db/queries/`             |

Separately, the price of the stored `tsvector` column, measured on this same table:

| What                                                            | Size   |
| --------------------------------------------------------------- | ------ |
| a copy of `products` without the `search_vector` column         | 78 MB  |
| the `products` heap as it stands (`pg_relation_size`)           | 187 MB |
| `products` with its GIN index and PK (`pg_total_relation_size`) | 201 MB |

The stored `tsvector` inflates the table roughly 2.4×, and the GIN index takes another
9776 kB on top. That is a fair price for never having to maintain the column by hand — it
is `GENERATED ALWAYS AS (…) STORED`, so no `INSERT` can put a product in the catalogue that
search cannot see. But the price has to be said out loud: writes to `products` are
noticeably slower than they would be without it, and every sequential scan of the catalogue
now reads 2.4× as many pages.

## Морфологія (morphology)

A word this search finds, and the same word in the genitive plural, counted on this same
database:

| Word form  | Query                                   | Matches   |
| ---------- | --------------------------------------- | --------- |
| `кросівки` | `plainto_tsquery('simple', 'кросівки')` | **10158** |
| `кросівок` | `plainto_tsquery('simple', 'кросівок')` | **0**     |

```sql
SELECT count(*) FROM products WHERE search_vector @@ plainto_tsquery('simple', 'кросівки');
-- 10158
SELECT count(*) FROM products WHERE search_vector @@ plainto_tsquery('simple', 'кросівок');
-- 0
```

The reason: the `simple` configuration has no dictionary. It splits text into tokens and
lower-cases them, and that is all. `'кросівки'` and `'кросівок'` come out of that as two
unrelated lexemes, and nothing anywhere tells the database they are one word. A shopper
searching for "пара кросівок" — a pair of trainers, in the case Ukrainian grammar demands
after a quantity — finds nothing, in a catalogue holding 10 158 of them.

Swapping `simple` for `russian` does not fix this. Verified on this same database, with the
Russian configuration on both sides:

```sql
SELECT to_tsvector('russian', 'кросівки'), to_tsvector('russian', 'кросівок');
-- 'кросівк':1   |   'кросівок':1

SELECT count(*) FROM products
 WHERE to_tsvector('russian', title || ' ' || description) @@ plainto_tsquery('russian', 'кросівок');
-- 0
```

The Russian stemmer stripped the ending off `кросівки` and produced `кросівк`, and left
`кросівок` exactly as it was: it knows nothing about the vowel that appears in the Ukrainian
genitive plural. Zero stayed zero — and it is a worse zero than `simple` gave, because now
it hides behind the appearance of working morphology.

Why there is no third option is visible in the catalogue of configurations:

```sql
SELECT count(*) FROM pg_ts_config;
-- 29
```

All 29 of them: arabic, armenian, basque, catalan, danish, dutch, english, finnish, french,
german, greek, hindi, hungarian, indonesian, irish, italian, lithuanian, nepali, norwegian,
portuguese, romanian, russian, serbian, **simple**, spanish, swedish, tamil, turkish,
yiddish. Ukrainian is not among them: Postgres ships Snowball dictionaries, and no Snowball
stemmer for Ukrainian exists. Fixing this has to come from outside the database — an
`ispell` or `hunspell` Ukrainian dictionary dropped into `$SHAREDIR/tsearch_data`, or a
dedicated search engine.

This assignment does not ask for that fix. It asks to see the problem and name it. This is
why a marketplace cannot simply "add search": for English `to_tsvector('english', …)` works
out of the box, and for Ukrainian the very same line of code quietly degrades into an exact
match on one word form.
