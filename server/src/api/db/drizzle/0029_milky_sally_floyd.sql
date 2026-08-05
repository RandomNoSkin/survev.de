ALTER TABLE "match_data" ADD COLUMN "times_downed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "match_data" ADD COLUMN "times_needed_saving" integer DEFAULT 0 NOT NULL;