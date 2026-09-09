ALTER TABLE "users" ADD COLUMN "show_admin_prefix" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "show_mod_prefix" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "show_premium_prefix" boolean DEFAULT true NOT NULL;