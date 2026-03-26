CREATE TABLE "chat_banned_ips" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_in" timestamp NOT NULL,
	"encoded_ip" text PRIMARY KEY NOT NULL,
	"permanent" boolean DEFAULT false NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"banned_by" text DEFAULT 'admin' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "admin" boolean DEFAULT false NOT NULL;