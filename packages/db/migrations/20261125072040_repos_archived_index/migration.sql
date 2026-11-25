-- An account's taste counts its stars whose repo is archived. The flag sat on the wide repos row, so an account of 16k
-- stars read 13.6k heap pages, 3.4 s on prod with a cold cache. This index holds only the archived repos GitHub still
-- serves, about 38k of 1.5 million, so the count probes it instead. A deploy runs each migration in one transaction,
-- so no index can be built concurrently here, and a build blocks writes to repos while it scans them. So prod gets the
-- index built concurrently by hand before this deploys, and this statement does nothing there. A fresh database builds
-- it here. The scan reads all of repos, as the language index's did in about 25 s on a branch of prod, past the 11 s
-- every statement of the app's role gets, so this transaction allows 2 minutes. The limit takes effect at the next
-- statement, so it is a statement of its own.
set local statement_timeout = '2min';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repos_archived_idx" ON "repos" ("id") WHERE "archived" and "gone_at" is null;
