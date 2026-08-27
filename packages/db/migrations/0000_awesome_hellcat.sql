CREATE TYPE "public"."applicability" AS ENUM('yes', 'no', 'review');--> statement-breakpoint
CREATE TYPE "public"."audit_status" AS ENUM('pending', 'running', 'complete', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."automation_tier" AS ENUM('automated', 'assisted', 'attested');--> statement-breakpoint
CREATE TYPE "public"."check_status" AS ENUM('not-started', 'in-progress', 'passed', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."coverage" AS ENUM('verified', 'attested', 'unknown', 'not-applicable');--> statement-breakpoint
CREATE TYPE "public"."crawl_status" AS ENUM('queued', 'running', 'complete', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."link_kind" AS ENUM('anchor', 'canonical', 'hreflang', 'pagination', 'redirect', 'sitemap');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('P0', 'P1', 'P2');--> statement-breakpoint
CREATE TYPE "public"."probe_outcome" AS ENUM('pass', 'fail', 'warn', 'not-applicable', 'error');--> statement-breakpoint
CREATE TYPE "public"."probe_scope" AS ENUM('site', 'page', 'template');--> statement-breakpoint
CREATE TYPE "public"."profile" AS ENUM('core', 'extended');--> statement-breakpoint
CREATE TYPE "public"."remediation_class" AS ENUM('config', 'content', 'code', 'structural', 'platform');--> statement-breakpoint
CREATE TYPE "public"."render_mode" AS ENUM('raw', 'rendered');--> statement-breakpoint
CREATE TABLE "attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_id" uuid NOT NULL,
	"check_id" text NOT NULL,
	"attested_by" text NOT NULL,
	"statement" text NOT NULL,
	"attested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"corpus_version" text NOT NULL,
	"status" "audit_status" DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"readiness" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_evidence" (
	"audit_id" uuid NOT NULL,
	"check_id" text NOT NULL,
	"probe_result_id" uuid NOT NULL,
	CONSTRAINT "check_evidence_audit_id_check_id_probe_result_id_pk" PRIMARY KEY("audit_id","check_id","probe_result_id")
);
--> statement-breakpoint
CREATE TABLE "check_states" (
	"audit_id" uuid NOT NULL,
	"check_id" text NOT NULL,
	"applicability" "applicability" DEFAULT 'review' NOT NULL,
	"applicability_rationale" text,
	"status" "check_status" DEFAULT 'not-started' NOT NULL,
	"coverage" "coverage" DEFAULT 'unknown' NOT NULL,
	"evidence" text,
	"attestation_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_states_audit_id_check_id_pk" PRIMARY KEY("audit_id","check_id"),
	CONSTRAINT "excluded_needs_rationale" CHECK ("check_states"."applicability" <> 'no' OR "check_states"."applicability_rationale" IS NOT NULL),
	CONSTRAINT "attestation_needs_expiry" CHECK ("check_states"."coverage" <> 'attested' OR "check_states"."attestation_expires_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "crawls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_id" uuid NOT NULL,
	"seed_url" text NOT NULL,
	"status" "crawl_status" DEFAULT 'queued' NOT NULL,
	"user_agent" text NOT NULL,
	"respect_robots" boolean DEFAULT true NOT NULL,
	"max_pages" integer NOT NULL,
	"max_depth" integer NOT NULL,
	"request_delay_ms" integer DEFAULT 0 NOT NULL,
	"robots_txt" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crawl_id" uuid NOT NULL,
	"from_page_id" uuid NOT NULL,
	"to_page_id" uuid,
	"to_url" text NOT NULL,
	"to_normalized_url" text NOT NULL,
	"kind" "link_kind" DEFAULT 'anchor' NOT NULL,
	"anchor_text" text,
	"rel" text,
	"nofollow" boolean DEFAULT false NOT NULL,
	"in_raw_html" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crawl_id" uuid NOT NULL,
	"url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"depth" integer NOT NULL,
	"discovered_from_id" uuid,
	"status" smallint,
	"fetch_error" text,
	"content_type" text,
	"content_length" integer,
	"redirect_chain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ttfb_ms" integer,
	"total_ms" integer,
	"headers" jsonb,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pages_crawl_url_uniq" UNIQUE("crawl_id","normalized_url")
);
--> statement-breakpoint
CREATE TABLE "probe_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_id" uuid NOT NULL,
	"crawl_id" uuid,
	"page_id" uuid,
	"probe_id" text NOT NULL,
	"scope" "probe_scope" NOT NULL,
	"outcome" "probe_outcome" NOT NULL,
	"summary" text NOT NULL,
	"data" jsonb,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_scope_needs_page" CHECK ("probe_results"."scope" <> 'page' OR "probe_results"."page_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "renders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"mode" "render_mode" NOT NULL,
	"body_hash" text NOT NULL,
	"body_key" text,
	"byte_length" integer NOT NULL,
	"text_hash" text,
	"extracted" jsonb,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "renders_page_mode_uniq" UNIQUE("page_id","mode")
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"origin" text NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"profile" "profile" DEFAULT 'core' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sites_origin_unique" UNIQUE("origin")
);
--> statement-breakpoint
ALTER TABLE "attestations" ADD CONSTRAINT "attestations_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audits" ADD CONSTRAINT "audits_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_evidence" ADD CONSTRAINT "check_evidence_probe_result_id_probe_results_id_fk" FOREIGN KEY ("probe_result_id") REFERENCES "public"."probe_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_evidence" ADD CONSTRAINT "check_evidence_state_fk" FOREIGN KEY ("audit_id","check_id") REFERENCES "public"."check_states"("audit_id","check_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_states" ADD CONSTRAINT "check_states_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawls" ADD CONSTRAINT "crawls_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_links" ADD CONSTRAINT "page_links_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_links" ADD CONSTRAINT "page_links_from_page_id_pages_id_fk" FOREIGN KEY ("from_page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_links" ADD CONSTRAINT "page_links_to_page_id_pages_id_fk" FOREIGN KEY ("to_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_discovered_from_id_pages_id_fk" FOREIGN KEY ("discovered_from_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_results" ADD CONSTRAINT "probe_results_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_results" ADD CONSTRAINT "probe_results_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_results" ADD CONSTRAINT "probe_results_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attestations_audit_check_idx" ON "attestations" USING btree ("audit_id","check_id");--> statement-breakpoint
CREATE INDEX "audits_site_created_idx" ON "audits" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE INDEX "check_states_audit_status_idx" ON "check_states" USING btree ("audit_id","status");--> statement-breakpoint
CREATE INDEX "crawls_audit_idx" ON "crawls" USING btree ("audit_id");--> statement-breakpoint
CREATE INDEX "page_links_from_idx" ON "page_links" USING btree ("from_page_id");--> statement-breakpoint
CREATE INDEX "page_links_target_idx" ON "page_links" USING btree ("crawl_id","to_normalized_url");--> statement-breakpoint
CREATE INDEX "pages_crawl_status_idx" ON "pages" USING btree ("crawl_id","status");--> statement-breakpoint
CREATE INDEX "probe_results_audit_probe_idx" ON "probe_results" USING btree ("audit_id","probe_id");--> statement-breakpoint
CREATE INDEX "probe_results_page_idx" ON "probe_results" USING btree ("page_id");