-- Custom SQL migration file, put your code below! ---
-- Floor + table-session tables are tenant-owned (PRD §7 WS-03); RLS is applied
-- with the shared helper so tenant_id is enforced by the database as well.
SELECT app.enforce_tenant_rls('public.floor_zones'::regclass);
SELECT app.enforce_tenant_rls('public.tables'::regclass);
SELECT app.enforce_tenant_rls('public.table_sessions'::regclass);
SELECT app.enforce_tenant_rls('public.session_participants'::regclass);
