PRD v1.7: §3 F23; §6 G delivery_channel_orders; §4 Alur G
Scope: Adapter framework + fake; webhook endpoint /api/webhooks/delivery/[platform]; real adapters per platform once partner access exists.
Suggested owned paths: apps/api/src/db/schema/crm*.ts, apps/api/drizzle/<new migration>, apps/api/src/services/crm*.ts, apps/api/src/routes/crm*.routes.ts, apps/api/src/test/crm*.test.ts
Agent hint: codex
AC: Drizzle schema + new Legend migration (never copy 119connect migrations); every (T) table has tenant_id NOT NULL + enforced RLS policy, unique constraints include tenant_id, operational tables carry outlet_id; service-layer permission + outlet-scope checks; strict Zod validation at routes; vitest integration tests incl. cross-tenant isolation for new tables; pnpm check PASS.
