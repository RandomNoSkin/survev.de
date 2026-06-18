-- Idempotent baseline of the full current schema.
-- Safe to run on a fresh database (creates everything) AND on an existing one
-- (every statement is guarded, so it no-ops on objects that already exist).
-- This lets `db:migrate` reconcile any database — fresh, fully migrated, or
-- drifted (built via db:push) — without "already exists" failures.
CREATE TABLE IF NOT EXISTS "ban_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ban_type" text NOT NULL,
	"ban_target" text NOT NULL,
	"comment" text NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "banned_ips" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_in" timestamp NOT NULL,
	"encoded_ip" text PRIMARY KEY NOT NULL,
	"permanent" boolean DEFAULT false NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"banned_by" text DEFAULT 'admin' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_banned_ips" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_in" timestamp NOT NULL,
	"encoded_ip" text PRIMARY KEY NOT NULL,
	"permanent" boolean DEFAULT false NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"banned_by" text DEFAULT 'admin' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"game_id" text NOT NULL,
	"username" text NOT NULL,
	"user_id" text DEFAULT '' NOT NULL,
	"encoded_ip" text NOT NULL,
	"channel" integer DEFAULT 0 NOT NULL,
	"message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ip_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"region" text NOT NULL,
	"game_id" text NOT NULL,
	"map_id" integer NOT NULL,
	"username" text NOT NULL,
	"user_id" text DEFAULT '',
	"encoded_ip" text NOT NULL,
	"team_mode" integer DEFAULT 1 NOT NULL,
	"ip" text NOT NULL,
	"find_game_ip" text NOT NULL,
	"find_game_encoded_ip" text NOT NULL,
	"isp" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "items" (
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"time_acquired" bigint NOT NULL,
	"source" text DEFAULT 'unlock_new_account' NOT NULL,
	"status" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "items_user_id_type_pk" PRIMARY KEY("user_id","type")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "match_data" (
	"user_id" text DEFAULT '',
	"user_banned" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"region" text NOT NULL,
	"map_id" integer NOT NULL,
	"game_id" uuid NOT NULL,
	"map_seed" bigint NOT NULL,
	"username" text NOT NULL,
	"player_id" integer NOT NULL,
	"team_mode" integer NOT NULL,
	"team_count" integer NOT NULL,
	"team_total" integer NOT NULL,
	"team_id" integer NOT NULL,
	"time_alive" integer NOT NULL,
	"rank" integer NOT NULL,
	"died" boolean NOT NULL,
	"kills" integer NOT NULL,
	"assists" integer DEFAULT 0 NOT NULL,
	"team_kills" integer DEFAULT 0 NOT NULL,
	"damage_dealt" integer NOT NULL,
	"damage_taken" integer NOT NULL,
	"killer_id" integer NOT NULL,
	"killed_ids" integer[] NOT NULL,
	"assisted_ids" integer[] DEFAULT '{}' NOT NULL,
	"encoded_ip" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_xp" (
	"user_id" text NOT NULL,
	"pass_type" text NOT NULL,
	"level" integer NOT NULL,
	"xp" numeric NOT NULL,
	"last_updated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_xp_user_id_pass_type_pk" PRIMARY KEY("user_id","pass_type")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" text PRIMARY KEY NOT NULL,
	"auth_id" text NOT NULL,
	"slug" text NOT NULL,
	"admin" boolean DEFAULT false NOT NULL,
	"banned" boolean DEFAULT false NOT NULL,
	"ban_reason" text DEFAULT '' NOT NULL,
	"banned_by" text DEFAULT '' NOT NULL,
	"username" text DEFAULT '' NOT NULL,
	"username_set" boolean DEFAULT false NOT NULL,
	"user_created" timestamp with time zone DEFAULT now() NOT NULL,
	"last_username_change_time" timestamp,
	"linked" boolean DEFAULT false NOT NULL,
	"linked_google" boolean DEFAULT false NOT NULL,
	"linked_discord" boolean DEFAULT false NOT NULL,
	"loadout" json DEFAULT '{"outfit":"outfitBase","melee":"fists","heal":"heal_basic","boost":"boost_basic","player_icon":"","crosshair":{"type":"crosshair_default","color":16777215,"size":"1.00","stroke":"0.00"},"emotes":["emote_happyface","emote_thumbsup","emote_surviv","emote_sadface","",""]}'::json NOT NULL,
	CONSTRAINT "users_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "items" ADD CONSTRAINT "items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "session" ADD CONSTRAINT "session_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "user_xp" ADD CONSTRAINT "user_xp_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ban_comments_target_idx" ON "ban_comments" USING btree ("ban_type","ban_target","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_logs_username_idx" ON "chat_logs" USING btree ("username","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_logs_ip_idx" ON "chat_logs" USING btree ("encoded_ip","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_logs_user_id_idx" ON "chat_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "name_created_at_idx" ON "ip_logs" USING btree ("username","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_match_data_user_stats" ON "match_data" USING btree ("user_id","team_mode","rank","kills","assists","damage_dealt","time_alive");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_game_id" ON "match_data" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_id" ON "match_data" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_match_data_team_query" ON "match_data" USING btree ("team_mode","map_id","created_at","game_id","team_id","region","kills","assists");
