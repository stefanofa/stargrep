CREATE TYPE "icon_plate" AS ENUM('none', 'light', 'dark');--> statement-breakpoint
CREATE TYPE "icon_source" AS ENUM('repo-file', 'readme-image', 'homepage');--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "icon_key" text;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "icon_source" "icon_source";--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "icon_plate" "icon_plate";--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "icon_size" integer;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "icon_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "owner_type" "account_type";--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "owner_avatar_url" text;--> statement-breakpoint
CREATE INDEX "repos_icon_checked_at_idx" ON "repos" ("icon_checked_at");--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_icon_complete" CHECK (("icon_key" is null) = ("icon_source" is null) and ("icon_key" is null) = ("icon_plate" is null) and ("icon_key" is null) = ("icon_size" is null));