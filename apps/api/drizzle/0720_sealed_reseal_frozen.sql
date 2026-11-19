-- Custom SQL migration fragment for legend-4vfmn / legend-49onu (migration 0720).
-- Keep this file and the migration in step.
--
-- Four sealed columns sit in rows that no application role may update:
-- orders.payment_link_token_sealed, orders.claim_token_sealed (final orders,
-- orders_final_immutable_trg), pos_order_tenders.payment_link_token_sealed
-- (tenders of a final order, pos_order_tenders_final_immutable_trg) and
-- apology_vouchers.code_sealed (UPDATE revoked from legend_app). The reseal job
-- could therefore never move them to the active key.
--
-- One narrow door: app.reseal_frozen_sealed. It is owned by the migrator,
-- SECURITY DEFINER, and executable only by legend_sealed_reseal (NOLOGIN,
-- NOINHERIT). No application, worker, maintenance or grantor login is a member of
-- that group or can SET ROLE to it (legend_app is explicitly revoked; fix 1198,
-- legend-qwm9r): only the dedicated login legend_reseal_<16 hex> is a member
-- (INHERIT TRUE, SET FALSE, no ADMIN; provisioned by provision-roles.ts), so the
-- caller cannot widen the door by setting a session GUC. The function reads the
-- tenant from the target row itself, never from a GUC. The final-row triggers
-- allow an UPDATE only when ALL hold: current_user owns that function (a login of
-- the app can never be its owner, whatever GUC it sets), app.sealed_reseal_column
-- names exactly that column, and every other column is unchanged. The function
-- never changes the plaintext: the compare-and-set is on the old ciphertext, and
-- the envelope version byte can only go up.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legend_sealed_reseal') THEN
    CREATE ROLE legend_sealed_reseal NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legend_sealed_reseal' AND
                (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication
                 OR rolcanlogin OR rolinherit)) THEN
    RAISE EXCEPTION 'legend_sealed_reseal exists with unsafe privileges';
  END IF;
  -- legend_app must not reach the group (fix 1198, legend-qwm9r): a compromised
  -- app login could otherwise SET ROLE and call the function. Idempotent.
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
     WHERE m.roleid = 'legend_sealed_reseal'::regrole AND m.member = 'legend_app'::regrole) THEN
    REVOKE legend_sealed_reseal FROM legend_app;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO legend_sealed_reseal;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reseal_frozen_sealed(
  p_table text, p_column text, p_tenant uuid, p_id uuid, p_expected text, p_new text
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_key text := p_table || '.' || p_column;
  v_rows integer;
  v_row_tenant uuid;
  v_locked integer;
BEGIN
  IF v_key IS NULL OR v_key NOT IN (
    'orders.payment_link_token_sealed',
    'orders.claim_token_sealed',
    'pos_order_tenders.payment_link_token_sealed',
    'apology_vouchers.code_sealed'
  ) THEN
    RAISE EXCEPTION 'reseal_frozen_sealed: % is not a frozen sealed column', v_key
      USING ERRCODE = '22023';
  END IF;
  IF p_tenant IS NULL OR p_id IS NULL OR p_expected IS NULL OR p_new IS NULL THEN
    RAISE EXCEPTION 'reseal_frozen_sealed: tenant, id and both sealed values are required'
      USING ERRCODE = '22023';
  END IF;
  -- The tenant comes from the target row, not from a GUC. The migrator owner
  -- bypasses RLS. p_table is whitelisted above, so %I cannot be abused.
  EXECUTE format('SELECT tenant_id FROM public.%I WHERE id = $1', p_table)
    INTO v_row_tenant USING p_id;
  -- EXECUTE does not set FOUND; tenant_id is NOT NULL, so NULL means no such row.
  IF v_row_tenant IS NULL THEN
    RETURN 0;
  END IF;
  IF v_row_tenant <> p_tenant THEN
    RAISE EXCEPTION 'reseal_frozen_sealed: tenant does not match the row'
      USING ERRCODE = '42501';
  END IF;
  IF p_new = p_expected
    OR p_expected !~ '^[A-Za-z0-9+/]{4}'
    OR p_new !~ '^[A-Za-z0-9+/]+={0,2}$'
    OR length(p_new) % 4 <> 0
    OR length(p_new) > 8192
  THEN
    RAISE EXCEPTION 'reseal_frozen_sealed: new value must differ from the old and be a complete base64 envelope'
      USING ERRCODE = '22023';
  END IF;
  -- Envelope = 1 version byte + 12 nonce + 16 tag + ciphertext (lib/secrets.ts).
  -- Same plaintext under any key version gives the same length, so a new value
  -- of another length is not a reseal of this one. The version never goes down.
  IF octet_length(decode(p_new, 'base64')) < 29
    OR octet_length(decode(p_new, 'base64')) <> octet_length(decode(p_expected, 'base64'))
    OR get_byte(decode(p_new, 'base64'), 0) < get_byte(decode(p_expected, 'base64'), 0)
  THEN
    RAISE EXCEPTION 'reseal_frozen_sealed: new envelope must have the old length and an envelope version that does not go down'
      USING ERRCODE = '22023';
  END IF;

  -- Never wait for a row another transaction holds: -1 = busy, the job leaves it
  -- for the next pass. 0 = compare-and-set lost or row gone, > 0 = resealed.
  EXECUTE format('SELECT 1 FROM public.%I WHERE id = $1 FOR NO KEY UPDATE SKIP LOCKED', p_table)
    INTO v_locked USING p_id;
  IF v_locked IS NULL THEN
    RETURN -1;
  END IF;

  PERFORM set_config('app.sealed_reseal_column', v_key, true);
  IF v_key = 'orders.payment_link_token_sealed' THEN
    UPDATE public.orders SET payment_link_token_sealed = p_new
     WHERE tenant_id = p_tenant AND id = p_id AND payment_link_token_sealed = p_expected;
  ELSIF v_key = 'orders.claim_token_sealed' THEN
    UPDATE public.orders SET claim_token_sealed = p_new
     WHERE tenant_id = p_tenant AND id = p_id AND claim_token_sealed = p_expected;
  ELSIF v_key = 'pos_order_tenders.payment_link_token_sealed' THEN
    UPDATE public.pos_order_tenders SET payment_link_token_sealed = p_new
     WHERE tenant_id = p_tenant AND id = p_id AND payment_link_token_sealed = p_expected;
  ELSE
    UPDATE public.apology_vouchers SET code_sealed = p_new
     WHERE tenant_id = p_tenant AND id = p_id AND code_sealed = p_expected;
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('app.sealed_reseal_column', '', true);
  RETURN v_rows;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reseal_frozen_sealed(text, text, uuid, uuid, text, text) FROM PUBLIC, legend_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.reseal_frozen_sealed(text, text, uuid, uuid, text, text) TO legend_sealed_reseal;
--> statement-breakpoint
-- 2. POS-04: a completed or voided order is history. No UPDATE, no DELETE of
--    the order row, whatever the channel (QR never rewrites a final order).
--    One exception (migration 0720, legend-4vfmn): the sealed-secret reseal job
--    may rewrite orders.payment_link_token_sealed or orders.claim_token_sealed
--    through app.reseal_frozen_sealed (sealed-reseal-frozen.custom.sql) and
--    nothing else. See that file for why the owner and GUC checks are both needed.
CREATE OR REPLACE FUNCTION app.orders_final_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  v_col text;
BEGIN
  IF OLD.status IN ('completed', 'voided') THEN
    IF TG_OP = 'UPDATE' THEN
      v_col := CASE current_setting('app.sealed_reseal_column', true)
        WHEN 'orders.payment_link_token_sealed' THEN 'payment_link_token_sealed'
        WHEN 'orders.claim_token_sealed' THEN 'claim_token_sealed'
      END;
      IF v_col IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_proc p
          WHERE p.oid = 'app.reseal_frozen_sealed(text,text,uuid,uuid,text,text)'::pg_catalog.regprocedure
            AND p.proowner = (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)
        )
        AND (to_jsonb(NEW) - v_col) = (to_jsonb(OLD) - v_col)
        AND (to_jsonb(NEW) -> v_col) IS DISTINCT FROM (to_jsonb(OLD) -> v_col)
      THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'POS-04: order % is final and cannot be changed or deleted', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- 4. POS extension rows (attribution, holds, tenders, discounts) of a final
--    order are frozen. Every table here carries (tenant_id, order_id).
--    One exception (migration 0720, legend-4vfmn): the sealed-secret reseal job
--    may rewrite pos_order_tenders.payment_link_token_sealed through
--    app.reseal_frozen_sealed and nothing else.
CREATE OR REPLACE FUNCTION app.pos_order_rows_final_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.tenant_id = OLD.tenant_id AND o.id = OLD.order_id
      AND o.status IN ('completed', 'voided')
  ) THEN
    IF TG_OP = 'UPDATE'
      AND TG_TABLE_NAME = 'pos_order_tenders'
      AND current_setting('app.sealed_reseal_column', true) = 'pos_order_tenders.payment_link_token_sealed'
      AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid = 'app.reseal_frozen_sealed(text,text,uuid,uuid,text,text)'::pg_catalog.regprocedure
          AND p.proowner = (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)
      )
      AND (to_jsonb(NEW) - 'payment_link_token_sealed') = (to_jsonb(OLD) - 'payment_link_token_sealed')
      AND (to_jsonb(NEW) -> 'payment_link_token_sealed') IS DISTINCT FROM (to_jsonb(OLD) -> 'payment_link_token_sealed')
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'POS-04: % row of final order % cannot be changed or deleted', TG_TABLE_NAME, OLD.order_id
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- Migration 0720 (legend-4vfmn): the sealed-secret reseal job may rewrite
-- code_sealed (and only that column) through app.reseal_frozen_sealed, which
-- runs as the table owner (sealed-reseal-frozen.custom.sql). legend_app keeps no
-- UPDATE/DELETE. This guard makes the owner path unable to touch any other
-- column; it only fires for a role that can UPDATE the table (the owner).
-- DELETE stays refused by the REVOKE above.
CREATE OR REPLACE FUNCTION app.apology_vouchers_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF current_setting('app.sealed_reseal_column', true) = 'apology_vouchers.code_sealed'
    AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid = 'app.reseal_frozen_sealed(text,text,uuid,uuid,text,text)'::pg_catalog.regprocedure
        AND p.proowner = (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)
    )
    AND (to_jsonb(NEW) - 'code_sealed') = (to_jsonb(OLD) - 'code_sealed')
    AND NEW.code_sealed IS DISTINCT FROM OLD.code_sealed
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'apology_vouchers % is append-only; only the sealed-secret reseal may rewrite code_sealed', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER "apology_vouchers_guard_trg"
  BEFORE UPDATE ON "apology_vouchers"
  FOR EACH ROW EXECUTE FUNCTION app.apology_vouchers_guard();
