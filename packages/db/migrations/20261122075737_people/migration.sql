-- The people list: every account the public rule or the curated list picks, with its card from its synced stars, and a
-- copy of their current stars keyed by repo. A nightly job fills both, so they start empty and build at once here. On
-- a branch of prod, counting the stars one account of 19,105 stars shares with each of the 354 people took 1.3 s cold
-- against stars and 55 ms against the copy.
CREATE TABLE "people" (
	"account_id" bigint PRIMARY KEY,
	"curated" boolean NOT NULL,
	"stars" integer NOT NULL,
	"last_starred_at" timestamp with time zone NOT NULL,
	"languages" jsonb DEFAULT '[]' NOT NULL,
	"topics" jsonb DEFAULT '[]' NOT NULL,
	"synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "people_stars" (
	"account_id" bigint,
	"repo_id" bigint,
	CONSTRAINT "people_stars_pkey" PRIMARY KEY("account_id","repo_id")
);
--> statement-breakpoint
CREATE INDEX "people_stars_repo_idx" ON "people_stars" ("repo_id","account_id");--> statement-breakpoint
ALTER TABLE "people_stars" ADD CONSTRAINT "people_stars_account_id_people_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "people"("account_id") ON DELETE CASCADE;--> statement-breakpoint
-- The foreign key locks github_accounts, so it comes last, and the lock timeout fails the migration rather than queue
-- reads behind it. A rerun retries it.
do $people$
begin
set local lock_timeout = '1s';
ALTER TABLE "people" ADD CONSTRAINT "people_account_id_github_accounts_id_fkey" FOREIGN KEY ("account_id") REFERENCES "github_accounts"("id") ON DELETE CASCADE;
end
$people$;
