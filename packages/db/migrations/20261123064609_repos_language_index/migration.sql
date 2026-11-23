-- An account card counts the account's stars by language. Each starred repo's language sat on the wide repos row, so a
-- library of 15k stars read 15k heap pages, which take seconds when the cache is cold. This index holds only the ID and
-- the language, so the count reads it, and the heap only for pages vacuum hasn't marked all-visible. A deploy runs
-- each migration in one transaction, so no index can be built concurrently here, and a build blocks writes to repos
-- while it runs. So prod gets the index built concurrently by hand before this deploys, and this statement does nothing
-- there. A fresh database builds it here. On a branch of prod it took about 25 s, past the 11 s every statement of the
-- app's role gets, so this transaction allows 2 minutes. The limit takes effect at the next statement, so it is a
-- statement of its own.
set local statement_timeout = '2min';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repos_language_idx" ON "repos" ("id","language");
