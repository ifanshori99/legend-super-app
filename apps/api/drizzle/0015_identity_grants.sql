-- Grants for the generated identity migration (0014; PRD v1.7 §6 B
-- mfa_factors, §3 F6 session policy).
--
-- mfa_factors is a global identity table like "user"/"session": the login and
-- step-up paths read it before a tenant context exists, so it has no RLS and
-- the 0001 grant function does not cover it. The application role needs DML.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mfa_factors TO legend_app;
