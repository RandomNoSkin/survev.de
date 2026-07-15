CREATE TABLE "game_moderation" (
	"game_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"marked_by" text NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"xp_deltas" json DEFAULT '[]'::json NOT NULL,
	CONSTRAINT "game_moderation_game_id_user_id_pk" PRIMARY KEY("game_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "loadout" SET DEFAULT '{"outfit":"outfitBase","melee":"fists","heal":"heal_basic","boost":"boost_basic","death_effect":"death_basic","player_icon":"","crosshair":{"type":"crosshair_default","color":16777215,"size":"1.00","stroke":"0.00"},"emotes":["emote_happyface","emote_thumbsup","emote_surviv","emote_sadface","",""]}'::json;--> statement-breakpoint
ALTER TABLE "match_data" ADD COLUMN "voided" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "game_moderation_user_idx" ON "game_moderation" USING btree ("user_id");