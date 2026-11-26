-- Marketplace API — the indexes that cure db/queries/q1..q4.sql.
--
--   psql -f db/indexes.sql
--
-- Four indexes for the four queries, plus one the foreign keys need, and not one more.
-- Every index is a second copy of the data with its own disk cost, which every INSERT and
-- UPDATE then has to maintain — so an index nothing reaches for is a pure loss. This must
-- come back empty once every reader has run:
--
--   SELECT indexrelname FROM pg_stat_user_indexes
--    WHERE schemaname = 'public' AND idx_scan = 0
--      AND indexrelid NOT IN (SELECT conindid FROM pg_constraint WHERE conindid <> 0);
--
-- "Every reader" is the operative phrase: four EXPLAIN (ANALYZE) statements are not the
-- whole workload. `idx_order_items_product_id` at the bottom of this file is read by the
-- referential integrity trigger and by nothing in db/queries/, and it increments the same
-- counter when that trigger fires.
--
-- Primary keys and UNIQUE constraints are not listed by that query at all: schema.sql
-- creates them, they exist to hold a constraint rather than to serve a query, and zero
-- scans on them is normal. `idx_users_email_lower` is the exception that proves the rule
-- — it is a constraint AND the index q3 needs, so it is here and it does get counted.

\set ON_ERROR_STOP on

-- q1 — "this customer's orders for a period".
--
-- Composite, and the column order is the whole contract: equality on the left, range on
-- the right. (user_id, created_at) narrows to one customer and then walks their orders
-- in date order; (created_at, user_id) would have to scan every order in the window and
-- filter. DESC matches the ORDER BY, so the plan needs no Sort node at all.
CREATE INDEX idx_orders_user_id_created_at ON orders (user_id, created_at DESC);

-- q2 — the admin screen: "pending orders from the last 30 days".
--
-- PARTIAL. `pending` is ~5% of the table and the other 95% is what an admin never opens
-- — so indexing `shipped` rows would be paying disk and write time for entries no query
-- will ever read. The index holds only the rows its WHERE clause admits, which makes it
-- roughly twenty times smaller than the full (status, created_at) equivalent.
--
-- The price of that: the planner may only use it when the query's WHERE literally
-- covers the index's WHERE. The same query asked for status = 'cancelled' gets a Seq
-- Scan, because for cancelled orders this index does not exist.
CREATE INDEX idx_orders_pending_created_at ON orders (created_at DESC)
    WHERE status = 'pending';

-- q3 — "find the customer by e-mail, whatever case they typed it in".
--
-- EXPRESSION. A B-tree holds exactly the keys it was built from, so an index over
-- `email` cannot answer a question about `lower(email)`: 'Oksana.Bondarenko42@…' is not
-- 'oksana.bondarenko42@…'. That is the second failure mode from step 6 of the lecture —
-- a function over a column, an index over the column, and a condition that lands in
-- Filter instead of Index Cond. Index the expression the query actually uses.
--
-- UNIQUE, and that is not an optimisation. Uniqueness on `email` would be the wrong rule
-- (see the comment on the users table in schema.sql): two addresses differing only in
-- case are one account, and without this the table can hold both while q3 matches both.
-- Postgres has no UNIQUE table constraint over an expression, only a unique index, so the
-- constraint and the index q3 needs are necessarily the same object — declared here
-- rather than in schema.sql because this is where it physically is.
--
-- Note for the day the data is already dirty: building this over a table that already
-- holds case-duplicates fails, and it should. Deduplicate first.
CREATE UNIQUE INDEX idx_users_email_lower ON users (lower(email));

-- q4 — full-text search over the catalogue.
--
-- GIN, not B-tree: a B-tree holds one key per row, while a document has many lexemes
-- and the query asks "which rows contain this lexeme". GIN is that inverted mapping —
-- lexeme -> list of rows. `products.search_vector` is a generated STORED column
-- (schema.sql), so the index tracks every INSERT and UPDATE without anything in the
-- application remembering to refresh it.
CREATE INDEX idx_products_search_vector ON products USING GIN (search_vector);

-- No query in db/queries/ reaches for this one — the referential integrity machinery does.
--
-- `order_items.product_id` references `products.id`. Postgres indexes the referenced side
-- automatically (it is a primary key) and the referencing side not at all, so every
-- DELETE or key UPDATE on a product runs an ON DELETE RESTRICT check that has to find the
-- referencing rows. Without this index that check is a Seq Scan over all 400 001 line
-- items — measured at 4554 buffers and 14.3 ms for deleting one product, and it gets
-- worse linearly for the life of the table. With it: 15 buffers, 0.06 ms.
--
-- `order_items_one_line_per_product` does not cover this. It is `(order_id, product_id)`
-- and a composite B-tree can only be entered from its leading column.
--
-- This index is not exempt from the audit above, and it does not need to be: the RI
-- trigger increments `idx_scan` like any other reader. Verified — after
-- `BEGIN; DELETE FROM products WHERE id = …; ROLLBACK;` its counter goes from 0 to 1.
-- Four SELECTs alone simply never touch it, which says something about the four SELECTs
-- rather than about the index.
CREATE INDEX idx_order_items_product_id ON order_items (product_id);

-- Fresh statistics: a new index the planner has no numbers for is an index the planner
-- will not choose.
ANALYZE;
