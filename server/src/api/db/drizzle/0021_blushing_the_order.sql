ALTER TABLE "match_data" ADD COLUMN "equipped_cosmetics" json DEFAULT '[]'::json NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "offers_disabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "loadout_private" boolean DEFAULT false NOT NULL;