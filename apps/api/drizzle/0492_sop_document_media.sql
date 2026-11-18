-- 1087 (legend-m7yeb, group T): SOP media get their own source kind
-- ('sop_document', purpose document) and a table that binds each SOP version
-- to its media objects. Replaces the owner-based rule of 1086. Nothing is
-- backfilled and no existing row is edited: SOP versions published before this
-- file keep reading sop_documents.media_ids, and their legacy media (no source
-- kind) stay readable by the same strict document managers as before.
-- Foreign keys are inline (docs/plan/contracts.md "Migrations: foreign keys
-- into FORCE RLS tables", pattern 1); RLS and the append-only grant as in
-- src/db/schema/hris-sop.custom.sql.
-- core_storage_objects is written by every upload: wait at most 5s for the
-- ACCESS EXCLUSIVE lock of the check swap, then restore the migrator's value
-- (contracts.md, bead legend-76azz).
SELECT set_config('legend.lock_timeout_before_0702', current_setting('lock_timeout'), true);--> statement-breakpoint
SELECT set_config('lock_timeout', '5s', true);--> statement-breakpoint
CREATE TABLE "sop_document_media" (
	"tenant_id" uuid NOT NULL,
	"sop_document_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"legacy" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sop_document_media_pk" PRIMARY KEY("tenant_id","sop_document_id","media_id"),
	CONSTRAINT "sop_document_media_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "sop_document_media_document_fk" FOREIGN KEY ("tenant_id","sop_document_id") REFERENCES "public"."sop_documents"("tenant_id","id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "sop_document_media_object_fk" FOREIGN KEY ("tenant_id","media_id") REFERENCES "public"."core_storage_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "sop_document_media_sort_check" CHECK ("sop_document_media"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE INDEX "sop_document_media_tenant_media_idx" ON "sop_document_media" USING btree ("tenant_id","media_id");--> statement-breakpoint
ALTER TABLE "core_storage_objects" DROP CONSTRAINT "core_storage_objects_source_kind_check";--> statement-breakpoint
ALTER TABLE "core_storage_objects" ADD CONSTRAINT "core_storage_objects_source_kind_check" CHECK ("core_storage_objects"."source_kind" IS NULL OR "core_storage_objects"."source_kind" IN ('purchase_invoice', 'goods_receipt', 'expense', 'cash_deposit', 'reimbursement', 'attendance', 'employee_document', 'employment_contract', 'leave_request', 'menu_item', 'petty_purchase', 'waste_log', 'cleaning_task', 'maintenance_ticket', 'checklist_evidence', 'sop_document')) NOT VALID;--> statement-breakpoint
ALTER TABLE "core_storage_objects" VALIDATE CONSTRAINT "core_storage_objects_source_kind_check";
--> statement-breakpoint
-- Custom SQL (mirrors src/db/schema/hris-sop.custom.sql): tenant RLS (no
-- outlet_id column, so no outlet RLS) and an append-only table for the
-- application role: a media change is a new version row, never an edit.
SELECT app.enforce_tenant_rls('public.sop_document_media'::regclass);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE public.sop_document_media FROM legend_app;
--> statement-breakpoint
SELECT set_config('lock_timeout', COALESCE(NULLIF(current_setting('legend.lock_timeout_before_0702', true), ''), current_setting('lock_timeout')), true);
