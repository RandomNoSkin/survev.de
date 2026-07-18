CREATE TABLE "gift_notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"recipient_id" text NOT NULL,
	"from_slug" text NOT NULL,
	"from_name" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	"item_type" text DEFAULT '' NOT NULL,
	"acked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gift_notifications" ADD CONSTRAINT "gift_notifications_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "gift_notifications_recipient_idx" ON "gift_notifications" USING btree ("recipient_id","acked");