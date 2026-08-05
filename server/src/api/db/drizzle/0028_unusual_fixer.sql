ALTER TABLE "match_data" ADD COLUMN "revives" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "match_data" ADD COLUMN "teammate_saves" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "match_data" ADD COLUMN "impact_score" integer;--> statement-breakpoint
ALTER TABLE "match_data" ADD COLUMN "impact_breakdown" json;