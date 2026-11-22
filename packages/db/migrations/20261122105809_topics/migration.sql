-- Topic pages. repo_topics holds every GitHub topic of every repo GitHub still serves that is not archived, with the
-- repo's kinds, so the nightly refresh reads narrow rows instead of the 6 GB repos heap. Triggers on repos rewrite a
-- repo's rows in the statement that changes its topics, kinds, archived, or gone_at. The refresh fills topic_repos and
-- topics, so all three start empty here, and `bun run --cwd packages/db backfill-topics` fills repo_topics for the
-- repos that existed before, in short batches, after the deploy. On a branch of prod, one statement that filled it
-- took 97 s, a write lock on repos too long for a deploy.
CREATE TYPE "topic_role" AS ENUM('core', 'built', 'tagged', 'home');--> statement-breakpoint
CREATE TABLE "repo_topics" (
	"repo_id" bigint,
	"topic" text,
	"kinds" "knowledge_kind"[] NOT NULL,
	CONSTRAINT "repo_topics_pkey" PRIMARY KEY("repo_id","topic")
);
--> statement-breakpoint
CREATE TABLE "topic_repos" (
	"topic" text,
	"repo_id" bigint,
	"role" "topic_role" NOT NULL,
	CONSTRAINT "topic_repos_pkey" PRIMARY KEY("topic","repo_id")
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"topic" text PRIMARY KEY,
	"repos" integer NOT NULL,
	"ranked" integer NOT NULL,
	"home" bigint,
	"core" jsonb DEFAULT '[]' NOT NULL,
	"built" jsonb DEFAULT '[]' NOT NULL,
	"related" jsonb DEFAULT '[]' NOT NULL,
	"people" jsonb DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX "repo_topics_topic_idx" ON "repo_topics" ("topic","repo_id");--> statement-breakpoint
-- The foreign key and the triggers lock repos, so they come last, in one statement, and the lock timeout fails the
-- migration rather than queue reads behind it. A rerun retries it.
do $topics$
begin
set local lock_timeout = '1s';
ALTER TABLE "repo_topics" ADD CONSTRAINT "repo_topics_repo_id_repos_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE;

-- Replaces a repo's rows with the topics it carries now, or none once it is gone or archived. A row in an older shape
-- than a list of topics has none, so reading it never fails the write.
create function repos_sync_topics() returns trigger language plpgsql as $sync$
begin
  if tg_op = 'UPDATE' then
    delete from repo_topics where repo_id = old.id;
  end if;
  if new.gone_at is null and not new.archived and jsonb_typeof(new.topics) = 'array' then
    insert into repo_topics (repo_id, topic, kinds)
    select new.id, topic, new.kinds from jsonb_array_elements_text(new.topics) as tag (topic)
    on conflict do nothing;
  end if;
  return null;
end
$sync$;
create trigger repos_topics_inserted after insert on repos
  for each row when (new.topics <> '[]'::jsonb and new.gone_at is null and not new.archived)
  execute function repos_sync_topics();
create trigger repos_topics_updated after update of topics, kinds, archived, gone_at on repos
  for each row when (
    (old.topics, old.kinds, old.archived, old.gone_at) is distinct from (new.topics, new.kinds, new.archived, new.gone_at)
  )
  execute function repos_sync_topics();
end
$topics$;
