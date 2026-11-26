-- O1 (bead legend-wasr7.5, docs/design/cloud-only-release.md §2): offline
-- kits and the per-device offline receipt series. New table pos_offline_kits
-- (append-only, tenant + outlet RLS); receipt_sequences.series gains
-- 'offline' with the `L<n>` prefix reserved for it (cloud-issued, never
-- edge-bound) and the retire reason 'offline_epoch'. No existing order,
-- shift or receipt number changes. Temporary number 0533 (CTO 27 Nov),
-- renumbered at merge. Foreign keys are inline in CREATE TABLE (contracts.md
-- legend-m007 pattern 1: no validation scan under FORCE RLS).
--
-- The migrator may be a plain table owner (contracts.md "Migrations: foreign
-- keys into FORCE RLS tables", pattern 2): the new CHECKs on
-- receipt_sequences scan its rows, so FORCE is lifted and restored below.
ALTER TABLE public.receipt_sequences NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Preflight: `L<digits>` is reserved for the offline series. A run already
-- printing under such a prefix cannot be reclassified (its numbers are on
-- paper), so the migration stops for a manual decision.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.receipt_sequences WHERE prefix ~ '^L[0-9]+$') THEN
    RAISE EXCEPTION 'O1 preflight: a receipt sequence already uses a reserved L<number> prefix; resolve it before migrating'
      USING ERRCODE = '23514';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "pos_offline_kits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"sequence_id" uuid NOT NULL,
	"issued_by" text NOT NULL,
	"catalog_version" varchar(64) NOT NULL,
	"snapshot" jsonb NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_offline_kits_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pos_offline_kits_catalog_version_check" CHECK ("pos_offline_kits"."catalog_version" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pos_offline_kits_expiry_check" CHECK ("pos_offline_kits"."expires_at" > "pos_offline_kits"."issued_at"),
	CONSTRAINT "pos_offline_kits_snapshot_check" CHECK (jsonb_typeof("pos_offline_kits"."snapshot") = 'object'),
	CONSTRAINT "pos_offline_kits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_offline_kits_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_offline_kits_issued_by_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_offline_kits_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_offline_kits_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."pos_shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_offline_kits_sequence_fk" FOREIGN KEY ("tenant_id","sequence_id") REFERENCES "public"."receipt_sequences"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "pos_offline_kits_sequence_idx" ON "pos_offline_kits" USING btree ("tenant_id","sequence_id","issued_at");
--> statement-breakpoint
ALTER TABLE "receipt_sequences" DROP CONSTRAINT "receipt_sequences_series_check";
--> statement-breakpoint
ALTER TABLE "receipt_sequences" DROP CONSTRAINT "receipt_sequences_retired_reason_check";
--> statement-breakpoint
ALTER TABLE "receipt_sequences" ADD CONSTRAINT "receipt_sequences_offline_prefix_check" CHECK (("receipt_sequences"."series" = 'offline') = ("receipt_sequences"."prefix" ~ '^L[0-9]{1,6}$'));
--> statement-breakpoint
ALTER TABLE "receipt_sequences" ADD CONSTRAINT "receipt_sequences_offline_cloud_check" CHECK ("receipt_sequences"."series" <> 'offline' OR "receipt_sequences"."edge_node_id" IS NULL);
--> statement-breakpoint
ALTER TABLE "receipt_sequences" ADD CONSTRAINT "receipt_sequences_series_check" CHECK ("receipt_sequences"."series" IN ('device', 'cloud', 'failover', 'offline'));
--> statement-breakpoint
ALTER TABLE "receipt_sequences" ADD CONSTRAINT "receipt_sequences_retired_reason_check" CHECK ("receipt_sequences"."retired_reason" IS NULL OR ("receipt_sequences"."retired_at" IS NOT NULL AND "receipt_sequences"."retired_reason" IN ('claim_rotated','cloud_takeover','edge_replaced','edge_regressed','offline_epoch')));
--> statement-breakpoint
ALTER TABLE public.receipt_sequences FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- O1 offline kits (0533). Tenant RLS (TEN-01/02) plus the outlet backstop
-- (TEN-03), like the other POS tables.
SELECT app.enforce_tenant_rls('public.pos_offline_kits'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_offline_kits'::regclass);
--> statement-breakpoint
-- A kit is what the cloud promised the tablet (prices, epoch): once issued it
-- never changes and is never deleted.
CREATE FUNCTION app.guard_pos_offline_kit() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'POS-06: offline kit % is append-only', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER pos_offline_kits_guard BEFORE UPDATE OR DELETE ON public.pos_offline_kits
FOR EACH ROW EXECUTE FUNCTION app.guard_pos_offline_kit();
