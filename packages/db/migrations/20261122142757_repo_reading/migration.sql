-- A library's progress counted each current star's repo by reading its repos row, so a profile page read one heap page
-- per star from the 6 GB repos heap: about 61,000 buffers for 15,000 stars, 59 ms warm and up to 11 s cold on prod.
-- repo_reading holds each repo's progress state in a narrow row, which triggers on repos write when a repo is inserted
-- and when its state changes, in the statement that changes it. The table starts empty, and
-- `bun run --cwd packages/db backfill-reading` fills it for the repos that existed before, in short batches, after the
-- deploy. Until then the progress reads repos for a repo with no row, so its counts stay exact.
CREATE TYPE "reading_state" AS ENUM('read', 'failed', 'queued', 'unread');--> statement-breakpoint
CREATE TABLE "repo_reading" (
	"repo_id" bigint PRIMARY KEY,
	"state" "reading_state" NOT NULL
);
--> statement-breakpoint
-- The foreign key, the function that takes a repos row, and the triggers lock repos, so they come last, in one
-- statement, and the lock timeout fails the migration rather than queue reads behind it. A rerun retries it.
do $repo_reading$
begin
set local lock_timeout = '1s';
ALTER TABLE "repo_reading" ADD CONSTRAINT "repo_reading_repo_id_repos_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE;

-- readingState in packages/db/src/schema.ts, for one repos row. It names the summary recipe, the failure cap, and the
-- summary policy's star counts, so a change to any of them replaces this function in the same migration.
create function repo_reading_state(r repos) returns reading_state language sql immutable as $state$
  select (case
    when not (r.summary is null or r.summary_readme_oid is distinct from r.readme_oid or r.embedding_model is null)
      then 'read'
    when r.enrich_failures >= 3 then 'failed'
    when (
      r.summary_deferred
      or (
        (r.summary is null or r.summary_readme_oid is distinct from r.readme_oid or r.summary_recipe is distinct from 5
          or r.summary_input_hash is distinct from r.input_hash)
        and r.gone_at is null
        and not (
          r.user_starred or r.stars is null or r.stars >= 200
          or (r.stars >= 50 and not (coalesce(r.description, '') <> '' or r.topics <> '[]'::jsonb))
        )
      )
    ) and r.gone_at is null then 'queued'
    else 'unread'
  end)::reading_state
$state$;

create function repos_sync_reading() returns trigger language plpgsql as $sync$
begin
  insert into repo_reading (repo_id, state) values (new.id, repo_reading_state(new))
  on conflict (repo_id) do update set state = excluded.state where repo_reading.state is distinct from excluded.state;
  return null;
end
$sync$;

-- The update trigger names every column the state reads and fires only when the state moves, so a write that leaves it
-- alone, such as a star that moves a stargazer count, writes nothing here.
create trigger repos_reading_inserted after insert on repos for each row execute function repos_sync_reading();
create trigger repos_reading_updated
  after update of summary, summary_readme_oid, readme_oid, embedding_model, enrich_failures, summary_deferred,
    summary_recipe, summary_input_hash, input_hash, gone_at, user_starred, stars, description, topics
  on repos for each row
  when (repo_reading_state(old) is distinct from repo_reading_state(new))
  execute function repos_sync_reading();
end
$repo_reading$;
