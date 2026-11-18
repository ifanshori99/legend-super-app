-- Custom SQL migration file, put your code below! ---
-- HRIS SOP library, training and announcements (bead legend-7df1; PRD v1.7
-- §3 F32): tenant RLS on every table (TEN-01/02). Only
-- `hris_announcement_outlets` carries a NOT NULL `outlet_id`, so only it also
-- gets outlet RLS; the library tables are tenant master data and the outlet
-- reach is enforced in services/hris-*.ts (like `employees`).
SELECT app.enforce_tenant_rls('public.sop_documents'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.sop_document_media'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.sop_acknowledgements'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.trainings'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.training_questions'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.training_enrollments'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.training_completions'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.training_certificates'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.announcements'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.hris_announcement_outlets'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.hris_announcement_outlets'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.announcement_receipts'::regclass);
--> statement-breakpoint
-- SOP versions, acknowledgements and quiz attempts are append-only for the
-- application role: a change is a new version / attempt row, never an edit.
REVOKE UPDATE, DELETE ON TABLE public.sop_documents FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE public.sop_document_media FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE public.sop_acknowledgements FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE public.training_completions FROM legend_app;
--> statement-breakpoint
-- An SOP version is immutable for every role (owner included). UPDATE only:
-- tenant teardown in tests deletes rows through cascades, so DELETE stays open.
CREATE FUNCTION app.sop_documents_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'SOP_VERSION_IMMUTABLE' USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER "sop_documents_immutable_trg"
  BEFORE UPDATE ON "sop_documents"
  FOR EACH ROW EXECUTE FUNCTION app.sop_documents_immutable();
--> statement-breakpoint
-- A certificate and the answer key of a quiz are never edited or removed by the
-- application role: a re-sit is a new attempt, a changed quiz is a new training.
REVOKE UPDATE, DELETE ON TABLE public.training_certificates FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE public.training_questions FROM legend_app;
