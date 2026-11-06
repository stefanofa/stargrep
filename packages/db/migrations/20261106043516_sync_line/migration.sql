ALTER TYPE "sync_request_outcome" ADD VALUE 'missing';--> statement-breakpoint
CREATE TABLE "sync_line" (
	"singleton" boolean PRIMARY KEY DEFAULT true,
	"busy_until" timestamp with time zone NOT NULL,
	CONSTRAINT "sync_line_one_row" CHECK (singleton)
);
--> statement-breakpoint
ALTER TABLE "sync_requests" ADD COLUMN "starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_requests" ADD COLUMN "caller" text;--> statement-breakpoint
CREATE INDEX "sync_requests_caller_idx" ON "sync_requests" ("caller","requested_at") WHERE "caller" is not null;