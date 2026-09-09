CREATE TABLE "premium_xp_grants" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"pass_type" text NOT NULL,
	"xp_granted" numeric NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "premium_xp_grants" ADD CONSTRAINT "premium_xp_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "premium_xp_grants_user_idx" ON "premium_xp_grants" USING btree ("user_id","granted_at");