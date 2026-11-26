SELECT id, user_id, total_cents, created_at
FROM orders
WHERE status = 'pending'
  AND created_at >= now() - interval '30 days'
ORDER BY created_at DESC
LIMIT 50
