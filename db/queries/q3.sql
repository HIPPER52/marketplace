SELECT id, email, display_name, created_at
FROM users
WHERE lower(email) = lower('OKSANA.BONDARENKO42@EXAMPLE.COM')
