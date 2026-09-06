CREATE TYPE "public"."job_state" AS ENUM('queued', 'running', 'complete', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text NOT NULL,
	"queue" text NOT NULL,
	"payload" jsonb NOT NULL,
	"lane" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"state" "job_state" DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"enqueued_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"error" text,
	"owner" text,
	"leased_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_queue_id_pk" PRIMARY KEY("queue","id")
);
--> statement-breakpoint
CREATE INDEX "jobs_queue_claim_idx" ON "jobs" USING btree ("queue","owner","enqueued_at");--> statement-breakpoint
CREATE INDEX "jobs_queue_due_idx" ON "jobs" USING btree ("queue","state","next_attempt_at");