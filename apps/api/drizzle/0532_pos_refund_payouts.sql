-- 1269 E6 (legend-osqou.27): payouts of back-office refunds of edge sales.
-- Temporary number 0532 (0531 is the WFC sale hold); the merge train may
-- renumber. New table only: no existing row changes. Foreign keys are inline
-- in CREATE TABLE (contracts.md legend-m007 pattern 1, as 0530).
CREATE TABLE "pos_refund_payouts" (
	"tenant_id" uuid NOT NULL,
	"pos_refund_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"status" varchar(10) DEFAULT 'requested' NOT NULL,
	"cash_idr" bigint NOT NULL,
	"edc_idr" bigint NOT NULL,
	"cash_channel" varchar(20),
	"cash_reference" varchar(100),
	"cash_settled_by" text,
	"cash_settled_at" timestamp with time zone,
	"edc_rrn" varchar(24),
	"edc_approval_code" varchar(12),
	"edc_settled_by" text,
	"edc_settled_at" timestamp with time zone,
	"event_payload" jsonb NOT NULL,
	"requested_by" text NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_refund_payouts_tenant_id_pos_refund_id_pk" PRIMARY KEY("tenant_id","pos_refund_id"),
	CONSTRAINT "pos_refund_payouts_status_check" CHECK ("pos_refund_payouts"."status" IN ('requested', 'succeeded')),
	CONSTRAINT "pos_refund_payouts_amount_check" CHECK ("pos_refund_payouts"."cash_idr" >= 0 AND "pos_refund_payouts"."edc_idr" >= 0 AND "pos_refund_payouts"."cash_idr" + "pos_refund_payouts"."edc_idr" > 0),
	CONSTRAINT "pos_refund_payouts_cash_channel_check" CHECK ("pos_refund_payouts"."cash_channel" IS NULL OR "pos_refund_payouts"."cash_channel" IN ('bank_transfer', 'petty_cash')),
	CONSTRAINT "pos_refund_payouts_cash_part_check" CHECK (("pos_refund_payouts"."cash_reference" IS NOT NULL) = ("pos_refund_payouts"."cash_channel" IS NOT NULL)
        AND ("pos_refund_payouts"."cash_reference" IS NOT NULL) = ("pos_refund_payouts"."cash_settled_at" IS NOT NULL)
        AND ("pos_refund_payouts"."cash_reference" IS NOT NULL) = ("pos_refund_payouts"."cash_settled_by" IS NOT NULL)
        AND ("pos_refund_payouts"."cash_reference" IS NULL OR "pos_refund_payouts"."cash_idr" > 0)),
	CONSTRAINT "pos_refund_payouts_edc_part_check" CHECK (("pos_refund_payouts"."edc_rrn" IS NOT NULL) = ("pos_refund_payouts"."edc_approval_code" IS NOT NULL)
        AND ("pos_refund_payouts"."edc_rrn" IS NOT NULL) = ("pos_refund_payouts"."edc_settled_at" IS NOT NULL)
        AND ("pos_refund_payouts"."edc_rrn" IS NOT NULL) = ("pos_refund_payouts"."edc_settled_by" IS NOT NULL)
        AND ("pos_refund_payouts"."edc_rrn" IS NULL OR "pos_refund_payouts"."edc_idr" > 0)),
	CONSTRAINT "pos_refund_payouts_succeeded_check" CHECK (("pos_refund_payouts"."status" = 'succeeded') = ("pos_refund_payouts"."settled_at" IS NOT NULL)
        AND ("pos_refund_payouts"."status" = 'succeeded') = (
          ("pos_refund_payouts"."cash_idr" = 0 OR "pos_refund_payouts"."cash_reference" IS NOT NULL)
          AND ("pos_refund_payouts"."edc_idr" = 0 OR "pos_refund_payouts"."edc_rrn" IS NOT NULL))),
	CONSTRAINT "pos_refund_payouts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_refund_payouts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_refund_payouts_refund_fk" FOREIGN KEY ("tenant_id","pos_refund_id") REFERENCES "public"."pos_order_refunds"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "pos_refund_payouts_order_idx" ON "pos_refund_payouts" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "pos_refund_payouts_status_idx" ON "pos_refund_payouts" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_refund_payouts_edc_rrn_key" ON "pos_refund_payouts" USING btree ("tenant_id","edc_rrn") WHERE "pos_refund_payouts"."edc_rrn" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pos_refund_payouts_cash_reference_key" ON "pos_refund_payouts" USING btree ("tenant_id","cash_channel","cash_reference") WHERE "pos_refund_payouts"."cash_reference" IS NOT NULL;--> statement-breakpoint
-- Back-office refund payouts of edge sales (1269 E6). Tenant RLS (TEN-01/02)
-- plus the outlet backstop (TEN-03), like edge_edc_ingests.
SELECT app.enforce_tenant_rls('public.pos_refund_payouts'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_refund_payouts'::regclass);
--> statement-breakpoint
-- Money record: never deleted; what the refund pays and to whom never
-- changes; a recorded part is final and a succeeded row is final.
CREATE FUNCTION app.guard_pos_refund_payout() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pos refund payouts are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'succeeded'
     OR NEW.tenant_id <> OLD.tenant_id OR NEW.pos_refund_id <> OLD.pos_refund_id
     OR NEW.outlet_id <> OLD.outlet_id OR NEW.order_id <> OLD.order_id
     OR NEW.cash_idr <> OLD.cash_idr OR NEW.edc_idr <> OLD.edc_idr
     OR NEW.event_payload IS DISTINCT FROM OLD.event_payload
     OR NEW.requested_by <> OLD.requested_by OR NEW.created_at <> OLD.created_at
     OR (OLD.cash_reference IS NOT NULL AND (
           NEW.cash_reference IS DISTINCT FROM OLD.cash_reference
           OR NEW.cash_channel IS DISTINCT FROM OLD.cash_channel
           OR NEW.cash_settled_by IS DISTINCT FROM OLD.cash_settled_by
           OR NEW.cash_settled_at IS DISTINCT FROM OLD.cash_settled_at))
     OR (OLD.edc_rrn IS NOT NULL AND (
           NEW.edc_rrn IS DISTINCT FROM OLD.edc_rrn
           OR NEW.edc_approval_code IS DISTINCT FROM OLD.edc_approval_code
           OR NEW.edc_settled_by IS DISTINCT FROM OLD.edc_settled_by
           OR NEW.edc_settled_at IS DISTINCT FROM OLD.edc_settled_at)) THEN
    RAISE EXCEPTION 'a recorded pos refund payout is final' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER pos_refund_payouts_guard BEFORE UPDATE OR DELETE ON public.pos_refund_payouts
FOR EACH ROW EXECUTE FUNCTION app.guard_pos_refund_payout();
