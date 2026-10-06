CREATE ROLE marketplace_app WITH LOGIN PASSWORD 'local_dev_password';

GRANT CONNECT ON DATABASE marketplace TO marketplace_app;
GRANT USAGE ON SCHEMA public TO marketplace_app;
