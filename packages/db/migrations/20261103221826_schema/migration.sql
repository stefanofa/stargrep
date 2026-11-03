CREATE TYPE "account_type" AS ENUM('user', 'org');--> statement-breakpoint
CREATE TYPE "collection_kind" AS ENUM('user', 'editorial');--> statement-breakpoint
CREATE TYPE "follow_source" AS ENUM('github', 'stargrep');--> statement-breakpoint
CREATE TYPE "search_scope" AS ENUM('stars', 'network', 'global');--> statement-breakpoint
CREATE TYPE "star_source" AS ENUM('gharchive', 'api');--> statement-breakpoint
CREATE TABLE "api_usage" (
	"key" text,
	"day" date,
	"counts" jsonb DEFAULT '{}' NOT NULL,
	CONSTRAINT "api_usage_pkey" PRIMARY KEY("key","day")
);
--> statement-breakpoint
CREATE TABLE "collection_items" (
	"collection_id" bigint,
	"repo_id" bigint,
	"note" text,
	"position" integer NOT NULL,
	CONSTRAINT "collection_items_pkey" PRIMARY KEY("collection_id","repo_id")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "collections_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"owner_id" bigint,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"kind" "collection_kind" NOT NULL,
	CONSTRAINT "collections_owner_slug_key" UNIQUE NULLS NOT DISTINCT("owner_id","slug")
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"follower_id" bigint,
	"followee_id" bigint,
	"source" "follow_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_pkey" PRIMARY KEY("follower_id","followee_id")
);
--> statement-breakpoint
CREATE TABLE "github_accounts" (
	"id" bigint PRIMARY KEY,
	"type" "account_type" NOT NULL,
	"login" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"followers" integer,
	"public_repos" integer,
	"owned_repo_stars" integer,
	"claimed_by" text,
	"stars_etag" text,
	"stars_synced_at" timestamp with time zone,
	"stars_full_synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "repo_metrics" (
	"repo_id" bigint PRIMARY KEY,
	"stars" integer,
	"stars_30d" integer,
	"stars_90d" integer,
	"forks" integer,
	"forks_30d" integer,
	"forks_90d" integer,
	"commits" integer,
	"commits_30d" integer,
	"commits_90d" integer,
	"active_contributors" integer,
	"active_contributors_30d" integer,
	"active_contributors_90d" integer,
	"new_contributors" integer,
	"new_contributors_30d" integer,
	"new_contributors_90d" integer,
	"merged_pull_requests" integer,
	"merged_pull_requests_30d" integer,
	"merged_pull_requests_90d" integer,
	"closed_issues" integer,
	"closed_issues_30d" integer,
	"closed_issues_90d" integer,
	"releases" integer,
	"releases_30d" integer,
	"releases_90d" integer,
	"refreshed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" bigint PRIMARY KEY,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"topics" jsonb DEFAULT '[]' NOT NULL,
	"language" text,
	"license" text,
	"homepage" text,
	"kind" text,
	"created_at" timestamp with time zone,
	"pushed_at" timestamp with time zone,
	"archived" boolean DEFAULT false NOT NULL,
	"readme_oid" text,
	"summary" text,
	"keywords" jsonb DEFAULT '[]' NOT NULL,
	"embedding" halfvec(1024),
	"embedding_model" text,
	"search" tsvector GENERATED ALWAYS AS (
          setweight(to_tsvector('english', "repos"."owner" || ' ' || "repos"."name"), 'A') ||
          setweight(to_tsvector('english', "repos"."topics"), 'A') ||
          setweight(to_tsvector('english', coalesce("repos"."description", '')), 'B') ||
          setweight(to_tsvector('english', "repos"."keywords"), 'B') ||
          setweight(to_tsvector('english', coalesce("repos"."summary", '')), 'C')) STORED NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "search_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"time" timestamp with time zone DEFAULT now() NOT NULL,
	"scope" "search_scope" NOT NULL,
	"query" text NOT NULL,
	"result_count" integer NOT NULL,
	"clicked_repo_id" bigint
);
--> statement-breakpoint
CREATE TABLE "stars" (
	"account_id" bigint,
	"repo_id" bigint,
	"starred_at" timestamp with time zone NOT NULL,
	"unstarred_at" timestamp with time zone,
	"source" "star_source" NOT NULL,
	CONSTRAINT "stars_pkey" PRIMARY KEY("account_id","repo_id")
);
--> statement-breakpoint
CREATE INDEX "repos_search_idx" ON "repos" USING gin ("search");--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collection_id_collections_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_repo_id_repos_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_owner_id_github_accounts_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "github_accounts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_github_accounts_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "github_accounts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_followee_id_github_accounts_id_fkey" FOREIGN KEY ("followee_id") REFERENCES "github_accounts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "repo_metrics" ADD CONSTRAINT "repo_metrics_repo_id_repos_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "search_events" ADD CONSTRAINT "search_events_clicked_repo_id_repos_id_fkey" FOREIGN KEY ("clicked_repo_id") REFERENCES "repos"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "stars" ADD CONSTRAINT "stars_account_id_github_accounts_id_fkey" FOREIGN KEY ("account_id") REFERENCES "github_accounts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "stars" ADD CONSTRAINT "stars_repo_id_repos_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE;