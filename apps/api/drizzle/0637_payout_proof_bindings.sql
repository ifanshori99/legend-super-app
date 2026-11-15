-- legend-so897 (second opinion 895-897), F1 and F2: one proof = one operation,
-- in a tenant and across tenants.
-- F1: every proof used by an overpaid record, a return or a failed-item
-- correction is bound to exactly ONE operation (kind, batch, item set) by one
-- row of `payroll_payout_proof_bindings`. Both steps of the operation bind
-- before they write anything; any other operation finds the row by the key or
-- by either hash and is refused (the services answer 409 PAYOUT_PROOF_REUSED).
-- A binding is permanent: no UPDATE, no DELETE for the app role.
-- F2: `payroll_payout_proof_hashes` has no tenant: one hash belongs to one
-- binding across ALL tenants, so the same bank report cannot back a payment in
-- two PTs. RLS enabled, not forced, no policy, and no privilege for the app
-- role or PUBLIC (pattern 0126 delivery_store_index): only the SECURITY
-- DEFINER trigger below writes it, and no function reads it, so the app never
-- learns which tenant holds a hash.
CREATE TABLE "payroll_payout_proof_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"kind" varchar(10) NOT NULL,
	"item_set_hash" varchar(64) NOT NULL,
	"evidence_key" varchar(500) NOT NULL,
	"content_sha256" varchar(64) NOT NULL,
	"stored_sha256" varchar(64) NOT NULL,
	"legacy_duplicate" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_payout_proof_bindings_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_payout_proof_bindings_evidence_key" UNIQUE("tenant_id","evidence_key"),
	CONSTRAINT "payroll_payout_proof_bindings_kind_check" CHECK ("payroll_payout_proof_bindings"."kind" IN ('overpaid', 'return', 'correction')),
	CONSTRAINT "payroll_payout_proof_bindings_hash_check" CHECK ("payroll_payout_proof_bindings"."item_set_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "payroll_payout_proof_bindings_sha_check" CHECK ("payroll_payout_proof_bindings"."content_sha256" ~ '^[a-f0-9]{64}$' AND "payroll_payout_proof_bindings"."stored_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "payroll_payout_proof_bindings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_proof_bindings_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."payroll_disbursement_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "payroll_payout_proof_hashes" (
	"sha256" varchar(64) PRIMARY KEY NOT NULL,
	"binding_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_payout_proof_hashes_sha_check" CHECK ("payroll_payout_proof_hashes"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE INDEX "payroll_payout_proof_bindings_tenant_batch_idx" ON "payroll_payout_proof_bindings" USING btree ("tenant_id","batch_id");--> statement-breakpoint
CREATE INDEX "payroll_payout_proof_bindings_tenant_content_sha_idx" ON "payroll_payout_proof_bindings" USING btree ("tenant_id","content_sha256");--> statement-breakpoint
CREATE INDEX "payroll_payout_proof_bindings_tenant_stored_sha_idx" ON "payroll_payout_proof_bindings" USING btree ("tenant_id","stored_sha256");--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_payout_proof_bindings'::regclass);
--> statement-breakpoint
-- A binding is the record of which operation a proof backs: never changed,
-- never erased.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.payroll_payout_proof_bindings FROM legend_app;
--> statement-breakpoint
ALTER TABLE public.payroll_payout_proof_hashes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.payroll_payout_proof_hashes FROM legend_app;
--> statement-breakpoint
REVOKE ALL ON public.payroll_payout_proof_hashes FROM PUBLIC;
--> statement-breakpoint
-- (a) The hashes of a binding are those of the proof's upload record (same
-- tenant, same key, both hashes recorded): a writer cannot bind a proof under
-- invented hashes to dodge the global claim. Invoker: it reads the tenant's own
-- record under the tenant policy.
CREATE OR REPLACE FUNCTION app.payroll_payout_proof_bindings_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.payroll_payout_evidence_files f
     WHERE f.tenant_id = NEW.tenant_id
       AND f.evidence_key = NEW.evidence_key
       AND f.content_sha256 = NEW.content_sha256
       AND f.stored_sha256 IS NOT NULL
       AND f.stored_sha256 = NEW.stored_sha256
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PAYOUT-35: payout proof binding does not match the proof record'
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.payroll_payout_proof_bindings_guard() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_proof_bindings_guard_trg ON public.payroll_payout_proof_bindings;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_proof_bindings_guard_trg
  BEFORE INSERT ON public.payroll_payout_proof_bindings
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_proof_bindings_guard();
--> statement-breakpoint
-- (b) Claims the binding's hashes in the global table (the hash of zero bytes
-- identifies no proof and is skipped). A hash already held by another binding,
-- in any tenant, refuses the binding with a unique violation on the hash table's
-- key; the message names no hash, tenant or id. A `legacy_duplicate` binding
-- (a historical operation whose proof another binding already holds, written by
-- the backfill) must find at least one of its hashes held elsewhere, else it is
-- refused, and it still claims its other, unheld hash: the flag is never a free
-- pass. SECURITY DEFINER (owner of the hash table, which is not FORCED) because
-- the app role has no privilege on it; everything it writes comes from the
-- trigger row, which already passed the bindings' FORCED tenant policy and the
-- guard above. Only the trigger calls it: EXECUTE is revoked from PUBLIC.
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
DROP TRIGGER IF EXISTS payroll_payout_proof_bindings_claim_trg ON public.payroll_payout_proof_bindings;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_proof_bindings_claim_trg
  AFTER INSERT ON public.payroll_payout_proof_bindings
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_proof_bindings_claim();
