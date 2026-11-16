-- legend-so897 review P2-1: a proof hash contested across tenants stops every
-- operation over it.
-- Before the bindings, PT A could have an OPEN operation (a return with step
-- one done) and PT B a finished one on the same bytes. When the backfill reaches
-- A first, A gets the normal binding and B a `legacy_duplicate` one; A's next
-- step only sees A's bindings and would finish on a proof that already backed
-- B's money movement. The claim trigger now records every hash a
-- legacy_duplicate binding finds already held in the global
-- `payroll_payout_proof_hash_contests`, and the services refuse any step over a
-- contested hash (409 PAYOUT_PROOF_REUSED, the same text as any reuse).
-- Same access as `payroll_payout_proof_hashes` (0395, pattern 0126): no tenant,
-- RLS enabled and not forced, no policy, no privilege for the app role or
-- PUBLIC. The app can only ask `app.payout_proof_contested(shas)`, a yes or no
-- about hashes it already holds the bytes of; it never learns who holds them.
CREATE TABLE "payroll_payout_proof_hash_contests" (
	"sha256" varchar(64) PRIMARY KEY NOT NULL,
	"contested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_payout_proof_hash_contests_sha_check" CHECK ("payroll_payout_proof_hash_contests"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE public.payroll_payout_proof_hash_contests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.payroll_payout_proof_hash_contests FROM legend_app;
--> statement-breakpoint
REVOKE ALL ON public.payroll_payout_proof_hash_contests FROM PUBLIC;
--> statement-breakpoint
-- The 0395 claim function, verbatim except one statement: a legacy_duplicate
-- binding whose hash is already held records that hash as contested.
CREATE OR REPLACE FUNCTION app.payroll_payout_proof_bindings_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  sha varchar;
  claimed integer;
  held_elsewhere boolean := false;
BEGIN
  FOR sha IN
    SELECT DISTINCT h
      FROM unnest(ARRAY[NEW.content_sha256, NEW.stored_sha256]::varchar[]) AS h
     WHERE h <> 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  LOOP
    INSERT INTO public.payroll_payout_proof_hashes (sha256, binding_id, claimed_at)
    VALUES (sha, NEW.id, statement_timestamp())
    ON CONFLICT (sha256) DO NOTHING;
    GET DIAGNOSTICS claimed = ROW_COUNT;
    IF claimed = 0 THEN
      IF NOT NEW.legacy_duplicate THEN
        RAISE EXCEPTION 'PAYOUT-35: payout proof already used'
          USING ERRCODE = '23505', CONSTRAINT = 'payroll_payout_proof_hashes_pkey';
      END IF;
      held_elsewhere := true;
      INSERT INTO public.payroll_payout_proof_hash_contests (sha256, contested_at)
      VALUES (sha, statement_timestamp())
      ON CONFLICT (sha256) DO NOTHING;
    END IF;
  END LOOP;
  IF NEW.legacy_duplicate AND NOT held_elsewhere THEN
    RAISE EXCEPTION 'PAYOUT-35: a legacy duplicate binding needs a proof already held by another binding'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.payroll_payout_proof_bindings_claim() FROM PUBLIC;
--> statement-breakpoint
-- True when any of these hashes is contested. SECURITY DEFINER (owner of the
-- contest table, which is not FORCED) because the app role has no privilege on
-- it; it answers one boolean and nothing else.
CREATE OR REPLACE FUNCTION app.payout_proof_contested(shas varchar[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.payroll_payout_proof_hash_contests c
     WHERE c.sha256 = ANY (shas)
  )
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.payout_proof_contested(varchar[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_proof_contested(varchar[]) TO legend_app;
