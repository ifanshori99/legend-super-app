-- Custom SQL migration file, put your code below! ---
-- legend-x7u9: existing tenants were seeded before `ai.ask` and
-- `ai.action.propose` reached the role templates (packages/shared/src/access/
-- roles.ts ROLE_TEMPLATES, PRD v1.7 §3.7). Union the current template codes
-- into the seeded template rows; never remove a code and never touch a custom
-- role (is_template = false), so tenant edits survive (access.service.ts
-- seedTenantRoleTemplates only inserts missing templates). Idempotent.
-- Runs as the migration owner (superuser/BYPASSRLS), like earlier data
-- migrations, so it spans every tenant.
UPDATE public.roles
SET permissions = permissions || '["ai.ask"]'::jsonb
WHERE is_template
  AND template_key IN ('owner','shareholder','tenant_admin','general_manager','outlet_manager','supervisor','cashier','waiter','barista_cook','facility_attendant','kitchen_lead','purchasing','warehouse','finance','hr','marketing','employee')
  AND NOT permissions @> '["ai.ask"]'::jsonb;
--> statement-breakpoint
UPDATE public.roles
SET permissions = permissions || '["ai.action.propose"]'::jsonb
WHERE is_template
  AND template_key IN ('owner','general_manager','outlet_manager','supervisor','kitchen_lead','purchasing','warehouse','finance','hr','marketing')
  AND NOT permissions @> '["ai.action.propose"]'::jsonb;
