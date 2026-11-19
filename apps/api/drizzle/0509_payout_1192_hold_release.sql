-- 1192 (legend-6o7pc, tier K: money). Part 1 of 3 (0509 tables and holds, 0510 grant kind,
-- 0511 release functions). No row is edited; nobody is paid by it: it only gives two
-- finance people a way to lift a hold, and counts what a hold really holds.
-- A hold (0507, payroll_payout_recon_unwritten_holds) of a flag that could not be written
-- stayed for ever when the flag was a locked-evidence flag (evidence_read_locked:<day>),
-- which is not written again on another day. Now:
-- 1. app.payout_recon_hold_unwritten (0507 body) returns an integer: the number of DISTINCT
--    items of p_items that hold AFTER the call (the new rows plus older holds that still
--    hold). A hold that an approved release lifted does not count and does not stop a new
--    hold row: a flag that fails to be written again after a release holds the slip again.
--    Return type changes: DROP FUNCTION then CREATE (owner legend_payout, ACL as 0507).
-- 2. payroll_payout_recon_hold_releases: one release per hold (UNIQUE), proposed then
--    approved once, never deleted (PAYOUT-87), written only by the payout functions of 0511;
--    legend_app may only read. Pattern of payroll_payout_recon_clearances (0460).
--    FK of the new table in CREATE TABLE; the holds table gets UNIQUE (tenant_id, id) first.
-- 3. Kind hold_release in the grant CHECKs (detail: sha256 of the reason, as recon_clear).
--    The name is short because payroll_payout_grants.kind is varchar(16).
-- 4. app.payout_payslip_held_by_recon (0507 body + one clause): a hold with an approved
--    release does not hold the slip. Signature, owner and ACL are unchanged.
-- 5. payroll_payout_recon_hold_clean_reads (insert-only, PAYOUT-87; legend_app may only read)
--    and app.payout_recon_clean_read (payout role, granted to legend_payout_recon): the
--    proof file of an operation was read and found ok while an evidence hold of it was
--    open. An 'ok' observation is deduped and is not written twice, so this is the record
--    a release needs ('clean' = a clean read after the hold, 0511). The function writes a
--    row only when the operation has an open evidence hold and no clean read since the
--    last such hold was made, so the table grows by one row per hold at most.
-- 6. hold_unwritten takes the advisory lock payout_recon_hold:<tenant>:<operation> (the
--    release functions of 0511 take it too) and dedupes only against a hold of the SAME
--    reason; for evidence reasons a clean read after the hold ends the dedupe, so a
--    failure after a clean read holds the slip again.
ALTER TABLE "payroll_payout_recon_unwritten_holds" ADD CONSTRAINT "payroll_payout_recon_unwritten_holds_tenant_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
CREATE TABLE "payroll_payout_recon_hold_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"hold_id" uuid NOT NULL,
	"reason" varchar(500) NOT NULL,
	"proposed_by" text NOT NULL,
	"proposed_session_id" text NOT NULL,
	"proposed_grant_id" uuid NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" text,
	"approved_session_id" text,
	"approved_grant_id" uuid,
	"approved_at" timestamp with time zone,
	"basis" varchar(16),
	CONSTRAINT "payroll_payout_recon_hold_releases_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_payout_recon_hold_releases_hold_key" UNIQUE("tenant_id","hold_id"),
	CONSTRAINT "payroll_payout_recon_hold_releases_reason_check" CHECK (char_length(btrim("payroll_payout_recon_hold_releases"."reason")) >= 10),
	CONSTRAINT "payroll_payout_recon_hold_releases_approved_check" CHECK (("payroll_payout_recon_hold_releases"."approved_by" IS NULL AND "payroll_payout_recon_hold_releases"."approved_session_id" IS NULL AND "payroll_payout_recon_hold_releases"."approved_grant_id" IS NULL AND "payroll_payout_recon_hold_releases"."approved_at" IS NULL AND "payroll_payout_recon_hold_releases"."basis" IS NULL) OR ("payroll_payout_recon_hold_releases"."approved_by" IS NOT NULL AND "payroll_payout_recon_hold_releases"."approved_session_id" IS NOT NULL AND "payroll_payout_recon_hold_releases"."approved_grant_id" IS NOT NULL AND "payroll_payout_recon_hold_releases"."approved_at" IS NOT NULL AND "payroll_payout_recon_hold_releases"."basis" IN ('flag_rewritten', 'clean_evidence') AND "payroll_payout_recon_hold_releases"."approved_by" <> "payroll_payout_recon_hold_releases"."proposed_by" AND "payroll_payout_recon_hold_releases"."approved_session_id" <> "payroll_payout_recon_hold_releases"."proposed_session_id")),
	CONSTRAINT "payroll_payout_recon_hold_releases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_recon_hold_releases_hold_fk" FOREIGN KEY ("tenant_id","hold_id") REFERENCES "public"."payroll_payout_recon_unwritten_holds"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_recon_hold_releases_proposed_grant_fk" FOREIGN KEY ("tenant_id","proposed_grant_id") REFERENCES "public"."payroll_payout_grants"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_recon_hold_releases_approved_grant_fk" FOREIGN KEY ("tenant_id","approved_grant_id") REFERENCES "public"."payroll_payout_grants"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "payroll_payout_grants" DROP CONSTRAINT "payroll_payout_grants_kind_check";
--> statement-breakpoint
ALTER TABLE "payroll_payout_grants" DROP CONSTRAINT "payroll_payout_grants_detail_check";
--> statement-breakpoint
ALTER TABLE "payroll_payout_grants" ADD CONSTRAINT "payroll_payout_grants_kind_check" CHECK ("payroll_payout_grants"."kind" IN ('correction', 'overpaid', 'return', 'posting_source', 'closure', 'resolve', 'bank_confirm', 'batch_approve', 'return_withdraw', 'disown', 'unfreeze', 'recon_clear', 'hold_release'));
--> statement-breakpoint
ALTER TABLE "payroll_payout_grants" ADD CONSTRAINT "payroll_payout_grants_detail_check" CHECK (("payroll_payout_grants"."kind" = 'resolve' AND "payroll_payout_grants"."detail" IN ('failed', 'not_sent')) OR ("payroll_payout_grants"."kind" = 'bank_confirm' AND "payroll_payout_grants"."detail" = 'succeeded') OR ("payroll_payout_grants"."kind" IN ('disown', 'unfreeze', 'recon_clear', 'return_withdraw', 'hold_release') AND "payroll_payout_grants"."detail" ~ '^[0-9a-f]{64}$') OR ("payroll_payout_grants"."kind" NOT IN ('resolve', 'bank_confirm', 'disown', 'unfreeze', 'recon_clear', 'return_withdraw', 'hold_release') AND "payroll_payout_grants"."detail" IS NULL));
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_payout_recon_hold_releases'::regclass);
--> statement-breakpoint
-- enforce_tenant_rls hands legend_app full DML; this table is read-only to it.
REVOKE ALL ON TABLE public.payroll_payout_recon_hold_releases FROM PUBLIC, legend_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.payroll_payout_recon_hold_releases TO legend_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.payroll_payout_recon_hold_releases TO legend_payout;
--> statement-breakpoint
GRANT UPDATE (approved_by, approved_session_id, approved_grant_id, approved_at, basis)
  ON TABLE public.payroll_payout_recon_hold_releases TO legend_payout;
--> statement-breakpoint
-- A release moves once: the approve step fills approved_by, approved_session_id,
-- approved_grant_id, approved_at and basis from NULL (the CHECK says the approver is
-- not the proposer, nor the session that proposed); every other column stays, and a
-- row is never deleted (PAYOUT-87, 23514).
CREATE FUNCTION app.payroll_payout_recon_hold_releases_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.approved_at IS NULL AND NEW.approved_at IS NOT NULL
    AND (to_jsonb(NEW) - 'approved_by' - 'approved_session_id' - 'approved_grant_id' - 'approved_at' - 'basis')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'approved_by' - 'approved_session_id' - 'approved_grant_id' - 'approved_at' - 'basis') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PAYOUT-87: a hold release cannot be changed or erased once approved'
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_recon_hold_releases_row_guard_trg
  BEFORE UPDATE OR DELETE ON public.payroll_payout_recon_hold_releases
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_recon_hold_releases_guard();
--> statement-breakpoint
CREATE TRIGGER payroll_payout_recon_hold_releases_truncate_guard_trg
  BEFORE TRUNCATE ON public.payroll_payout_recon_hold_releases
  FOR EACH STATEMENT EXECUTE FUNCTION app.payroll_payout_recon_hold_releases_guard();
--> statement-breakpoint
CREATE TABLE "payroll_payout_recon_hold_clean_reads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "payroll_payout_recon_hold_clean_reads_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_payout_recon_hold_clean_reads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "payroll_payout_recon_hold_clean_reads_op_idx" ON "payroll_payout_recon_hold_clean_reads" USING btree ("tenant_id","operation_id","read_at");--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_payout_recon_hold_clean_reads'::regclass);
--> statement-breakpoint
-- enforce_tenant_rls hands legend_app full DML; this table is read-only to it.
REVOKE ALL ON TABLE public.payroll_payout_recon_hold_clean_reads FROM PUBLIC, legend_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.payroll_payout_recon_hold_clean_reads TO legend_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.payroll_payout_recon_hold_clean_reads TO legend_payout;
--> statement-breakpoint
-- Insert-only: a row is never changed or deleted (PAYOUT-87, 23514).
CREATE FUNCTION app.payroll_payout_recon_hold_clean_reads_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'PAYOUT-87: a clean read of a hold cannot be changed or erased'
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_recon_hold_clean_reads_row_guard_trg
  BEFORE UPDATE OR DELETE ON public.payroll_payout_recon_hold_clean_reads
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_recon_hold_clean_reads_guard();
--> statement-breakpoint
CREATE TRIGGER payroll_payout_recon_hold_clean_reads_truncate_guard_trg
  BEFORE TRUNCATE ON public.payroll_payout_recon_hold_clean_reads
  FOR EACH STATEMENT EXECUTE FUNCTION app.payroll_payout_recon_hold_clean_reads_guard();
--> statement-breakpoint
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint
-- The number of DISTINCT items of p_items that hold after the call (1192).
DROP FUNCTION app.payout_recon_hold_unwritten(uuid, text, uuid, uuid[], text);
--> statement-breakpoint
CREATE FUNCTION app.payout_recon_hold_unwritten(
  p_tenant uuid, p_kind text, p_operation uuid, p_items uuid[], p_reason text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_held integer;
BEGIN
  IF p_tenant IS DISTINCT FROM app.require_tenant_id() THEN
    RAISE EXCEPTION 'PAYOUT-68: a hold is recorded in the tenant in force only'
      USING ERRCODE = '23514';
  END IF;
  IF p_kind IS NULL OR p_operation IS NULL OR p_items IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-68: the hold needs a kind, an operation and items'
      USING ERRCODE = '23514';
  END IF;
  -- One writer per operation at a time (the release functions take the same lock): the
  -- dedupe below and the clean read cannot interleave with a release.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'payout_recon_hold:' || p_tenant::text || ':' || p_operation::text, 0));
  INSERT INTO public.payroll_payout_recon_unwritten_holds (
    tenant_id, kind, operation_id, item_id, payslip_id, reason, created_at)
  SELECT p_tenant, p_kind, p_operation, i.id, i.payslip_id, p_reason, pg_catalog.clock_timestamp()
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = p_tenant AND i.id = ANY (p_items)
     AND NOT EXISTS (
       -- A hold of the same kind, operation, item and REASON that no flag has taken over
       -- yet and no approved release lifted already holds the slip: no second row. A hold
       -- that a flag took over, or that was released, does NOT count: a later failed
       -- write must hold the slip again. For an evidence reason a clean read of the
       -- operation after the hold ends the dedupe too (the slip may be released by a
       -- release, so a new failure needs its own hold); other reasons ignore clean reads,
       -- which bounds the growth of the table.
       SELECT 1
         FROM public.payroll_payout_recon_unwritten_holds h
        WHERE h.tenant_id = p_tenant AND h.kind = p_kind
          AND h.operation_id = p_operation AND h.item_id = i.id
          AND h.reason IS NOT DISTINCT FROM p_reason
          AND (NOT COALESCE(p_reason IN ('evidence_missing', 'evidence_hash_mismatch')
                            OR p_reason LIKE 'evidence\_read\_locked:%', false)
               OR NOT EXISTS (
                    SELECT 1
                      FROM public.payroll_payout_recon_hold_clean_reads cr
                     WHERE cr.tenant_id = h.tenant_id AND cr.operation_id = h.operation_id
                       AND cr.read_at > h.created_at))
          AND NOT EXISTS (
              SELECT 1
                FROM public.payroll_payout_recon_hold_releases r
               WHERE r.tenant_id = h.tenant_id AND r.hold_id = h.id
                 AND r.approved_at IS NOT NULL)
          AND NOT EXISTS (
              SELECT 1
                FROM public.payroll_payout_recon_exceptions e
               WHERE e.tenant_id = h.tenant_id AND e.kind = h.kind
                 AND e.operation_id = h.operation_id AND e.item_id = h.item_id
                 AND (h.reason IS NULL OR e.reason = h.reason
                      OR pg_catalog.left(e.reason, pg_catalog.length(h.reason) + 1) = h.reason || '#')
                 AND (e.flagged_at >= h.created_at
                      OR NOT EXISTS (
                        SELECT 1
                          FROM public.payroll_payout_recon_clearances c
                         WHERE c.tenant_id = e.tenant_id AND c.exception_id = e.id
                           AND c.approved_at IS NOT NULL
                           AND c.approved_at < h.created_at)))
         );
  -- How many of the items hold now: a hold row that no flag took over and no release lifted.
  SELECT pg_catalog.count(DISTINCT h.item_id)::integer INTO v_held
    FROM public.payroll_payout_recon_unwritten_holds h
   WHERE h.tenant_id = p_tenant AND h.kind = p_kind
     AND h.operation_id = p_operation AND h.item_id = ANY (p_items)
     AND NOT EXISTS (
         SELECT 1
           FROM public.payroll_payout_recon_hold_releases r
          WHERE r.tenant_id = h.tenant_id AND r.hold_id = h.id
            AND r.approved_at IS NOT NULL)
     AND NOT EXISTS (
         SELECT 1
           FROM public.payroll_payout_recon_exceptions e
          WHERE e.tenant_id = h.tenant_id AND e.kind = h.kind
            AND e.operation_id = h.operation_id AND e.item_id = h.item_id
            AND (h.reason IS NULL OR e.reason = h.reason
                 OR pg_catalog.left(e.reason, pg_catalog.length(h.reason) + 1) = h.reason || '#')
            AND (e.flagged_at >= h.created_at
                 OR NOT EXISTS (
                   SELECT 1
                     FROM public.payroll_payout_recon_clearances c
                    WHERE c.tenant_id = e.tenant_id AND c.exception_id = e.id
                      AND c.approved_at IS NOT NULL
                      AND c.approved_at < h.created_at)));
  RETURN v_held;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_recon_hold_unwritten(uuid, text, uuid, uuid[], text) FROM PUBLIC, legend_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_recon_hold_unwritten(uuid, text, uuid, uuid[], text) TO legend_payout_recon;
--> statement-breakpoint
-- The proof file of the operation was read and found ok (called by recordReadOk, as the
-- role legend_payout_recon, after observe_ok). Returns true when a row was written: the
-- operation has an open evidence hold (no approved release) and no clean read yet since
-- the last such hold was made. Otherwise false and nothing is written.
CREATE FUNCTION app.payout_recon_clean_read(p_tenant uuid, p_operation uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_last timestamptz;
BEGIN
  IF p_tenant IS DISTINCT FROM app.require_tenant_id() THEN
    RAISE EXCEPTION 'PAYOUT-68: a clean read is recorded in the tenant in force only'
      USING ERRCODE = '23514';
  END IF;
  IF p_operation IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-68: the clean read needs an operation'
      USING ERRCODE = '23514';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'payout_recon_hold:' || p_tenant::text || ':' || p_operation::text, 0));
  SELECT pg_catalog.max(h.created_at) INTO v_last
    FROM public.payroll_payout_recon_unwritten_holds h
   WHERE h.tenant_id = p_tenant AND h.operation_id = p_operation
     AND (h.reason IN ('evidence_missing', 'evidence_hash_mismatch')
          OR h.reason LIKE 'evidence\_read\_locked:%')
     AND NOT EXISTS (
         SELECT 1
           FROM public.payroll_payout_recon_hold_releases r
          WHERE r.tenant_id = h.tenant_id AND r.hold_id = h.id
            AND r.approved_at IS NOT NULL);
  IF v_last IS NULL THEN
    RETURN false;
  END IF;
  IF EXISTS (
       SELECT 1
         FROM public.payroll_payout_recon_hold_clean_reads cr
        WHERE cr.tenant_id = p_tenant AND cr.operation_id = p_operation
          AND cr.read_at > v_last) THEN
    RETURN false;
  END IF;
  INSERT INTO public.payroll_payout_recon_hold_clean_reads (tenant_id, operation_id)
  VALUES (p_tenant, p_operation);
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_recon_clean_read(uuid, uuid) FROM PUBLIC, legend_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_recon_clean_read(uuid, uuid) TO legend_payout_recon;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payout_payslip_held_by_recon(p_tenant uuid, p_payslip uuid)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.payroll_payout_recon_exceptions e
     WHERE e.tenant_id = p_tenant AND e.payslip_id = p_payslip
       AND NOT EXISTS (
         SELECT 1
           FROM public.payroll_payout_recon_clearances c
          WHERE c.tenant_id = e.tenant_id AND c.exception_id = e.id
            AND c.approved_at IS NOT NULL
            AND c.flag_sha256 = app.payout_recon_flag_fingerprint(e.tenant_id, e.id)))
  OR EXISTS (
    -- A flag of this slip could not be written (hold_unwritten) and no exception
    -- took the hold over (same kind, operation, item and reason, flagged since or
    -- not cleared before the hold) and no approved release lifted it (1192): the
    -- slip stays held.
    SELECT 1
      FROM public.payroll_payout_recon_unwritten_holds h
     WHERE h.tenant_id = p_tenant AND h.payslip_id = p_payslip
       AND NOT EXISTS (
            SELECT 1
              FROM public.payroll_payout_recon_hold_releases r
             WHERE r.tenant_id = h.tenant_id AND r.hold_id = h.id
               AND r.approved_at IS NOT NULL)
       AND NOT EXISTS (
            SELECT 1
              FROM public.payroll_payout_recon_exceptions e
             WHERE e.tenant_id = h.tenant_id AND e.kind = h.kind
               AND e.operation_id = h.operation_id AND e.item_id = h.item_id
               AND (h.reason IS NULL OR e.reason = h.reason
                    OR pg_catalog.left(e.reason, pg_catalog.length(h.reason) + 1) = h.reason || '#')
               AND (e.flagged_at >= h.created_at
                    OR NOT EXISTS (
                      SELECT 1
                        FROM public.payroll_payout_recon_clearances c
                       WHERE c.tenant_id = e.tenant_id AND c.exception_id = e.id
                         AND c.approved_at IS NOT NULL
                         AND c.approved_at < h.created_at))))
$$;
