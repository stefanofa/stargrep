-- Who asked for the monthly picks email. Nothing sends it yet, so the row count is the waitlist. The foreign key
-- briefly locks "user" against writes while it checks an empty table.
CREATE TABLE "monthly_picks" (
	"user_id" text PRIMARY KEY,
	"opted_in_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "monthly_picks" ADD CONSTRAINT "monthly_picks_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
