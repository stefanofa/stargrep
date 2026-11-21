-- The repo panel's "not starred yet" row ranks repos across stargrep by how near their embedding sits to the opened
-- repo's, which needs an approximate index. On a branch of prod an HNSW index on repos, over the repos with a summary,
-- made a write that moves such a repo's row about 5 times slower, 5.3 ms against 0.9 ms, because each one adds a graph
-- insert, and a star moves its repo's stargazer count. So the vectors get a table of their own, which triggers on repos
-- write only when a repo's embedding, summary, gone time, or archived flag changes. The table starts empty, so its
-- index builds at once here, and `bun run --cwd packages/db backfill-similar` fills it for the repos read before.
CREATE TABLE "similar_candidates" (
	"repo_id" bigint PRIMARY KEY,
	"embedding" halfvec(1024) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "similar_candidates_embedding_idx" ON "similar_candidates" USING hnsw ("embedding" halfvec_cosine_ops);
--> statement-breakpoint
-- The foreign key and the triggers lock repos, so they run in this one statement, and the lock timeout fails the
-- migration rather than queue reads behind it. A rerun retries it.
do $similar_candidates$
begin
set local lock_timeout = '1s';
ALTER TABLE "similar_candidates" ADD CONSTRAINT "similar_candidates_repo_id_repos_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE;

-- similarCandidate in packages/db/src/schema.ts, row by row: a summary, an embedding, still served, not archived.
create function repos_sync_similar_candidate() returns trigger language plpgsql as $sync$
begin
  if new.embedding is not null and new.summary is not null and new.gone_at is null and not new.archived then
    insert into similar_candidates (repo_id, embedding) values (new.id, new.embedding)
    on conflict (repo_id) do update set embedding = excluded.embedding
    where similar_candidates.embedding is distinct from excluded.embedding;
  else
    delete from similar_candidates where repo_id = new.id;
  end if;
  return null;
end
$sync$;

-- Each condition is checked before the function runs, so a write that changes none of these columns costs nothing more.
create trigger repos_similar_inserted after insert on repos for each row
  when (new.embedding is not null and new.summary is not null and new.gone_at is null and not new.archived)
  execute function repos_sync_similar_candidate();
create trigger repos_similar_updated after update of embedding, summary, gone_at, archived on repos for each row
  when (
    old.embedding is distinct from new.embedding
    or (old.summary is null) <> (new.summary is null)
    or (old.gone_at is null) <> (new.gone_at is null)
    or old.archived <> new.archived
  )
  execute function repos_sync_similar_candidate();
end
$similar_candidates$;
