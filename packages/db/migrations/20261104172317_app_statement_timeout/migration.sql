-- Hyperdrive drops Postgres's cancel request, so a query the app gives up on after 10 seconds would keep running.
-- The server stops it a second later instead. The setting covers the role the app and migrations share, in this
-- database only, and applies to sessions opened after it. A migration or a script that needs longer runs
-- SET LOCAL statement_timeout = 0 inside its transaction, or SET statement_timeout = 0 on a direct connection.
DO $$
BEGIN
  EXECUTE format('ALTER ROLE %I IN DATABASE %I SET statement_timeout = %L', current_user, current_database(), '11s');
END
$$;
