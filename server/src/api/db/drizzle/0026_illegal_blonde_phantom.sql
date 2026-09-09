CREATE TABLE "weapon_stats_daily" (
	"day" date NOT NULL,
	"weapon_type" text NOT NULL,
	"map_id" integer NOT NULL,
	"team_mode" integer NOT NULL,
	"damage_dealt" bigint DEFAULT 0 NOT NULL,
	"kills" integer DEFAULT 0 NOT NULL,
	"games_used" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "weapon_stats_daily_day_weapon_type_map_id_team_mode_pk" PRIMARY KEY("day","weapon_type","map_id","team_mode")
);
--> statement-breakpoint
CREATE INDEX "idx_weapon_stats_daily_day" ON "weapon_stats_daily" USING btree ("day");