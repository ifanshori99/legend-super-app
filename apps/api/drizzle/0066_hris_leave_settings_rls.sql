-- Leave settings (founder decision Q7 "cuti bersama"): tenant RLS (TEN-01/02).
-- The row is tenant-wide policy with no outlet, so no outlet backstop.
SELECT app.enforce_tenant_rls('public.hris_leave_settings'::regclass);
