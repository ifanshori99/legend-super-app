# Backend platform tenant implementation plan

Goal: complete legend-co93l and legend-utnll against approved UI U5a, without changing apps/web.

Spec: coordinator brief `559-backend-platform-tenant.md` (main checkout); Owner panel on `origin/ui/backoffice-platform`.

Architecture: add two focused platform read routers/services using the existing active `platform_admins` registry and session MFA gates. Mint RLS tenant context exclusively from the validated target path. Retain existing Owner write authority and add a fail-closed check for active target-tenant read-only support grants. The registry is the current explicit platform authority; tenant role permissions and support grants do not confer that authority.

Tech stack: Express, Drizzle/PostgreSQL, shared Zod contracts, Vitest HTTP integration tests.

## Constraints and decisions

- Only API, shared contracts, focused backend tests, and progress documentation change.
- No UI, money, payroll, accounting, CRM, inventory, HRIS, operations, or cashier changes.
- No global account directory: search only active accounts with active membership in the target tenant; bounded result count, safe fields, masked email, audit, and rate limit.
- Existing registry gates reject support grants as a source of platform authority; an active target-tenant read-only support grant additionally prevents assign/replace by that actor until ended/expired. No new platform role architecture or permission migration is introduced.
- Owner detail returns active tenant-scope Owner assignments, including assignmentId; ended, future, foreign tenant, and non-tenant assignments are excluded.
- Platform child-resource reads use explicit tenantId, field allowlists, and audit within the tenant transaction. Sensitive legal-entity address and bank references are omitted through existing nullable/empty DTO fields; NPWP uses its existing masked representation.
- Migrations reserved 0397–0399 only if needed; expected schema delta is empty.
- Root alone edits route registration and shared endpoint/index integration. Test-writer alone edits tests. Production edits start only after genuine failing HTTP assertions.

## Task 1: legend-co93l Owner reads and account search

Files: new `platform-tenant-directory.routes.ts`, `platform-tenant-directory.service.ts`, shared `platform/tenant-directory.ts`; existing platform detail handler and shared endpoints/index.

Interfaces: GET `/api/platform/tenants/:tenantId/owners`, GET `/api/platform/tenants/:tenantId/accounts`, and detail GET with `owners` array. New directory module exports Owner/account summary schemas, bounded search query, and platform tenant detail schema. Service exports listTenantOwnersAny, searchTenantAccountsAny, getPlatformTenantDetailAny.

Test-writer writes `src/test/platform-tenant-owner-api.test.ts`, runs through `LEGEND_TEST_FILES` and `heavy`, and reports missing-feature failures. Implementer adds production code after root confirms red. Root integrates exports, reruns focused tests including existing Owner write tests, verifies API/shared types and changed-file lint/format, then commits this card locally.

## Task 2: legend-utnll Explicit tenant resources

Files: new `platform-tenant-resources.routes.ts` and `.service.ts`; shared endpoint entries and route registration integrated by root.

Interfaces: GET `/api/platform/tenants/:tenantId/brands`, `/outlets`, `/legal-entities`; use existing resource schemas, cursor outlet pagination, optional brandId validated within target tenant.

Test-writer writes `src/test/platform-tenant-resources-api.test.ts` and reports genuine missing-feature red. Implementer adds minimal production queries, tenant checks, minimization, and audit. Root integrates exports, reruns focused HTTP tests, verifies shared/API types and changed-file lint/format, then commits this card locally.

## Review focus

- Ordinary tenant users and revoked platform users cannot access any target tenant through these paths.
- Read-only support and impersonated sessions cannot use Owner writes or new directory endpoints.
- Account queries cannot expose foreign members, private credentials, banned accounts, or unbounded directory contents; wildcard input does not widen results.
- Future/ended Owner assignments and foreign brand filters cannot leak membership/resource data.
- Successful Owner/detail/search/resource reads write audit entries without raw query text or account PII; audit failure prevents data response.

## Final proof

One fresh architect review of combined access/privacy diff using team review checklist, while one test-runner holds sole heavy token. Run focused relevant tests, sequential shared/API typechecks, changed-file ESLint and Prettier checks after final edits, and empty `db:generate`. Full merge-train gate and UI/e2e are outside this backend slice. Record commands, evidence, subagent counts, remaining limits in `docs/PROGRESS.md`; do not merge or push.
