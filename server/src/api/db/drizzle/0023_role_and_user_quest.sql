ALTER TABLE "match_data" ADD COLUMN IF NOT EXISTS "role" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE "user_quest" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"idx" integer NOT NULL,
	"quest_type" text NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"target" integer NOT NULL,
	"complete" boolean DEFAULT false NOT NULL,
	"rerolled" boolean DEFAULT false NOT NULL,
	"time_acquired" bigint NOT NULL,
	"next_refresh_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_quest" ADD CONSTRAINT "user_quest_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "user_quest_user_idx" ON "user_quest" USING btree ("user_id","idx");
