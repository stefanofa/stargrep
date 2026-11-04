CREATE TABLE "embedding_settings" (
	"singleton" boolean PRIMARY KEY DEFAULT true,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	CONSTRAINT "embedding_settings_one_row" CHECK (singleton)
);
