-- Marketplace API — seed data.
--
--   psql -f db/seed.sql
--
-- Volume, not decoration: 120 000 products and 200 000 orders. On a thousand rows the
-- planner is right to ignore every index, and none of the EXPLAINs in
-- db/OPTIMIZATIONS.md would show anything at all.
--
-- Distributions are skewed the way real ones are: most orders are `shipped`, most
-- customers order once or twice while a few order constantly, most of the catalogue
-- costs little and a few items cost a lot, and recent months are busier than old ones.
--
-- Product titles and descriptions are Ukrainian on purpose — q4 searches them, and the
-- "Морфологія (morphology)" section of db/OPTIMIZATIONS.md has nothing to measure on Latin text.
--
-- random() makes the data different on every run. That is fine: every criterion here
-- depends on the shape of the distribution and on the row count, not on exact values.
-- The two things queries address by name — customer 42 and the phrase
-- "шкіряні кросівки" — are deterministic.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Customers — 20 000
--
-- Identity values are written explicitly so that `user_id = 42` in db/queries/q1.sql
-- and that customer's e-mail in db/queries/q3.sql mean the same person on every run.
-- E-mails keep the capitalisation the customer typed; q3 is what deals with that.
-- ---------------------------------------------------------------------------
INSERT INTO users (id, email, display_name, created_at)
OVERRIDING SYSTEM VALUE
SELECT
    g,
    v.login || '.' || v.surname || g || '@' || v.domain,
    v.given_ua || ' ' || v.surname_ua,
    now() - (random() * 900)::int * interval '1 day'
FROM generate_series(1, 20000) AS g
CROSS JOIN LATERAL (
    SELECT
        (ARRAY['Olena','Andrii','Iryna','Dmytro','Nataliia','Serhii',
               'Oksana','Volodymyr','Mariia','Taras','Yuliia','Bohdan'])[1 + (g % 12)]        AS login,
        (ARRAY['Олена','Андрій','Ірина','Дмитро','Наталія','Сергій',
               'Оксана','Володимир','Марія','Тарас','Юлія','Богдан'])[1 + (g % 12)]           AS given_ua,
        (ARRAY['Kovalenko','Shevchenko','Bondarenko','Tkachenko','Melnyk',
               'Kravchuk','Polishchuk','Savchenko','Lysenko','Hrytsenko'])[1 + (g % 10)]      AS surname,
        (ARRAY['Коваленко','Шевченко','Бондаренко','Ткаченко','Мельник',
               'Кравчук','Поліщук','Савченко','Лисенко','Гриценко'])[1 + (g % 10)]           AS surname_ua,
        (ARRAY['example.com','mail.example.org','shop.example.net'])[1 + (g % 3)]             AS domain
) AS v;

SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT max(id) FROM users));

-- ---------------------------------------------------------------------------
-- 2. Catalogue — 120 000 products
--
-- `search_vector` is a generated column, so every row below indexes itself.
--
-- The adjective and the noun are drawn with power(random(), n), which biases the draw
-- towards the head of each array: "спортивні футболки" is a common pair, the pair q4
-- looks for is an uncommon one. That skew is the point — a phrase matching a third of
-- the catalogue would make Seq Scan the correct plan even with a GIN index in place.
--
-- Ids are derived from the series so that section 3 can attach line items to products
-- without a lookup table.
-- ---------------------------------------------------------------------------
INSERT INTO products (id, title, description, price_cents, currency, in_stock, created_at)
SELECT
    md5('product:' || g)::uuid,
    upper(substr(v.adj, 1, 1)) || substr(v.adj, 2) || ' ' || v.noun || ' ' || v.brand || ' ' || v.model,
    v.brand || ' ' || v.model || ' — ' || v.adj || ' ' || v.noun || ' ' || v.purpose || '. '
        || v.feature || '. ' || v.care
        || '. Відправляємо з Києва наступного робочого дня, доставка по всій Україні, '
        || 'обмін і повернення протягом чотирнадцяти днів.',
    20000 + floor(power(random(), 2.2) * 2500000)::bigint,
    'UAH',
    floor(power(random(), 3) * 60)::int,
    now() - (random() * 900)::int * interval '1 day'
FROM generate_series(1, 120000) AS g
CROSS JOIN LATERAL (
    SELECT
        (ARRAY['спортивні','зимові','шкіряні','класичні','літні','текстильні','замшеві',
               'вовняні','бавовняні','утеплені','легкі','водовідштовхувальні',
               'дитячі','чоловічі','жіночі'])[1 + floor(power(random(), 2.0) * 15)::int]     AS adj,
        (ARRAY['футболки','кросівки','сумки','шкарпетки','рюкзаки','куртки','джинси',
               'шапки','светри','черевики','шарфи','рукавички','чоботи','сандалі','капці',
               'гаманці','ремені','окуляри','годинники','навушники'])
               [1 + floor(power(random(), 1.6) * 20)::int]                                    AS noun,
        (ARRAY['Карпати','Дніпро','Либідь','Тиса','Ворскла','Стрий','Псел','Сула','Рось',
               'Збруч'])[1 + (g % 10)]                                                        AS brand,
        'M' || (1000 + (g % 9000))                                                            AS model,
        (ARRAY['для щоденного носіння у місті',
               'для активного відпочинку на природі',
               'для тренувань у залі та на вулиці',
               'для довгих прогулянок вихідними',
               'для роботи та ділових зустрічей',
               'для подорожей і відряджень'])[1 + floor(random() * 6)::int]                   AS purpose,
        (ARRAY['Посилені шви та міцна фурнітура витримують щоденне навантаження',
               'Дихаюча підкладка тримає форму навіть у спеку',
               'Антиковзна підошва з глибоким протектором',
               'Регульовані ремені підлаштовуються під будь-яку фігуру',
               'Водовідштовхувальне просочення захищає від дощу',
               'Вставки зі світловідбивної тканини помітні у темряві'])[1 + floor(random() * 6)::int] AS feature,
        (ARRAY['Догляд простий: суха чистка або волога серветка',
               'Можна прати вручну при тридцяти градусах',
               'Зберігайте у сухому провітрюваному місці',
               'Не сушіть на батареї та під прямим сонцем',
               'Тримає форму навіть після повного сезону'])[1 + floor(random() * 5)::int]     AS care
) AS v;

-- ---------------------------------------------------------------------------
-- 3. Orders — 200 000 — and their line items — ~400 000
--
-- Line items are built first, into a temporary table, so that orders.total_cents can be
-- inserted already correct. The obvious alternative — insert orders, then UPDATE them
-- with the computed totals — would leave 200 000 dead row versions behind before the
-- file has even finished: that is the bloat from step 8 of the lecture, created by hand.
--
-- Which product a line points at is arithmetic, not random, so a basket never contains
-- the same product twice (order_items_one_line_per_product).
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE seed_items AS
SELECT
    md5('order:' || g)::uuid             AS order_id,
    p.id                                 AS product_id,
    (1 + ((g + k) % 4))::int             AS quantity,
    p.price_cents                        AS unit_price_cents,
    p.price_cents * (1 + ((g + k) % 4))  AS subtotal_cents
FROM generate_series(1, 200000) AS g
CROSS JOIN LATERAL generate_series(1, 1 + (g % 3)) AS k
JOIN products p ON p.id = md5('product:' || (1 + ((g * 7 + k * 13) % 120000)))::uuid;

-- status: ~5% pending, ~15% paid, ~72% shipped, ~8% cancelled. The admin screen behind
-- q2 only ever looks at the 5%, which is what makes a partial index worth its disk.
--
-- created_at: power(random(), 1.3) over two years, so roughly a tenth of all orders
-- land in the last 30 days and about a third in the last 180 — busy recent months, a
-- long thin tail behind them.
--
-- `roll` is drawn inside the aggregating subquery, not in a LATERAL beside it. An
-- uncorrelated LATERAL has no reference to the outer row, so the planner is free to
-- evaluate it once and reuse the value for the whole INSERT — which it does, and every
-- order comes out with the same status. An aggregate blocks that flattening, so the
-- draw happens once per group, which is once per order.
INSERT INTO orders (id, user_id, status, total_cents, currency, created_at)
SELECT
    t.order_id,
    1 + floor(power(random(), 2.0) * 20000)::int,
    CASE
        WHEN t.roll < 0.05 THEN 'pending'
        WHEN t.roll < 0.20 THEN 'paid'
        WHEN t.roll < 0.92 THEN 'shipped'
        ELSE 'cancelled'
    END,
    t.total_cents,
    'UAH',
    now() - power(random(), 1.3) * 720 * interval '1 day'
FROM (
    SELECT order_id, sum(subtotal_cents) AS total_cents, random() AS roll
    FROM seed_items
    GROUP BY order_id
) AS t;

INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents, subtotal_cents)
SELECT order_id, product_id, quantity, unit_price_cents, subtotal_cents
FROM seed_items;

DROP TABLE seed_items;

-- ---------------------------------------------------------------------------
-- 4. Statistics and the visibility map
--
-- VACUUM (ANALYZE), not a bare ANALYZE. ANALYZE alone gives the planner its histograms,
-- but only VACUUM sets the visibility map — and without the visibility map an Index
-- Only Scan still has to visit the heap for every row it returns (`Heap Fetches:` in
-- the plan), which costs hundreds of pages the plan did not need to pay.
-- ---------------------------------------------------------------------------
VACUUM (ANALYZE);
