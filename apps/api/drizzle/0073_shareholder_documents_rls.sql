-- Tenant RLS + invariants for the shareholder document tables (legend-69yq).
-- A document moves from draft to published exactly once. After that it is
-- immutable for every role: no UPDATE (visibility, file, entity, kind, title,
-- published_*) and no DELETE. A draft may still change and be deleted.
SELECT app.enforce_tenant_rls('public.shareholder_document_files'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.shareholder_documents'::regclass);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reject_published_shareholder_document_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'a published shareholder document is immutable'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS shareholder_documents_published_immutable ON public.shareholder_documents;
--> statement-breakpoint
CREATE TRIGGER shareholder_documents_published_immutable
  BEFORE UPDATE OR DELETE ON public.shareholder_documents
  FOR EACH ROW EXECUTE FUNCTION app.reject_published_shareholder_document_mutation();
