-- legend-8vcsg (second opinion, payout area final, two P2 proof findings).
-- A JPEG or PNG proof is re-encoded before it is stored, so the object that is
-- downloaded and uploaded again hashes differently from the original bytes the
-- fingerprint of 0382 recorded. Every proof now carries TWO hashes: of the
-- uploaded bytes (content_sha256) and of the bytes as stored (stored_sha256);
-- a return claim copies both, and a proof is reused when either of its hashes
-- meets either hash of a used proof (checked by the services under one advisory
-- lock per hash).
-- Proofs from before 0382 have no fingerprint at all: the payout evidence job
-- reads their stored objects and fills the missing hashes in (only NULL to a
-- value, never a change). Until a tenant's claims all carry both hashes, a new
-- proof cannot start or continue a return for that tenant (fail closed, in the
-- service). A claim over an empty object carries the hash of zero bytes. No data statement here: the job does the backfill at runtime.
ALTER TABLE "payroll_payout_evidence_files" ADD COLUMN "stored_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "payroll_payout_evidence_files" ADD CONSTRAINT "payroll_payout_evidence_files_stored_sha_check" CHECK ("payroll_payout_evidence_files"."stored_sha256" IS NULL OR "payroll_payout_evidence_files"."stored_sha256" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
CREATE INDEX "payroll_payout_evidence_files_tenant_stored_sha_idx" ON "payroll_payout_evidence_files" USING btree ("tenant_id","stored_sha256");--> statement-breakpoint
ALTER TABLE "payroll_payout_return_claims" ADD COLUMN "stored_sha256" varchar(64);--> statement-breakpoint
-- The hash of zero bytes (an empty object is no proof) is recorded but never
-- identifies a proof, so both unique indexes skip it.
DROP INDEX "payroll_payout_return_claims_content_sha_key";--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_payout_return_claims_content_sha_key" ON "payroll_payout_return_claims" USING btree ("tenant_id","content_sha256") WHERE "payroll_payout_return_claims"."content_sha256" IS NOT NULL AND "payroll_payout_return_claims"."content_sha256" <> 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_payout_return_claims_stored_sha_key" ON "payroll_payout_return_claims" USING btree ("tenant_id","stored_sha256") WHERE "payroll_payout_return_claims"."stored_sha256" IS NOT NULL AND "payroll_payout_return_claims"."stored_sha256" <> 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';--> statement-breakpoint
ALTER TABLE "payroll_payout_return_claims" ADD CONSTRAINT "payroll_payout_return_claims_stored_sha_check" CHECK ("payroll_payout_return_claims"."stored_sha256" IS NULL OR "payroll_payout_return_claims"."stored_sha256" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
-- The fingerprint record stays append only (0382 revoked UPDATE on the table);
-- the one column the job may fill in later is stored_sha256, once, NULL to a value.
GRANT UPDATE (stored_sha256) ON TABLE public.payroll_payout_evidence_files TO legend_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_payout_evidence_files_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.stored_sha256 IS NULL AND NEW.stored_sha256 IS NOT NULL
    AND (to_jsonb(NEW) - 'stored_sha256') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'stored_sha256') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PAYOUT-32: payout proof fingerprint % cannot change', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_evidence_files_guard_trg ON public.payroll_payout_evidence_files;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_evidence_files_guard_trg
  BEFORE UPDATE ON public.payroll_payout_evidence_files
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_evidence_files_guard();
--> statement-breakpoint
-- A claim moves only open -> consumed (0381); it may also take the two proof
-- hashes of a claim that predates them (NULL to a value, each once). Nothing
-- else about a claim may change.
CREATE OR REPLACE FUNCTION app.payroll_payout_return_claims_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.status = 'open' AND NEW.status = 'consumed' AND NEW.consumed_at IS NOT NULL
    AND (to_jsonb(NEW) - 'status' - 'consumed_at')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'status' - 'consumed_at') THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'content_sha256' - 'stored_sha256')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'content_sha256' - 'stored_sha256')
    AND (OLD.content_sha256 IS NULL OR NEW.content_sha256 IS NOT DISTINCT FROM OLD.content_sha256)
    AND (OLD.stored_sha256 IS NULL OR NEW.stored_sha256 IS NOT DISTINCT FROM OLD.stored_sha256) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PAYOUT-31: return claim % cannot change', OLD.id
    USING ERRCODE = '23514';
END $$;
