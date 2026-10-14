ALTER TABLE "users" ADD COLUMN "owner" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "show_owner_prefix" boolean DEFAULT true NOT NULL;