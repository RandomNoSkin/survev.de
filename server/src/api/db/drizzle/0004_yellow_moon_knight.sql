CREATE TABLE "market_listings" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"seller_id" text NOT NULL,
	"seller_slug" text NOT NULL,
	"type" text NOT NULL,
	"category" text NOT NULL,
	"price" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"buyer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "market_listings" ADD CONSTRAINT "market_listings_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "market_listings" ADD CONSTRAINT "market_listings_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "market_active_item_idx" ON "market_listings" USING btree ("item_id") WHERE "market_listings"."status" = 'active';--> statement-breakpoint
CREATE INDEX "market_status_created_idx" ON "market_listings" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "market_status_cat_created_idx" ON "market_listings" USING btree ("status","category","created_at");--> statement-breakpoint
CREATE INDEX "market_seller_status_idx" ON "market_listings" USING btree ("seller_id","status");