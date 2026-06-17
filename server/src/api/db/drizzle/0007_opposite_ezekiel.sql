ALTER TABLE "market_listings" ADD COLUMN "target_buyer_slug" text;--> statement-breakpoint
CREATE INDEX "market_buyer_status_idx" ON "market_listings" USING btree ("target_buyer_slug","status");