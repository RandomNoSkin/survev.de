ALTER TABLE "user_weapon_stats_daily" ADD COLUMN "map_id" integer DEFAULT -1 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_weapon_stats_daily" ADD COLUMN "team_mode" integer DEFAULT -1 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_weapon_stats_daily" DROP CONSTRAINT "user_weapon_stats_daily_user_id_day_weapon_type_pk";--> statement-breakpoint
ALTER TABLE "user_weapon_stats_daily" ADD CONSTRAINT "user_weapon_stats_daily_user_id_day_weapon_type_map_id_team_mode_pk" PRIMARY KEY("user_id","day","weapon_type","map_id","team_mode");
