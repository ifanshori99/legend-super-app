ALTER TABLE "core_storage_objects" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "core_storage_objects" ADD COLUMN "source_kind" varchar(32);--> statement-breakpoint
ALTER TABLE "core_storage_objects" ADD COLUMN "source_id" uuid;--> statement-breakpoint
CREATE INDEX "core_storage_objects_source_idx" ON "core_storage_objects" USING btree ("tenant_id","source_kind","source_id");--> statement-breakpoint
ALTER TABLE "core_storage_objects" ADD CONSTRAINT "core_storage_objects_source_kind_check" CHECK ("core_storage_objects"."source_kind" IS NULL OR "core_storage_objects"."source_kind" IN ('purchase_invoice', 'goods_receipt', 'expense', 'cash_deposit', 'reimbursement', 'attendance', 'employee_document', 'employment_contract', 'leave_request', 'menu_item'));--> statement-breakpoint
ALTER TABLE "core_storage_objects" ADD CONSTRAINT "core_storage_objects_source_check" CHECK ("core_storage_objects"."source_id" IS NULL OR "core_storage_objects"."source_kind" IS NOT NULL);--> statement-breakpoint
-- Backfill legacy links (legend-pszrm). The migrator may be a plain table owner
-- (no SUPERUSER, no BYPASSRLS), and FORCE ROW LEVEL SECURITY would apply the
-- tenant policies to it with no app.tenant_id set. Lift FORCE for this
-- transaction only and restore it right after (same pattern as 0171).
ALTER TABLE public.core_storage_objects NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.employment_contracts NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.employee_documents NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.leave_requests NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.employees NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Each statement fills only objects with no source yet, one source row per
-- object (earliest first, then id). Owner becomes the employee's login account
-- when there is one, else the stored owner stays.
UPDATE core_storage_objects o
SET source_kind = 'employment_contract',
    source_id = s.id,
    owner_user_id = COALESCE(s.user_id, o.owner_user_id)
FROM (
  SELECT DISTINCT ON (c.tenant_id, c.file_object_id)
    c.tenant_id, c.file_object_id, c.id, e.user_id
  FROM employment_contracts c
  JOIN employees e ON e.tenant_id = c.tenant_id AND e.id = c.employee_id
  WHERE c.file_object_id IS NOT NULL
  ORDER BY c.tenant_id, c.file_object_id, c.created_at, c.id
) s
WHERE o.tenant_id = s.tenant_id
  AND o.id = s.file_object_id
  AND o.purpose = 'document'
  AND o.source_id IS NULL;
--> statement-breakpoint
UPDATE core_storage_objects o
SET source_kind = 'employee_document',
    source_id = s.id,
    owner_user_id = COALESCE(s.user_id, o.owner_user_id)
FROM (
  SELECT DISTINCT ON (d.tenant_id, d.storage_object_id)
    d.tenant_id, d.storage_object_id, d.id, e.user_id
  FROM employee_documents d
  JOIN employees e ON e.tenant_id = d.tenant_id AND e.id = d.employee_id
  ORDER BY d.tenant_id, d.storage_object_id, d.uploaded_at, d.id
) s
WHERE o.tenant_id = s.tenant_id
  AND o.id = s.storage_object_id
  AND o.purpose = 'document'
  AND o.source_id IS NULL;
--> statement-breakpoint
UPDATE core_storage_objects o
SET source_kind = 'leave_request',
    source_id = s.id,
    owner_user_id = COALESCE(s.user_id, o.owner_user_id)
FROM (
  SELECT DISTINCT ON (l.tenant_id, o2.id)
    l.tenant_id, o2.id AS object_id, l.id, e.user_id
  FROM leave_requests l
  JOIN employees e ON e.tenant_id = l.tenant_id AND e.id = l.employee_id
  JOIN core_storage_objects o2
    ON o2.tenant_id = l.tenant_id
   AND o2.id::text = lower(l.attachment_key)
   AND o2.purpose = 'document'
  WHERE l.attachment_key IS NOT NULL
  ORDER BY l.tenant_id, o2.id, l.requested_at, l.id
) s
WHERE o.tenant_id = s.tenant_id
  AND o.id = s.object_id
  AND o.source_id IS NULL;
--> statement-breakpoint
ALTER TABLE public.employees FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.leave_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.employee_documents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.employment_contracts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.core_storage_objects FORCE ROW LEVEL SECURITY;
