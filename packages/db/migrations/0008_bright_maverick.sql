CREATE TYPE "public"."review_environment" AS ENUM('planning', 'pre-production', 'production');--> statement-breakpoint
CREATE TYPE "public"."review_result" AS ENUM('not-started', 'in-progress', 'passed', 'failed', 'skipped', 'reopened');--> statement-breakpoint
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"release_id" text NOT NULL,
	"scope_revision" text,
	"origin" text,
	"scope_approver" text,
	"scope_approved_at" timestamp with time zone,
	"scope_approval_evidence" text,
	"decision_owner" text,
	"criteria" jsonb,
	"cutover_authorizer" text,
	"cutover_authorized_at" timestamp with time zone,
	"cutover_decision_reference" text,
	"cutover_at" timestamp with time zone,
	"cutover_binding" jsonb,
	"launch_decision" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "releases_site_release_unique" UNIQUE("site_id","release_id")
);
--> statement-breakpoint
CREATE TABLE "review_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"check_id" text NOT NULL,
	"release_id" text NOT NULL,
	"scope_revision" text NOT NULL,
	"criteria_revision" text NOT NULL,
	"origin" text NOT NULL,
	"environment" "review_environment" NOT NULL,
	"tested_at" timestamp with time zone NOT NULL,
	"tester" text NOT NULL,
	"result" "review_result" NOT NULL,
	"evidence" text NOT NULL,
	"reviewed_by" text NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"next_review_at" timestamp with time zone,
	"event_trigger" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_runs_site_run_unique" UNIQUE("site_id","run_id"),
	CONSTRAINT "review_after_test" CHECK ("review_runs"."reviewed_at" >= "review_runs"."tested_at"),
	CONSTRAINT "next_review_after_test" CHECK ("review_runs"."next_review_at" IS NULL OR "review_runs"."next_review_at" > "review_runs"."tested_at"),
	CONSTRAINT "passed_needs_next_review" CHECK ("review_runs"."result" <> 'passed' OR "review_runs"."next_review_at" IS NOT NULL OR "review_runs"."event_trigger" IS NOT NULL),
	CONSTRAINT "reopened_needs_trigger" CHECK ("review_runs"."result" <> 'reopened' OR "review_runs"."event_trigger" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "release_id" uuid;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_runs_site_check_idx" ON "review_runs" USING btree ("site_id","check_id");--> statement-breakpoint
ALTER TABLE "audits" ADD CONSTRAINT "audits_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Review runs are append-only (v5.0: never delete historic runs to improve
-- readiness; log a regression as a new Reopened run). A direct UPDATE or
-- DELETE is refused. A site's deletion still removes its runs: that DELETE
-- arrives through the foreign key's cascade, which runs inside a referential
-- trigger, so it reaches this one at a trigger depth above 1.
CREATE FUNCTION "review_runs_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'review_runs is append-only: log a new run instead of % on run %', TG_OP, OLD.run_id
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "review_runs_append_only"
BEFORE UPDATE OR DELETE ON "review_runs"
FOR EACH ROW EXECUTE FUNCTION "review_runs_append_only"();
