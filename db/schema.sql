-- Marketplace API — data layer.
--
-- Four tables, three FOREIGN KEYs, and every rule the API contract already promises
-- pushed down into the database, so a bad row cannot exist even if a handler forgets.
--
-- Apply to a clean database:  psql -f db/schema.sql
-- The DROPs at the top only matter when re-applying; on a clean database they are no-ops.

\set ON_ERROR_STOP on

-- The DROPs below are no-ops on a clean database; without this line psql would still
-- print a NOTICE for each of them.
SET client_min_messages = warning;

DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- ---------------------------------------------------------------------------
-- Money note, once, for all four tables
--
-- Every monetary column is `bigint` holding integer MINOR units (kopiykas), named
-- `*_cents` to say so out loud. This is the same decision `numeric` exists to enforce
-- — exact decimal arithmetic, never binary floating point — taken one step further:
-- the amount is a plain integer count, so addition and multiplication are exact by
-- construction and no scale can drift. `real`/`double precision` and the `money` type
-- are deliberately absent. The OpenAPI contract in openapi/openapi.yaml declares these
-- fields as `integer` (`price_cents`, `total_cents`, `unit_price_cents`,
-- `subtotal_cents`), and the contract is the source of truth for this project, so the
-- storage type follows it rather than the other way round.
-- ---------------------------------------------------------------------------

-- Customers. Not part of the HTTP contract yet: order ownership is what q1 and q3
-- search by, and #14 needs a real owner to hang a transactional checkout on.
CREATE TABLE users (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email        text NOT NULL,
    display_name text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),

    -- Stored as the customer typed it, matched case-insensitively — see q3.
    CONSTRAINT users_email_unique UNIQUE (email),
    CONSTRAINT users_email_shaped CHECK (position('@' IN email) > 1),
    CONSTRAINT users_display_name_not_blank CHECK (length(btrim(display_name)) > 0)
);

-- Product catalogue. `id`, `title`, `price_cents`, `currency` and `in_stock` are the
-- five fields components/schemas/Product declares; `description` is storage-only until
-- a later assignment exposes it.
CREATE TABLE products (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title       text NOT NULL,
    description text NOT NULL DEFAULT '',
    price_cents bigint NOT NULL,
    currency    text NOT NULL DEFAULT 'UAH',
    in_stock    integer NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),

    -- Maintained by Postgres on every INSERT and UPDATE: nothing in the application
    -- can forget to refresh it, and nothing can put a row in the table that the search
    -- index does not know about. `simple` is the honest choice here — see the
    -- "Морфологія (morphology)" section of db/OPTIMIZATIONS.md for what it does and does not do.
    search_vector tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', title || ' ' || description)
    ) STORED,

    CONSTRAINT products_title_not_blank CHECK (length(btrim(title)) > 0),
    CONSTRAINT products_price_cents_nonnegative CHECK (price_cents >= 0),
    CONSTRAINT products_in_stock_nonnegative CHECK (in_stock >= 0),
    CONSTRAINT products_currency_known CHECK (currency IN ('UAH', 'USD', 'EUR'))
);

-- Customer orders. `status` and `currency` repeat the enums the contract declares;
-- adding a value to openapi.yaml without adding it here is caught by the first INSERT.
CREATE TABLE orders (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     bigint NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    status      text NOT NULL DEFAULT 'pending',
    total_cents bigint NOT NULL DEFAULT 0,
    currency    text NOT NULL DEFAULT 'UAH',
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT orders_status_known CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled')),
    CONSTRAINT orders_total_cents_nonnegative CHECK (total_cents >= 0),
    CONSTRAINT orders_currency_known CHECK (currency IN ('UAH', 'USD', 'EUR'))
);

-- Order line items. `unit_price_cents` is the price at the moment of purchase, copied
-- rather than joined: re-pricing a product must never rewrite history.
CREATE TABLE order_items (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id         uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    product_id       uuid NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
    quantity         integer NOT NULL,
    unit_price_cents bigint NOT NULL,
    subtotal_cents   bigint NOT NULL,

    -- The contract documents subtotal_cents as "quantity × unit_price_cents".
    -- A CHECK is how that sentence stops being a comment.
    CONSTRAINT order_items_subtotal_matches CHECK (subtotal_cents = unit_price_cents * quantity),
    CONSTRAINT order_items_quantity_positive CHECK (quantity > 0),
    CONSTRAINT order_items_unit_price_cents_nonnegative CHECK (unit_price_cents >= 0),
    -- One line per product per order: two lines for the same product is a bug, not a
    -- bigger basket. Doubles as the index the order_id FOREIGN KEY wants anyway.
    CONSTRAINT order_items_one_line_per_product UNIQUE (order_id, product_id)
);

-- The service connects as `marketplace_app` (created by init.sql when the database
-- volume is initialised). Guarded so that applying this file to a database without
-- that role is not an error.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'marketplace_app') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO marketplace_app';
        EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO marketplace_app';
    END IF;
END
$$;
