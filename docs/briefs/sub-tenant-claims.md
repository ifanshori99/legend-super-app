# Sub-brief: tenant claims (legend-mbd2, legend-t57t)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/tenant-claims` (branch `ws/tenant-claims`). Work only here. Do not commit, push, or edit files owned by the other section. Do not touch Better Auth core, support sessions, UI (`apps/web`), migrations, or the drizzle schema files (already done by the engineer).

## Already done (do not redo)

- Migration `apps/api/drizzle/0178_tenant_claims.sql` (+ `meta/0178_snapshot.json`, journal). Source of its hand SQL: `apps/api/src/db/schema/platform-integrations.custom.sql`.
- `tenant_integrations`: two partial unique indexes, only for `provider='whatsapp' AND status='active' AND outlet_id IS NULL`:
  - `tenant_integrations_whatsapp_number_key` on `app.whatsapp_receiving_number(config)` (normalized like `normalizeWhatsAppNumber`, so `0812-3456-7890`, `+62 812 3456 7890`, `6281234567890` collide).
  - `tenant_integrations_whatsapp_routing_key` on `app.whatsapp_routing_key(config)` = `phoneNumberId` (trimmed) else normalized receiving number.
  - SQL functions `app.normalize_wa_number(text)`, `app.whatsapp_config_text(jsonb,text)`, `app.whatsapp_receiving_number(jsonb)`, `app.whatsapp_routing_key(jsonb)`.
  - Migration `DO $$` block raises `23505` naming integration ids when existing active rows of different tenants already share a number.
- `tenant_domains`: global `tenant_domains_hostname_unique` dropped. New: `tenant_domains_verified_hostname_key` (unique hostname WHERE verified_at IS NOT NULL), `tenant_domains_tenant_hostname_key` (unique tenant_id+hostname), `tenant_domains_hostname_idx`. New column `verification_token varchar(64)` (backfilled for unverified custom rows). Drizzle field `verificationToken`.
- `packages/shared/src/platform/errors.ts`: new codes `WHATSAPP_NUMBER_TAKEN` 409, `DOMAIN_RESERVED` 422, `DOMAIN_VERIFICATION_FAILED` 422. `DOMAIN_TAKEN` 409 kept.

## Section A — legend-mbd2 (WhatsApp number)

Files you own: `apps/api/src/services/platform-integration.service.ts`, new test `apps/api/src/test/whatsapp-number-claim.test.ts` (you may also add cases to `apps/api/src/test/platform-integrations-api.test.ts`).

1. In `upsertIntegration` (insert and update paths, and any other write that can set whatsapp status `active` or change its config, e.g. a status-change function): catch Postgres unique violation (`code 23505`, may be nested in `.cause`, see `uniqueViolation` in `org.service.ts:88`) whose `constraint` is `tenant_integrations_whatsapp_number_key` or `tenant_integrations_whatsapp_routing_key` and throw `new PlatformError("WHATSAPP_NUMBER_TAKEN")`. Other unique violations keep their current behavior. Note the insert uses `onConflictDoNothing()`: that swallows our new index too (no target) — give it an explicit target (the tenant/outlet provider key) or otherwise make sure a clash on the WhatsApp index is not mistaken for "a concurrent PUT created the row".
2. Tests (supertest via `src/test/helpers.ts`, same setup as `platform-integrations-api.test.ts`). Write them first and see them fail before item 1:
   - Tenant B activating A's active number in another format (`0812-...` vs `+62 812 ...`) → 409 `WHATSAPP_NUMBER_TAKEN`.
   - Same `phoneNumberId` with different receiving numbers → 409.
   - B's draft with A's number is allowed; activating it → 409. A disabled row does not block.
   - A re-saving its own config (same number) → OK.
   - Concurrency: A and B activate the same number at the same time (`Promise.all`) → exactly one success, the other 409 `WHATSAPP_NUMBER_TAKEN`.
   - Parity: for a table of inputs (`"0812-3456-7890"`, `"+62 812 3456 7890"`, `" 6281234567890 "`, `"(021) 555-1234"`, `"abc"`, `"0"`, `""`, a 16-digit string, a JSON number), `SELECT app.normalize_wa_number($1)` equals `normalizeWhatsAppNumber` from `@starter/shared` (identity login-code), and `app.whatsapp_routing_key(config)` matches the routing number logic of `resolveWhatsAppChannel`.
   - Migration guard: in a transaction on the owner pool, drop the two WhatsApp indexes, insert two active rows of different tenants with the same number, run the `DO $$ ... $$` block text extracted from `platform-integrations.custom.sql`, expect error code `23505` and message containing `legend-mbd2`; rollback.

## Section B — legend-t57t (custom domains)

Files you own: `packages/shared/src/platform/domains.ts`, `packages/shared/src/platform/endpoints.ts` (domain entries only), `apps/api/src/config/env.ts` (+ `.env.example` comment), `apps/api/src/services/org.service.ts` (domain functions only), `apps/api/src/services/org-resolve.service.ts`, `apps/api/src/routes/org.routes.ts` (domain routes only), tests `apps/api/src/test/platform-org-api.test.ts` (domain block) or a new `apps/api/src/test/tenant-domain-claim.test.ts`, `tests/platform-contract.test.mjs` if its resolveHost cases need updating.

1. Shared contract (`domains.ts`):
   - `resolveHost`: among rows matching the host, prefer a verified row (verified first; then unverified only to report `unverified`). Several unverified claims from different tenants must not make a verified owner fail.
   - `isReservedHostname(hostname, platformDomains: readonly string[])`: true when hostname equals or ends with `.` + a platform domain (normalized).
   - `domainVerificationRecord(hostname, token)` → `{ type: "TXT", name: "_legend-verification.<hostname>", value: "legend-domain-verification=<token>" }`.
   - `tenantDomainSchema` gets `verification: z.strictObject({ type: z.literal("TXT"), name: z.string(), value: z.string() }).nullable()` — the record to publish while unverified, null once verified. Update the doc comment that says hostname is unique platform-wide.
2. Env: optional `PLATFORM_DOMAIN` (hostname, validated with `normalizeHostname`). Reserved list = `PLATFORM_DOMAIN` plus `COOKIE_DOMAIN` without leading dot, whichever are set. Document in `.env.example`.
3. `addDomain`: reject reserved hostnames with `PlatformError("DOMAIN_RESERVED")`; mint `randomBytes(32).toString("hex")` token; unique violation on `tenant_domains_tenant_hostname_key` → `DOMAIN_TAKEN` (same tenant added it twice). Another tenant's unverified or verified row no longer blocks adding.
4. New `verifyDomain(context, domainId)` + route `POST /domains/:domainId/verify` (same guards as `POST /domains`; add endpoint to `endpoints.ts`). Own row only (404 otherwise). Already verified → return it. Look up TXT at the record name through an injectable resolver (module-level default `dns/promises.resolveTxt`, exported setter for tests, like the `DoitLookup` seam in `payment-doit.ts`); join each record's chunks; match exact value → set `verified_at = now()`, clear nothing else; unique violation on `tenant_domains_verified_hostname_key` → `DOMAIN_TAKEN`. No match, `ENODATA`/`ENOTFOUND`/`ESERVFAIL`/timeout → `DOMAIN_VERIFICATION_FAILED`. Add an audit entry if domain writes are audited today.
5. `toDomain` / `resolveHostname` mapping: fill `verification` from the row (null when verified or no token).
6. Tests (write first, see fail):
   - Tenant B adds A's unverified hostname → allowed (201); A then verifies with correct TXT → verified, and the host resolves to A even though B's unverified row exists.
   - After A is verified, B verifying the same host (TXT for B's token present) → 409 `DOMAIN_TAKEN`.
   - Hostname under `PLATFORM_DOMAIN` (and the platform domain itself) → 422 `DOMAIN_RESERVED`.
   - Verify with wrong TXT value / no record / resolver throws → 422 `DOMAIN_VERIFICATION_FAILED`, row stays unverified, host does not resolve.
   - Same tenant adding the same host twice → 409 `DOMAIN_TAKEN`.
   - Pure `resolveHost` unit cases: verified preferred over unverified rows of other tenants.

## Done for each section

`bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/<your files>" pnpm test'` green; report file count and test count. `pnpm exec eslint <changed files>` and `pnpm exec prettier --check <changed files>` clean. No typecheck (engineer runs it once). Report: changed files, commands + results, anything you could not do.

## Section A2 — review fix (architect, High)

Bug: SQL `[[:space:]]` (custom.sql + 0178) misses whitespace JS `\s`/`trim()` strips (U+00A0, U+FEFF, U+1680, U+2007, U+202F...). Tenant B saves `"﻿6281234567890"` or `"0812 3456 7890"` or `phoneNumberId: "﻿<A's id>"`, activates: SQL key NULL/different so index misses, but JS `resolveWhatsAppChannel` routes it to A's number.

Fix (files: `platform-integration.service.ts`, `platform-integrations.custom.sql`, `apps/api/drizzle/0178_tenant_claims.sql` (same text, keep both identical), `whatsapp-number-claim.test.ts`):
1. Write-side canonical form when `provider === "whatsapp"` (upsert insert + update): `receivingNumber` present → store `normalizeWhatsAppNumber(value)`; null result → 422 validation error (use the same error style the service already uses for bad input). `phoneNumberId` present → JS-trim, require `^[A-Za-z0-9._-]{1,64}$` else 422; store trimmed. Numbers (JSON number) → `String(value)` then same rule.
2. SQL backstop: replace `[[:space:]` classes with an explicit JS-`\s` set via ARE escapes: `[\t\n\v\f\r    -     　﻿]` (in normalize_wa_number keep `\-().` too; in whatsapp_config_text use it for both ends). Do not touch other migration parts.
3. Tests first (see fail): parity cases add `"﻿6281234567890"`, `"0812 3456 7890"`, `" 6281234567890"`; HTTP: B activating those vs A → 409 or 422 (never 200); stored config is canonical digits.
