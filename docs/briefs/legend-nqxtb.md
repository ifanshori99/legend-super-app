# Brief legend-nqxtb: Kirimdev sender mapping, platform-written only

Tier K (access + migration). Branch `fix/kirimdev-sender-mapping` (base 7f631e6f). Worktree root = repo root of this checkout.

## Problem

`apps/api/src/services/messaging-kirimdev.ts` `kirimdevSenderFromIntegrations` trusts
`tenant_integrations.config.phoneNumberId`, which a tenant admin writes. One platform `KIRIM_API_KEY`
can send from every number in the Kirimdev org, so tenant A can claim tenant B's number.

## Contract (fixed; do not redesign)

### Table `kirimdev_sender_mappings` (Drizzle export `kirimdevSenderMappings`, file `apps/api/src/db/schema/kirimdev-sender-mappings.ts`, exported from `schema/index.ts`)

- `id` uuid PK (tenants/outlets use uuid; enforce_tenant_rls needs uuid tenant_id).
- `tenant_id` not null FK tenants. `outlet_id` nullable FK outlets (null = tenant-wide sender). Outlet must belong to the tenant (composite FK if `outlets` has a (tenant_id,id) unique key, else service check).
- `phone_number_id` text not null, CHECK `^[A-Za-z0-9_-]{1,64}$`.
- `created_by_user_id`, `updated_by_user_id` text, `created_at`, `updated_at` timestamptz.
- Unique `phone_number_id` across ALL tenants. Unique `(tenant_id)` where outlet_id IS NULL; unique `(tenant_id, outlet_id)` where outlet_id IS NOT NULL.
- RLS: follow the existing platform-owned table pattern (see `apps/api/src/db/schema/platform-integrations.custom.sql`, `platform-payment-gateways.ts`, migration 0211). Writes only from platform context; tenant-context reads see only own tenant row (resolver runs under `withTenant`).

### Migration numbering

Range 0470-0471 only. Generate with `pnpm db:generate` then rename to 0470_<name> (and 0471 if a custom SQL migration is needed) following commit 92defe69 (journal `idx` 470, `tag` 0470_..., `meta/0470_snapshot.json`). After: `pnpm db:generate` must produce nothing.

### Shared

`packages/shared/src/validators/kirimdev-sender.ts` (strict zod): upsert body `{ tenantId, outletId: string|null, phoneNumberId }`, list query `{ tenantId? }`, id param. DTO `KirimdevSenderMappingDto` in `packages/shared/src/types/api.ts` (ISO dates). Add subpath to `packages/shared/package.json` exports.

### Service `apps/api/src/services/kirimdev-sender-mapping.service.ts`

- `listKirimdevSenderMappingsAny`, `upsertKirimdevSenderMappingAny`, `deleteKirimdevSenderMappingAny` (actor user id arg). Each mutation writes a platform audit event in the same transaction (follow the audit pattern used by platform-integrations / platform-payment-gateways services).
- Duplicate phone_number_id on another tenant/outlet: `HttpError` 409 code `SENDER_ALREADY_MAPPED`; message must NOT contain the number.
- Unknown tenant / outlet not in tenant: 404/422 per repo convention.

### Route `apps/api/src/routes/platform-kirimdev-senders.routes.ts`, mounted at `/api/platform`, registered in `routes/index.ts`

Guards exactly like `platformUsageRouter` in `platform-integrations.routes.ts`: `requirePlatformAuth, requireTrustedOrigin, requirePlatformAdmin, requireSessionMfa()`; `jsonBody` on PUT.

- `GET /messaging/kirimdev-senders?tenantId=` list (tenantId required)
- `PUT /messaging/kirimdev-senders` upsert (by tenant+outlet)
- `DELETE /messaging/kirimdev-senders/:id?tenantId=` (tenantId required; id of another tenant -> 404)
  No tenant-facing endpoint exposes numbers.

### Resolver (in `messaging-kirimdev.ts`)

- Replace `kirimdevSenderFromIntegrations` with `kirimdevSenderFromPlatformMapping(database)`.
- Change `resolveSender` signature to `(context, { outletId: string | null }) => Promise<string|null>`; `send()` passes the accepted message's outletId.
- Lookup: outlet mapping first (when outletId set), else tenant-wide mapping (outlet_id null). Tenant must be `active`. `tenant_integrations.config.phoneNumberId` is ignored entirely.
- None found: return null -> existing `no_sender` KirimdevSendError, no HTTP call (fail closed). Error text never contains number or token.
- Adapter stays without production callers (do not wire it up).

## Ownership (no overlapping files)

- implementer-schema: schema file, schema/index.ts, drizzle/0470*/0471*, drizzle/meta.
- implementer-api: shared validator/DTO/exports, service, route, routes/index.ts, messaging-kirimdev.ts.
- test-writer: `apps/api/src/test/kirimdev-sender-mapping.test.ts` (new) and resolver tests in `apps/api/src/test/messaging-kirimdev.test.ts`. Implementers do not edit tests.

## Tests required (fail-first)

1. Tenant A cannot claim B's number: platform PUT for A with B's phone_number_id -> 409, B's mapping unchanged; and A setting `tenant_integrations.config.phoneNumberId` = B's number does not make the resolver return it.
2. No mapping -> resolver null, `send` throws `no_sender`, fetch never called.
3. Non-platform-admin (tenant admin) -> 403 on GET/PUT/DELETE.
4. Platform admin without session MFA -> rejected (same status the other platform routes give).
5. Tenant context cannot read another tenant's mapping row (RLS, via withTenant).
6. Audit row written on upsert and delete.

## Rules

Heavy commands only via `heavy` (`heavy env LEGEND_TEST_FILES="src/test/x.test.ts" pnpm test`). Do not run tsc or tests unless your brief section says so; engineer's test-runner holds the heavy token. Never call real Kirimdev. No pkill.

## Decisions during build

- Tenant RLS via `app.enforce_tenant_rls`; platform writes run in `withTenant(platformTenantScope(tenantId))`.
- DB write guard (architect finding 1): trigger rejects INSERT/UPDATE/DELETE unless `app.kirimdev_sender_write = 'on'` in the transaction; only the platform service sets it.
- Audit `platform.kirimdev_sender.upserted|deleted`; phoneNumberId stays masked (no SAFE_FIELDS entry).
