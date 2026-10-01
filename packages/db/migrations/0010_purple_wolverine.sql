ALTER TYPE "public"."render_mode" ADD VALUE 'rendered-mobile';--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "capture" jsonb;