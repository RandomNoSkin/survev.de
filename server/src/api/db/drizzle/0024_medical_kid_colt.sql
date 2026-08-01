ALTER TABLE "game_moderation" ADD COLUMN "resolved_by" text;--> statement-breakpoint
ALTER TABLE "game_moderation" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "game_moderation" ADD COLUMN "resolve_note" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "game_moderation_status_idx" ON "game_moderation" USING btree ("status","marked_at");--> statement-breakpoint
CREATE INDEX "game_moderation_marked_by_idx" ON "game_moderation" USING btree ("marked_by","marked_at");