CREATE TABLE "arena_loadouts" (
	"user_id" text NOT NULL,
	"slot" integer NOT NULL,
	"primary" text NOT NULL,
	"pistol" text NOT NULL,
	"throwable" text NOT NULL,
	"perk" text NOT NULL,
	CONSTRAINT "arena_loadouts_user_id_slot_pk" PRIMARY KEY("user_id","slot")
);
--> statement-breakpoint
CREATE TABLE "arena_progress" (
	"user_id" text PRIMARY KEY NOT NULL,
	"xp" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "arena_weapon_kills" (
	"user_id" text NOT NULL,
	"weapon_type" text NOT NULL,
	"kills" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "arena_weapon_kills_user_id_weapon_type_pk" PRIMARY KEY("user_id","weapon_type")
);
--> statement-breakpoint
CREATE TABLE "arena_streaks" (
	"user_id" text PRIMARY KEY NOT NULL,
	"airdrop" text NOT NULL,
	"juggernaut" text NOT NULL,
	"airdrop_weapon" text NOT NULL,
	"broken_arrow" boolean DEFAULT false NOT NULL,
	"off" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "arena_loadouts" ADD CONSTRAINT "arena_loadouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "arena_progress" ADD CONSTRAINT "arena_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "arena_weapon_kills" ADD CONSTRAINT "arena_weapon_kills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "arena_streaks" ADD CONSTRAINT "arena_streaks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;
