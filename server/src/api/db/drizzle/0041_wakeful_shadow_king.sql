CREATE TABLE "anticheat_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"game_id" uuid NOT NULL,
	"map_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"max_ratio" real NOT NULL,
	"scores" json NOT NULL,
	"details" json NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buy_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"buyer_id" text NOT NULL,
	"buyer_slug" text NOT NULL,
	"type" text NOT NULL,
	"amount" integer NOT NULL,
	"total" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"seller_id" text,
	"seller_slug" text,
	"item_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "clan_invites" (
	"id" serial PRIMARY KEY NOT NULL,
	"clan_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clan_key_pool" (
	"clan_id" integer NOT NULL,
	"key_type" text NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "clan_key_pool_clan_id_key_type_pk" PRIMARY KEY("clan_id","key_type")
);
--> statement-breakpoint
CREATE TABLE "clan_members" (
	"user_id" text PRIMARY KEY NOT NULL,
	"clan_id" integer NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clan_week_goals" (
	"week" text NOT NULL,
	"clan_id" integer NOT NULL,
	"tier" integer NOT NULL,
	"avg_games" real NOT NULL,
	"players" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clan_week_goals_week_clan_id_pk" PRIMARY KEY("week","clan_id")
);
--> statement-breakpoint
CREATE TABLE "clan_week_rewards" (
	"week" text NOT NULL,
	"rank" integer NOT NULL,
	"clan_id" integer NOT NULL,
	"rating" real NOT NULL,
	"keys" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clan_week_rewards_week_rank_pk" PRIMARY KEY("week","rank")
);
--> statement-breakpoint
CREATE TABLE "clan_week_stats" (
	"week" text NOT NULL,
	"clan_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"mode" text NOT NULL,
	"games" integer DEFAULT 0 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"damage" integer DEFAULT 0 NOT NULL,
	"kills" integer DEFAULT 0 NOT NULL,
	"weighted_wins" real DEFAULT 0 NOT NULL,
	CONSTRAINT "clan_week_stats_week_clan_id_user_id_mode_pk" PRIMARY KEY("week","clan_id","user_id","mode")
);
--> statement-breakpoint
CREATE TABLE "clans" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"tag" text NOT NULL,
	"icon" text DEFAULT '' NOT NULL,
	"invite_code" text,
	"xp" real DEFAULT 0 NOT NULL,
	"tag_color" integer DEFAULT 0 NOT NULL,
	"banner" integer DEFAULT 0 NOT NULL,
	"owner_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crate_openings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"crate" text NOT NULL,
	"key_type" text NOT NULL,
	"item_type" text NOT NULL,
	"item_id" integer,
	"amount" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crate_settings" (
	"crate" text PRIMARY KEY NOT NULL,
	"pool" json,
	"rarity_weights" json,
	"fries" json,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "player_week_stats" (
	"week" text NOT NULL,
	"user_id" text NOT NULL,
	"mode" text NOT NULL,
	"games" integer DEFAULT 0 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"damage" integer DEFAULT 0 NOT NULL,
	"kills" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "player_week_stats_week_user_id_mode_pk" PRIMARY KEY("week","user_id","mode")
);
--> statement-breakpoint
CREATE TABLE "trade_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"type" text NOT NULL,
	"amount" integer,
	"other_slug" text,
	"seen" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_sales_archive" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"price" integer NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "loadout" SET DEFAULT '{"outfit":"outfitBase","melee":"fists","heal":"heal_basic","boost":"boost_basic","death_effect":"death_basic","player_icon":"","crosshair":{"type":"crosshair_default","color":16777215,"size":"1.00","stroke":"0.00"},"emotes":["emote_happyface","emote_thumbsup","emote_surviv","emote_sadface","",""],"random":[],"randomExclude":[]}'::json;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tag_display" text DEFAULT 'both' NOT NULL;--> statement-breakpoint
ALTER TABLE "buy_orders" ADD CONSTRAINT "buy_orders_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "clan_invites" ADD CONSTRAINT "clan_invites_clan_id_clans_id_fk" FOREIGN KEY ("clan_id") REFERENCES "public"."clans"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "clan_invites" ADD CONSTRAINT "clan_invites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "clan_key_pool" ADD CONSTRAINT "clan_key_pool_clan_id_clans_id_fk" FOREIGN KEY ("clan_id") REFERENCES "public"."clans"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "clan_members" ADD CONSTRAINT "clan_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "clan_members" ADD CONSTRAINT "clan_members_clan_id_clans_id_fk" FOREIGN KEY ("clan_id") REFERENCES "public"."clans"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "clan_week_goals" ADD CONSTRAINT "clan_week_goals_clan_id_clans_id_fk" FOREIGN KEY ("clan_id") REFERENCES "public"."clans"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "clan_week_rewards" ADD CONSTRAINT "clan_week_rewards_clan_id_clans_id_fk" FOREIGN KEY ("clan_id") REFERENCES "public"."clans"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "clan_week_stats" ADD CONSTRAINT "clan_week_stats_clan_id_clans_id_fk" FOREIGN KEY ("clan_id") REFERENCES "public"."clans"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "clan_week_stats" ADD CONSTRAINT "clan_week_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "clans" ADD CONSTRAINT "clans_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "crate_openings" ADD CONSTRAINT "crate_openings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "player_week_stats" ADD CONSTRAINT "player_week_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "trade_events" ADD CONSTRAINT "trade_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "idx_anticheat_scores_created" ON "anticheat_scores" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_anticheat_scores_user" ON "anticheat_scores" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "buy_orders_status_type_idx" ON "buy_orders" USING btree ("status","type","amount");--> statement-breakpoint
CREATE INDEX "buy_orders_buyer_idx" ON "buy_orders" USING btree ("buyer_id","created_at");--> statement-breakpoint
CREATE INDEX "buy_orders_status_expires_idx" ON "buy_orders" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "buy_orders_open_buyer_type_idx" ON "buy_orders" USING btree ("buyer_id","type") WHERE "buy_orders"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "clan_invites_clan_user_idx" ON "clan_invites" USING btree ("clan_id","user_id");--> statement-breakpoint
CREATE INDEX "clan_invites_user_idx" ON "clan_invites" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "clan_members_clan_idx" ON "clan_members" USING btree ("clan_id");--> statement-breakpoint
CREATE INDEX "clan_week_rewards_clan_idx" ON "clan_week_rewards" USING btree ("clan_id");--> statement-breakpoint
CREATE INDEX "clan_week_stats_week_mode_idx" ON "clan_week_stats" USING btree ("week","mode");--> statement-breakpoint
CREATE UNIQUE INDEX "clans_name_lower_idx" ON "clans" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "clans_tag_upper_idx" ON "clans" USING btree (upper("tag"));--> statement-breakpoint
CREATE UNIQUE INDEX "clans_owner_idx" ON "clans" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clans_invite_code_idx" ON "clans" USING btree ("invite_code");--> statement-breakpoint
CREATE INDEX "crate_openings_user_idx" ON "crate_openings" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "crate_openings_created_idx" ON "crate_openings" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "trade_events_user_seen_idx" ON "trade_events" USING btree ("user_id","seen","created_at");--> statement-breakpoint
CREATE INDEX "trade_events_created_idx" ON "trade_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "trade_sales_archive_type_at_idx" ON "trade_sales_archive" USING btree ("type","at");