ALTER TABLE "page_links" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "page_links" ALTER COLUMN "kind" SET DEFAULT 'anchor'::text;--> statement-breakpoint
DROP TYPE "public"."link_kind";--> statement-breakpoint
CREATE TYPE "public"."link_kind" AS ENUM('anchor', 'canonical', 'hreflang', 'pagination', 'redirect');--> statement-breakpoint
ALTER TABLE "page_links" ALTER COLUMN "kind" SET DEFAULT 'anchor'::"public"."link_kind";--> statement-breakpoint
ALTER TABLE "page_links" ALTER COLUMN "kind" SET DATA TYPE "public"."link_kind" USING "kind"::"public"."link_kind";