CREATE TABLE "user_weapon_stats_daily" (
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"weapon_type" text NOT NULL,
	"games" integer DEFAULT 0 NOT NULL,
	"kills" integer DEFAULT 0 NOT NULL,
	"damage" bigint DEFAULT 0 NOT NULL,
	"shots" integer DEFAULT 0 NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"max_damage" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "user_weapon_stats_daily_user_id_day_weapon_type_pk" PRIMARY KEY("user_id","day","weapon_type")
);
--> statement-breakpoint
ALTER TABLE "match_data" ADD COLUMN "shots_fired" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "match_data" ADD COLUMN "bullet_hits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_user_weapon_stats_user_day" ON "user_weapon_stats_daily" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "idx_match_data_created_at" ON "match_data" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_match_data_user_created" ON "match_data" USING btree ("user_id","created_at");