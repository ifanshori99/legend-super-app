CREATE TABLE "sealed_secret_reseal_state" (
	"table_name" text NOT NULL,
	"column_name" text NOT NULL,
	"scope_key" text NOT NULL,
	"last_id" uuid,
	"key_version" integer NOT NULL,
	"resealed_count" bigint DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sealed_secret_reseal_state_pkey" PRIMARY KEY("table_name","column_name","scope_key")
);
--> statement-breakpoint
-- Platform sweep progress (ids and counts only, no RLS): the app login reads
-- and writes it, never deletes.
REVOKE ALL ON TABLE public.sealed_secret_reseal_state FROM PUBLIC, legend_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE public.sealed_secret_reseal_state TO legend_app;
