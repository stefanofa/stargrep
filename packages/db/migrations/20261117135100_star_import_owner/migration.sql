-- The star import driver's ownership row, so two drivers never read accounts on one token at once. No Worker reads
-- or writes it.
CREATE TABLE "star_import_owner" (
	"singleton" boolean PRIMARY KEY DEFAULT true,
	"owner" uuid NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	CONSTRAINT "star_import_owner_one_row" CHECK (singleton)
);
