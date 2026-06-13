CREATE TABLE "ban_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"ban_type" text NOT NULL,
	"ban_target" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"banned_by" text NOT NULL,
	"banned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"permanent" boolean DEFAULT false NOT NULL,
	"unbanned_at" timestamp with time zone,
	"unbanned_by" text
);
--> statement-breakpoint
CREATE INDEX "ban_history_target_idx" ON "ban_history" USING btree ("ban_type","ban_target","banned_at");