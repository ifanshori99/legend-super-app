-- legend-k2l (brief 290b, design ws08 M2/M3, 290-aturan-bersama §C/§F): member
-- sign-in identity. Adds the sign-in method to every session, the sealed
-- address of an email magic-link challenge, one WhatsApp number per account,
-- and the append-only `identity_merges` record.
--
-- Mechanics: every statement is additive. The only data statement is the
-- `session.auth_method` backfill (registered in MIGRATION_DATA_STATEMENTS); it
-- rewrites no other column and neither inserts nor deletes rows. `session`,
-- `user_identities`, `login_challenges` and `identity_merges` are global
-- tables with no row level security, so no FORCE RLS is lifted anywhere.

-- 1. Sign-in method and cross-device flag of a session.
ALTER TABLE "session" ADD COLUMN "auth_method" varchar(20) DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "auth_cross_device" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Sessions that exist now: a management session was opened with a password
-- (the only way in before this change), every other one stays `legacy` and is
-- never a management session again. New rows get their method from the code;
-- the column default stays `legacy` as the safe fallback.
UPDATE "session" SET "auth_method" = CASE WHEN "kind" = 'management' THEN 'password' ELSE 'legacy' END;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_auth_method_check" CHECK ("session"."auth_method" IN ('password', 'whatsapp', 'email_magic_link', 'google', 'legacy'));--> statement-breakpoint

-- 2. Sealed address of an email magic-link challenge.
ALTER TABLE "login_challenges" ADD COLUMN "email_encrypted" text;--> statement-breakpoint
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_email_encrypted_check" CHECK (("login_challenges"."channel" = 'email_magic_link') = ("login_challenges"."email_encrypted" IS NOT NULL));--> statement-breakpoint

-- 3. One WhatsApp identity per account. Never fail silently on the index: if
-- an account already holds two numbers, stop with a message that says who to
-- fix. No row is changed or deleted here.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT "user_id" FROM "user_identities"
     WHERE "type" = 'whatsapp'
     GROUP BY "user_id" HAVING count(*) > 1
  ) dup;
  IF n > 0 THEN
    RAISE EXCEPTION 'legend-k2l: % users hold more than one WhatsApp identity; resolve by hand before migrating', n;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_one_whatsapp_per_user" ON "user_identities" USING btree ("user_id") WHERE "user_identities"."type" = 'whatsapp';--> statement-breakpoint

-- 4. `identity_merges`: global, no tenant, no RLS (like `user_identities`).
CREATE TABLE "identity_merges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"survivor_user_id" text NOT NULL,
	"absorbed_user_id" text NOT NULL,
	"trigger" varchar(20) NOT NULL,
	"identity_ids" uuid[] NOT NULL,
	"profile_moves" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "identity_merges_absorbed_user_id_unique" UNIQUE("absorbed_user_id"),
	CONSTRAINT "identity_merges_trigger_check" CHECK ("identity_merges"."trigger" IN ('whatsapp_link', 'support')),
	CONSTRAINT "identity_merges_distinct_users_check" CHECK ("identity_merges"."survivor_user_id" <> "identity_merges"."absorbed_user_id")
);
--> statement-breakpoint
ALTER TABLE "identity_merges" ADD CONSTRAINT "identity_merges_survivor_user_id_user_id_fk" FOREIGN KEY ("survivor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_merges" ADD CONSTRAINT "identity_merges_absorbed_user_id_user_id_fk" FOREIGN KEY ("absorbed_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A merge is a record: never rewritten or deleted (pattern of
-- receipt_number_writeoffs, 0156).
CREATE OR REPLACE FUNCTION app.identity_merges_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'legend-k2l: % rows are append-only', TG_TABLE_NAME
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER "identity_merges_append_only_trg"
  BEFORE UPDATE OR DELETE ON "identity_merges"
  FOR EACH ROW EXECUTE FUNCTION app.identity_merges_append_only();
--> statement-breakpoint
REVOKE ALL ON TABLE public.identity_merges FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE public.identity_merges FROM legend_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.identity_merges TO legend_app;
--> statement-breakpoint

-- 5. Does an account hold a role assignment in ANY tenant? `role_assignments`
-- forces row level security (tenant_isolation needs app.tenant_id), so the
-- merge, which runs with no single tenant, cannot read it directly. The
-- function walks the tenants and sets the tenant scope for each probe, then
-- restores the caller's scope. SECURITY DEFINER with a pinned search_path
-- (pattern app.resolve_delivery_store, 0126); EXECUTE for legend_app only. It
-- returns only a boolean for a user id the caller already holds. Only a
-- currently active assignment counts, the same rule as `isAssignmentActive`
-- in packages/shared/src/access/scope.ts: active on [valid_from, valid_until),
-- valid_until null = open (ending a role early sets valid_until).
CREATE OR REPLACE FUNCTION app.user_has_role_assignment(p_user_id text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  previous text := coalesce(current_setting('app.tenant_id', true), '');
  t uuid;
  found boolean := false;
BEGIN
  FOR t IN SELECT id FROM public.tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    IF EXISTS (SELECT 1 FROM public.role_assignments WHERE user_id = p_user_id
                  AND valid_from <= now()
                  AND (valid_until IS NULL OR valid_until > now())) THEN
      found := true;
      EXIT;
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', previous, true);
  RETURN found;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.user_has_role_assignment(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.user_has_role_assignment(text) TO legend_app;
