-- A v1 icon may be a favicon whose text never rendered or a flat square, and v2 keys stop the check from reusing it.
-- Clearing the check time puts every such row in the next daily backfill.
UPDATE "repos" SET "icon_checked_at" = NULL WHERE "icon_key" LIKE 'v1/%';
