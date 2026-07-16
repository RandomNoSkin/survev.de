CREATE TABLE "auctions" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"seller_id" text NOT NULL,
	"seller_slug" text NOT NULL,
	"type" text NOT NULL,
	"category" text NOT NULL,
	"rarity" integer DEFAULT 0 NOT NULL,
	"min_bid" integer NOT NULL,
	"current_bid" integer,
	"current_bidder_id" text,
	"current_bidder_slug" text,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"seller_acked" boolean DEFAULT false NOT NULL,
	"winner_acked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"type" text NOT NULL,
	"from_user_id" text NOT NULL,
	"from_slug" text NOT NULL,
	"to_user_id" text NOT NULL,
	"to_slug" text NOT NULL,
	"amount" integer NOT NULL,
	"counter_amount" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"from_acked" boolean DEFAULT false NOT NULL,
	"to_acked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "price_paid" bigint;--> statement-breakpoint
ALTER TABLE "auctions" ADD CONSTRAINT "auctions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "auctions" ADD CONSTRAINT "auctions_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "auctions" ADD CONSTRAINT "auctions_current_bidder_id_users_id_fk" FOREIGN KEY ("current_bidder_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "auction_active_item_idx" ON "auctions" USING btree ("item_id") WHERE "auctions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "auction_status_ends_idx" ON "auctions" USING btree ("status","ends_at");--> statement-breakpoint
CREATE INDEX "auction_seller_status_idx" ON "auctions" USING btree ("seller_id","status");--> statement-breakpoint
CREATE INDEX "auction_bidder_status_idx" ON "auctions" USING btree ("current_bidder_id","status");--> statement-breakpoint
CREATE INDEX "offers_to_status_idx" ON "offers" USING btree ("to_user_id","status");--> statement-breakpoint
CREATE INDEX "offers_from_status_idx" ON "offers" USING btree ("from_user_id","status");--> statement-breakpoint
CREATE INDEX "offers_item_status_idx" ON "offers" USING btree ("item_id","status");