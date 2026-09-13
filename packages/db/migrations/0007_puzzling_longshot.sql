ALTER TABLE "sites" ADD COLUMN "profile_corpus_version" text;--> statement-breakpoint
-- Every profile filled in before this column existed was written against v4.4,
-- the only corpus the engine had held. Recording that keeps those sites' v4.4
-- audits running, and makes a v5.0 audit ask for the profile to be re-read.
UPDATE "sites" SET "profile_corpus_version" = '4.4' WHERE cardinality("flags") > 0;
