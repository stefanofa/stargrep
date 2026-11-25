-- The topics refresh left out archived and gone repos by reading each faceted repo's wide repos row, about 150k heap
-- pages per statement, and on prod its first statement passed the 55 s limit every night from 2026-11-23. It now reads
-- the archived repos from repos_archived_idx and the gone ones from this index, which holds none on prod today. As with
-- repos_archived_idx, prod gets the index built concurrently by hand before this deploys, and this statement does
-- nothing there. A fresh database builds it here. The scan reads all of repos, 26 s cold on a branch of prod, so this
-- transaction allows 2 minutes. The limit takes effect at the next statement, so it is a statement of its own.
set local statement_timeout = '2min';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repos_gone_idx" ON "repos" ("id") WHERE "gone_at" is not null;
