CREATE TABLE "golden_fries_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"amount" integer NOT NULL,
	"reason" text NOT NULL,
	"balance_after" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "golden_fries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "golden_fries_ledger" ADD CONSTRAINT "golden_fries_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "golden_fries_ledger_user_idx" ON "golden_fries_ledger" USING btree ("user_id","created_at");