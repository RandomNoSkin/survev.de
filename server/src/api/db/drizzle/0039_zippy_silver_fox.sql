CREATE TABLE "duel_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"game_id" uuid NOT NULL,
	"map_id" integer NOT NULL,
	"winner_user_id" text NOT NULL,
	"loser_user_id" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_duel_results_winner" ON "duel_results" USING btree ("winner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_duel_results_loser" ON "duel_results" USING btree ("loser_user_id","created_at");