CREATE TYPE "sync_request_outcome" AS ENUM('pending', 'failed');--> statement-breakpoint
CREATE TABLE "sync_requests" (
	"login" text PRIMARY KEY,
	"requested_at" timestamp with time zone NOT NULL,
	"outcome" "sync_request_outcome" NOT NULL
);
