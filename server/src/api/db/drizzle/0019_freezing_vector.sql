ALTER TABLE "friends" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
CREATE INDEX "friends_friend_idx" ON "friends" USING btree ("friend_id");