CREATE TABLE "pass_item_grants" (
	"user_id" text NOT NULL,
	"grant_key" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pass_item_grants_user_id_grant_key_pk" PRIMARY KEY("user_id","grant_key")
);
--> statement-breakpoint
CREATE TABLE "shop_purchases" (
	"user_id" text NOT NULL,
	"day" text NOT NULL,
	"slot" integer NOT NULL,
	"purchased_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_purchases_user_id_day_slot_pk" PRIMARY KEY("user_id","day","slot")
);
--> statement-breakpoint
ALTER TABLE "items" DROP CONSTRAINT "items_user_id_type_pk";--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "id" serial PRIMARY KEY NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "previous_owners" json DEFAULT '[]'::json NOT NULL;--> statement-breakpoint
ALTER TABLE "pass_item_grants" ADD CONSTRAINT "pass_item_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "shop_purchases" ADD CONSTRAINT "shop_purchases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "items_user_idx" ON "items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "items_user_type_idx" ON "items" USING btree ("user_id","type");