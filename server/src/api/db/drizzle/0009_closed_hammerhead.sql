CREATE TABLE "ban_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ban_type" text NOT NULL,
	"ban_target" text NOT NULL,
	"comment" text NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ban_comments_target_idx" ON "ban_comments" USING btree ("ban_type","ban_target","created_at");
