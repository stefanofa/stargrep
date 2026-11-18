-- Where the icon backfill's one chain stands, so the daily cron resumes it instead of starting a second chain.
CREATE TABLE "icon_backfill" (
	"singleton" boolean PRIMARY KEY DEFAULT true,
	"after" bigint,
	CONSTRAINT "icon_backfill_one_row" CHECK (singleton)
);
