-- Every icon check set repos.icon_checked_at, so each check rewrote the whole 2.8 KB repos row with its embedding,
-- about 650,000 times a day on prod, mostly to change only that time. Each rewrite added the row's lexemes to the
-- repos_search_idx pending list and left a dead tuple, and the icon page walked the 6 GB repos heap in ID order to find
-- repos due, up to 27 s cold. repo_icon_checks holds the check in a narrow row, so a check writes repos only when the
-- icon changes, and the icon page walks this table's key. A trigger on repos adds a row when a repo is inserted. The
-- table starts empty, and `bun run --cwd packages/db backfill-icon-checks` copies the checks of the repos that existed
-- before, in short batches, after the deploy. Until then the icon page sees only the repos with a row here.
CREATE TABLE "repo_icon_checks" (
	"repo_id" bigint PRIMARY KEY,
	"checked_at" timestamp with time zone,
	"key_version" text
);
--> statement-breakpoint
-- The foreign key and the trigger lock repos, so they come last, in one statement, and the lock timeout fails the
-- migration rather than queue reads behind it. A rerun retries it.
do $repo_icon_checks$
begin
set local lock_timeout = '1s';
ALTER TABLE "repo_icon_checks" ADD CONSTRAINT "repo_icon_checks_repo_id_repos_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE;

-- A key's version is the part before its first slash, as in saveIcon.
create function repos_add_icon_check() returns trigger language plpgsql as $add$
begin
  insert into repo_icon_checks (repo_id, key_version) values (new.id, split_part(new.icon_key, '/', 1))
  on conflict (repo_id) do nothing;
  return null;
end
$add$;

create trigger repos_icon_check_added after insert on repos for each row execute function repos_add_icon_check();
end
$repo_icon_checks$;
