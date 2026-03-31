CREATE TABLE "user_xp" (
	"user_id" text NOT NULL,
	"pass_type" text NOT NULL,
	"level" integer NOT NULL,
	"xp" integer NOT NULL,
	"last_updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_xp" ADD CONSTRAINT "user_xp_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;