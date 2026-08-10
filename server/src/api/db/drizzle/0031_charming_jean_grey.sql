CREATE TABLE "rating_tiers" (
	"team_mode" integer NOT NULL,
	"region" text NOT NULL,
	"tier_name" text NOT NULL,
	"min_score" numeric NOT NULL,
	"sample_size" integer NOT NULL,
	CONSTRAINT "rating_tiers_team_mode_region_tier_name_pk" PRIMARY KEY("team_mode","region","tier_name")
);
--> statement-breakpoint
CREATE TABLE "region_groups" (
	"region" text PRIMARY KEY NOT NULL,
	"group_name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "primary_region" text DEFAULT '' NOT NULL;