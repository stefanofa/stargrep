-- How many synced developers are into each topic. Counting them live took 17 s on prod, so the nightly topics refresh
-- stores the count. A constant default rewrites no rows, and the column reads 0 until the next refresh, or until
-- `bun run --cwd packages/db refresh-topics` runs after the deploy.
ALTER TABLE "topics" ADD COLUMN "devs" integer DEFAULT 0 NOT NULL;
