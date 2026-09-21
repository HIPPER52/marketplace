-- Marketplace API — the indexes that cure db/queries/q1..q4.sql.
--
--   psql -f db/indexes.sql
--
-- Four indexes for four queries, and not one more. Every index is a second copy of the
-- data with its own disk cost, which every INSERT and UPDATE then has to maintain — so
-- an index that no query reaches for is a pure loss. After running all four EXPLAIN
-- (ANALYZE) statements, this must come back empty:
--
--   SELECT indexrelname FROM pg_stat_user_indexes
--    WHERE schemaname = 'public' AND idx_scan = 0
--      AND indexrelid NOT IN (SELECT conindid FROM pg_constraint WHERE conindid <> 0);
--
-- Primary keys and UNIQUE constraints are not listed here: schema.sql already creates
-- them, they exist to hold a constraint rather than to serve a query, and zero scans on
-- them is normal.

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
-- EXPRESSION. `users_email_unique` from schema.sql indexes `email`; what the query asks
-- for is `lower(email)`, and a B-tree holds exactly the keys it was built from —
-- 'Oksana.Bondarenko42@…' is not 'oksana.bondarenko42@…'. That is the second failure
-- mode from step 6 of the lecture: a function over a column, an index over the column,
-- and a condition that lands in Filter instead of Index Cond. Index the expression the
-- query actually uses and it lands in Index Cond.
CREATE INDEX idx_users_email_lower ON users (lower(email));

-- q4 — full-text search over the catalogue.
--
-- GIN, not B-tree: a B-tree holds one key per row, while a document has many lexemes
-- and the query asks "which rows contain this lexeme". GIN is that inverted mapping —
-- lexeme -> list of rows. `products.search_vector` is a generated STORED column
-- (schema.sql), so the index tracks every INSERT and UPDATE without anything in the
-- application remembering to refresh it.
CREATE INDEX idx_products_search_vector ON products USING GIN (search_vector);

-- Fresh statistics: a new index the planner has no numbers for is an index the planner
-- will not choose.
ANALYZE;
