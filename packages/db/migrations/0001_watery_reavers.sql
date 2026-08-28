ALTER TABLE "crawls" ADD COLUMN "seed_urls" text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "sitemap_urls" text[] DEFAULT '{}'::text[] NOT NULL;