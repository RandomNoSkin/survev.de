CREATE TABLE "clan_key_gifts" (
	"id" serial PRIMARY KEY NOT NULL,
	"clan_id" integer NOT NULL,
	"week" text,
	"user_id" text NOT NULL,
	"giver_id" text NOT NULL,
	"key_type" text NOT NULL,
	"amount" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clan_key_gifts" ADD CONSTRAINT "clan_key_gifts_clan_id_clans_id_fk" FOREIGN KEY ("clan_id") REFERENCES "public"."clans"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "clan_key_gifts_clan_idx" ON "clan_key_gifts" USING btree ("clan_id","week");