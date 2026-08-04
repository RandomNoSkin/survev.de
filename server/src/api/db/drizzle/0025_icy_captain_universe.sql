CREATE TABLE "oauth_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"redirect_uris" json DEFAULT '[]'::json NOT NULL,
	"client_secret_hash" text NOT NULL,
	"secret_last_four" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"secret_rotated_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_auth_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"user_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"scopes" json DEFAULT '[]'::json NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_device_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_code" text NOT NULL,
	"application_id" text NOT NULL,
	"scopes" json DEFAULT '[]'::json NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" text,
	"poll_interval_sec" integer DEFAULT 5 NOT NULL,
	"last_polled_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"user_id" text NOT NULL,
	"application_id" text NOT NULL,
	"scopes" json DEFAULT '[]'::json NOT NULL,
	"access_token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "oauth_grants_user_id_application_id_pk" PRIMARY KEY("user_id","application_id")
);
--> statement-breakpoint
ALTER TABLE "oauth_applications" ADD CONSTRAINT "oauth_applications_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" ADD CONSTRAINT "oauth_auth_codes_application_id_oauth_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."oauth_applications"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" ADD CONSTRAINT "oauth_auth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "oauth_device_codes" ADD CONSTRAINT "oauth_device_codes_application_id_oauth_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."oauth_applications"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "oauth_device_codes" ADD CONSTRAINT "oauth_device_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_application_id_oauth_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."oauth_applications"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "oauth_applications_owner_idx" ON "oauth_applications" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "oauth_applications_status_idx" ON "oauth_applications" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "oauth_auth_codes_expires_idx" ON "oauth_auth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_auth_codes_application_idx" ON "oauth_auth_codes" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_device_codes_user_code_idx" ON "oauth_device_codes" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "oauth_device_codes_expires_idx" ON "oauth_device_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_device_codes_application_idx" ON "oauth_device_codes" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_grants_token_hash_idx" ON "oauth_grants" USING btree ("access_token_hash");--> statement-breakpoint
CREATE INDEX "oauth_grants_application_idx" ON "oauth_grants" USING btree ("application_id");