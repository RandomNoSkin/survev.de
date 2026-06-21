ALTER TABLE "user_xp" ADD COLUMN "reconcile_base_xp" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_xp" ADD COLUMN "reconcile_from" timestamp with time zone;