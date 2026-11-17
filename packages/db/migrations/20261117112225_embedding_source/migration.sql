-- Names the text each repo's embedding was made from, so a repo whose summary waits can be found by an embedding of its
-- metadata until the summary's embedding replaces it. Every embedding saved before this is a summary's, which the
-- default says. A column with a constant default is added in the catalog, so this rewrites no rows. It still waits for
-- an exclusive lock on repos, and every read of repos queues behind that wait, so the lock timeout fails the migration
-- rather than let one long statement on repos stall reads. The deploy then stops before the Workers, and a rerun retries
-- the add. The running Workers name the columns they insert and select, so they never see it.
CREATE TYPE "embedding_source" AS ENUM('summary', 'metadata');--> statement-breakpoint
do $embedding_source$
begin
set local lock_timeout = '1s';
ALTER TABLE "repos" ADD COLUMN "embedding_source" "embedding_source" DEFAULT 'summary'::"embedding_source" NOT NULL;
end
$embedding_source$;
