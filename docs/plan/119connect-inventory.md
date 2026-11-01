# 119connect inventory against Legend PRD v1.7 §7

Bead: `legend-bi3` · Inventory date: 2026-11-01 · Source: `../119connect-portal-alumni-main` (extracted tree, read only) · Target baseline: `legend` commit `ef5bc4c04c803b3802dce69bb3f2b4d7753252a7` · Requirements: PRD §3 WS-00, §7 and acceptance criteria cited below. All source paths are relative to the source root, unless labelled target.

## Method and limits

Three parallel source scans traced schema, routes, services, contracts, UI and tests. A byte comparison of every tracked target file at `ef5bc4c` against the source found **87 identical, 68 different, 22 absent from source**, out of 177 baseline files; the source also contains **1,480 paths absent from that baseline**, excluding `.git`, `node_modules`, `.turbo`, `dist` and `build`. The source has no `.git`, so this is a comparison to the target snapshot, not proof of source history or of every change since the original starter. Counts include documentation, snapshots, assets and configuration, not just product code. A source-only file is a candidate addition, not evidence it can be copied independently. Exact changed baseline paths are listed below; other named source paths are additions unless identified as changed baseline files. Directory and glob references below denote all files in that explicitly named source directory or matching pattern, not a recommendation to copy them wholesale.

Estimates are rough **engineer-days** for implementing and testing the stated adaptation, not elapsed time; they assume contracts are agreed and do not include the full scope of downstream workstreams, production deployment, or review. Shared dependencies and parallel work mean estimates should not simply be summed. Presence of tests is not proof they pass or cover every invariant. This is static analysis; source tests and actual production configuration were not run or inspected.

| §7 module                            | Inventory / recommendation                                 |   Estimate | Principal gap                                                                           |
| ------------------------------------ | ---------------------------------------------------------- | ---------: | --------------------------------------------------------------------------------------- |
| Tenant, resolution, flags, support   | Partial; copy + adapt                                      | 15–25 days | RLS deliberately disabled; brand/outlet/legal entity and universal gates missing        |
| WhatsApp reverse OTP and magic link  | Present; copy + adapt                                      | 15–25 days | Alumni coupling; replies enabled in source, contrary to AUTH-03                         |
| MFA, sessions, devices               | Partial; copy + adapt                                      | 10–20 days | MFA platform-centric; outlet PIN and supervisor override missing                        |
| Roles, permissions, time-bound roles | Present; copy machinery + rebuild policy                   | 15–25 days | Outlet/station scope and approval matrix missing                                        |
| Multichannel notifications           | Partial; copy + adapt                                      |   5–8 days | Delivery queue is not a proven transactional domain-event outbox; realtime/edge missing |
| Finance                              | Partial; reuse invariants + rebuild domain model           | 15–25 days | Alumni ledger, no approved reopen; close/post race needs design                         |
| AI gateway                           | Partial; copy + adapt gateway, rebuild shared tool catalog |  8–15 days | No shared MCP catalog; authorization delegated to callers                               |
| Audit log                            | Partial; reuse patterns + rebuild common contract          |   4–8 days | Fragmented domain-specific logs                                                         |
| Image pipeline                       | Present; copy + adapt                                      |   3–6 days | Membership/branding coupling and SVG security review                                    |

## Module detail

### Tenant, resolution, flags and support access

**Exists, partial.** API: `apps/api/src/lib/{tenant,tenant-resolusi,tenant-konteks,peran-tenant}.ts`, `apps/api/src/middleware/{tenant,bagian}.ts`, `apps/api/src/db/schema/{tenants,tenant-kolom,platform}.ts`, `apps/api/src/services/{platform.tenant,platform.support}.service.ts`, `apps/api/src/routes/{platform,platform-tenant}.routes.ts`. SQL: `apps/api/drizzle/{0006_platform_tenant,0011_isolasi_tenant,0012_rls_isolasi_tenant}.sql`. Shared: `packages/shared/src/validators/platform.ts`, and changed baseline `packages/shared/src/types/api.ts`. Web: `apps/web/src/lib/tenant.ts`, `apps/web/src/components/tema-tenant.tsx`, `apps/web/src/routes/_protected/platform/support-access.tsx` and `apps/web/src/routes/_protected/platform/tenant/`. Tests: `apps/api/src/test/{isolasi-tenant,tenant-resolusi,platform,skema-platform}.test.ts`.

Tenant flags are stored in JSONB; `bagian` gate is tied to alumni collaboration sections, not a proven universal gate. Support service includes expiry, read-only default, audit and tenant notification, with impersonation approval; verify every privilege path. **Critical:** `0012_rls_isolasi_tenant.sql` creates policies but ends by disabling RLS; the isolation test explicitly expects that state and separately tests conditional temporary enablement. Existing RLS cannot satisfy TEN-01/02 as shipped. Implement enforced tenant context, non-bypass application DB role, transaction-local settings, and independently tested policies; add brand → outlet and legal entity hierarchy, employee/device quotas, outlet scope and service checks, domain/token resolution, and consistent flag enforcement across UI/API/AI/MCP (PRD §3 item 4, TEN-01–10). Extract policy changes into new Legend migrations; do not replay mixed source migrations.

### WhatsApp reverse OTP and magic link

**Exists, coupled.** API: changed baseline `apps/api/src/lib/auth.ts`; additions `apps/api/src/lib/{masuk-wa.plugin,tautan-masuk,wa-adapter}.ts`, `apps/api/src/services/{masuk-wa,wa-masuk}.service.ts`, `apps/api/src/routes/wa-webhook.routes.ts`, `apps/api/src/db/schema/masuk.ts`; migrations `apps/api/drizzle/{0034_login_challenges,0043_sesi_idle_klaim_wa}.sql`. Shared: `packages/shared/src/masuk.ts`, `packages/shared/src/validators/masuk.ts` and changed `packages/shared/src/types/api.ts`. Web: changed `apps/web/src/routes/_auth/sign-in.tsx`, plus `_auth/masuk.tautan.tsx` and `apps/web/src/features/masuk/` including `components/{masuk-email,masuk-whatsapp}.tsx`. Tests: `apps/api/src/test/{masuk-wa,masuk-wa-klaim,wa-webhook}.test.ts`.

Webhook signature verification and challenge flow exist, but the flow is tied to alumni roster/membership. `masuk-wa.service.ts` sends replies on normal success/error paths, so change default to no WhatsApp replies, with opt-in and cost limits. Add per-tenant WhatsApp numbers, Google OAuth, identity graph/linking, registration and tenant-safe identity lookup. Verify entropy, five-minute lifetime, one-use/browser binding, signed/idempotent webhooks and rate limits against AUTH-01–04; do not infer compliance merely from a test name. Preserve magic-link security while removing domain coupling.

### MFA, sessions and device management

**Exists, partial.** Better Auth configuration in changed `apps/api/src/lib/auth.ts` includes TOTP and backup codes; additional API: `apps/api/src/middleware/mfa.ts`, `apps/api/src/routes/{platform-mfa,sesi,perangkat}.routes.ts`, `apps/api/src/services/{sesi-idle,perangkat}.service.ts`, changed schema `apps/api/src/db/schema/session.ts`; migrations `apps/api/drizzle/{0013_faktor_kedua_platform,0043_sesi_idle_klaim_wa}.sql`. Shared: `packages/shared/src/{masuk,validators/masuk,types/sesi}.ts`. Web: `apps/web/src/features/{keamanan,sesi,perangkat}/`, `apps/web/src/routes/_protected/_anggota/profil/perangkat.tsx`. Tests: `apps/api/src/test/{mfa-platform,sesi-idle}.test.ts`.

MFA enforcement is platform-oriented and needs extension to all mandated back-office, owner and shareholder roles. Build registered outlet devices, staff device PIN and distinct supervisor override with requester, approver, reason and value (AUTH-05/06). Reassess session lifetime, revocation and device trust under outlet and edge operation; reuse only after tenant and identity contracts.

### Roles, permissions and time-bound assignments

**Exists, partial.** API: `apps/api/src/services/{role.service,role.izin}.ts`, `apps/api/src/routes/role.routes.ts`, `apps/api/src/db/schema/{role,platform}.ts`, `apps/api/src/lib/peran-tenant.ts`, `apps/api/src/seed-role.ts`; migrations `apps/api/drizzle/{0006_platform_tenant,0018_role_kustom}.sql`. Shared: changed `packages/shared/src/permissions.ts` and added `packages/shared/src/kolaborasi/role.ts`. Web: `apps/web/src/features/role/`, `apps/web/src/routes/_protected/pengurus/role/`. Tests: `apps/api/src/test/{role,aturan-role,isolasi-tenant}.test.ts`.

Custom roles, expiry and audit machinery exist; permissions and assumptions are alumni-specific. Rebuild Legend role catalog, outlet and station scoping, approval matrix and distinct-actor constraints, with authorization enforced in services and shared by AI/MCP (TEN-03, AUTH-06). Treat seeds and UI as examples, not ready-to-use Legend policy.

### Multichannel notification outbox

**Partial.** API: `apps/api/src/routes/notifikasi.routes.ts`, `apps/api/src/services/{notifikasi.service,notifikasi.pengiriman,notifikasi.pengingat,kanal.antrean}.ts`, `apps/api/src/lib/kanal/{email,email-templat,push,galat}.ts`, `apps/api/src/lib/wa-adapter.ts`, changed `apps/api/src/server.ts` schedules work; schema `apps/api/src/db/schema/notifikasi.ts`; migrations `apps/api/drizzle/{0005_dizzy_boomer,0021_kanal_push_email,0023_whatsapp_template,0041_wa_kirimdev}.sql`. Shared: `packages/shared/src/validators/notifikasi.ts`. Web: `apps/web/src/features/notifikasi/{api,hooks,queries,push-perangkat}.ts`, `components/{panel-notifikasi,kartu-pengingat}.tsx` therein, and `apps/web/src/routes/_protected/{_anggota/notifikasi,_anggota/notifikasi_.preferensi,pengurus/notifikasi,pengurus/notifikasi_.whatsapp}.tsx`. Tests: `apps/api/src/test/{notifikasi,kanal,kanal-adapter,wa-kirimdev,wa-template}.test.ts`.

Persisted channel delivery attempts, in-app, web push, email, WhatsApp, preferences, quiet hours, deduplication keys and retry logic exist. They do not establish the PRD's distinct transactional domain-event `notification_outbox`. `kanal.antrean.ts` documents possible duplicate delivery if a process crashes after provider acceptance and before commit: enqueue deduplication is not exactly-once external delivery. Adapt alumni-specific templates and categories; design event-to-outbox transaction, recipient/outlet/device scoping, realtime WebSocket operational notifications and edge sync separately (PRD notification requirements and `notification_outbox` schema). Test replay, provider idempotency and reconnects. Estimate excludes full offline edge system.

### Finance

**Partial.** API: `apps/api/src/routes/keuangan.routes.ts`, `apps/api/src/services/{keuangan.umum,kas.service,pengeluaran.service,pembayaran.service,settlement.service}.ts`, `apps/api/src/db/schema/keuangan.ts`; migrations `apps/api/drizzle/{0008_integrasi_backend,0029_jurnal_append_only,0030_pengeluaran}.sql`. Shared: `packages/shared/src/jurnal.ts`, `packages/shared/src/validators/keuangan.ts`. Web: `apps/web/src/features/kas/{api,hooks,queries,ekspor}.ts`, `apps/web/src/features/kas/components/dialog-kasus.tsx`, `apps/web/src/routes/_protected/pengurus/{kas,kas_.koreksi,rekonsiliasi_.kasus.$id}.tsx`, `apps/web/src/routes/_protected/_anggota/laporan-kas.tsx`. Tests: `apps/api/src/test/{keuangan,settlement,kontribusi}.test.ts` and helper `apps/api/src/test/keuangan-uji.ts`.

Reusable ideas include balanced double-entry journals, reversal, append-only DB trigger, closed-month checks, snapshot close and different actors for certain refund/expense approvals. Account codes and balancing per alumni fund, payment links and fixed code are domain-specific. `kas.service.ts` explicitly states approved period reopen is not implemented. Close reads a snapshot separately from posting's period check, with no shared lock evident; concurrency safety is unproven. Rebuild configurable F&B CoA, legal-entity/outlet accounting, approval matrix and approved reopen, automatic journals and reconciliation; design serialization and race tests for close vs post (ACC-01–05; PRD accounting schema). Reuse validated invariants and tests, not the fixed alumni chart or mixed migration.

### AI gateway

**Partial.** API: `apps/api/src/services/{ai.gateway,ai.service,ai.pengaturan.service,ai.penyedia.service,ai.korpus}.ts`, `apps/api/src/routes/{ai,platform-ai}.routes.ts`, `apps/api/src/db/schema/{ai,ai-penyedia}.ts`, `apps/api/src/lib/ai/{index,provider,fake,kripto,url-aman,tugas,openai-kompatibel,anthropic}.ts`; migrations `apps/api/drizzle/{0020_ai_gateway,0028_ai_sitasi,0039_penyedia_ai_platform}.sql`. Shared: `packages/shared/src/{ai,pii}.ts`, `packages/shared/src/validators/{ai,ai-penyedia}.ts`, `packages/shared/src/types/ai-penyedia.ts`. Web: `apps/web/src/features/{ai,ai-penyedia}/`, `apps/web/src/routes/_protected/{platform/ai,pengurus/ai,pengurus/asisten-ai*,_anggota/asisten-ai*}.tsx`. Tests: `apps/api/src/test/{ai,ai-penyedia}.test.ts`.

Gateway has regex PII checks before provider calls, per-user daily quota, tenant budget, kill switch/pause and provider controls. Roles, corpus and login-code patterns are alumni-specific; scanner coverage for NPWP/payroll is not established, nor are concurrent quota enforcement and alerts. Caller-side permission/filtering is not a gateway-wide guarantee. Reuse provider and gateway primitives, add centrally enforced tenant/outlet/role/flag and data-scope checks, appropriate quotas/retention, and build one shared AI/MCP tool catalog with action authorization (PRD §3 AI and MCP, §7). Verify data cannot cross tenant or outlet through tools, sources, cache or logs.

### Audit log and image pipeline

**Audit partial.** API schemas `apps/api/src/db/schema/{platform,role,gateway,impor}.ts`; services `apps/api/src/services/{platform.audit.service,platform.umum,gateway.audit}.ts`; routes `apps/api/src/routes/{platform-tenant,role}.routes.ts`; migrations `apps/api/drizzle/{0006_platform_tenant,0008_integrasi_backend,0015_impor_roster_foto,0018_role_kustom,0024_gateway_tenant}.sql`; shared `packages/shared/src/validators/platform.ts`; web `apps/web/src/routes/_protected/platform/audit.tsx`, `apps/web/src/features/role/components/riwayat-audit.tsx`; tests `apps/api/src/test/{platform,gateway,role}.test.ts`. These are separate platform, role, gateway and membership logs, not a universal tenant audit. Build common event contract with actor type (user/AI/MCP/system), device, outlet, masked changes, IP hash, sensitive access records and retention, then integrate modules per PRD.

**Image pipeline present.** API `apps/api/src/lib/{media-proses,multipart,penyimpanan,penyimpanan-penyedia,penyimpanan-s3}.ts`, `apps/api/src/services/media-aset.service.ts`, `apps/api/src/routes/media-aset.routes.ts`, `apps/api/src/db/schema/media-aset.ts`, `apps/api/drizzle/0026_media_galeri.sql`; shared `packages/shared/src/media.ts`; web `apps/web/src/components/gambar.tsx`, `apps/web/src/features/branding/components/unggah-gambar.tsx`; tests `apps/api/src/test/{media,media-aset,media-pemakai,branding}.test.ts`. Magic-byte and size/pixel checks, WebP variants, metadata stripping, tenant-keyed access and SVG checks exist. Extract processing/storage primitives from alumni membership/gallery/payment/branding ownership; establish outlet-aware access and review SVG handling and signed/private access before reuse. Despite §7 saying no major changes, these coupling and audit gaps require adaptation.

## Other reusable material

- **UI:** Source additions include `apps/web/src/components/ui/{dialog,skeleton,checkbox,badge,native-select,switch,popover}.tsx`; baseline UI controls such as `button.tsx` and `input.tsx` are modified. Review components individually for dependencies, accessibility and Legend `DESIGN.md` tokens, tenant themes and dark mode. Source alumni screens and branding are not portable as-is.
- **Tests:** Changed baseline `apps/api/src/test/helpers.ts`, `apps/api/vitest.config.ts`, `playwright.config.ts`, `e2e/{auth.spec,helpers,roles.spec}.ts`; compare hunks before using fixtures. Source-only tests listed above are useful behavioral examples, but expect alumni seed dependencies; write Legend tenant/outlet isolation, concurrency and edge tests.
- **CI/deploy:** `.github/workflows/ci.yml`, `apps/api/Dockerfile`, `apps/web/Dockerfile` differ; `.github/workflows/deploy.yml` and `deploy/` are source-only. `compose.dev.yaml`, `compose.test.yaml`, `scripts/test.mjs`, `scripts/test-setup.mjs` match baseline. Inspect deployment and backup/restore patterns; source scripts target 119connect infrastructure and do not provide the Legend edge topology. Add PRD isolation, offline sync and tenant-hardcoding gates rather than replacing target CI wholesale.

## Copy order and integration rules

1. Lock shared tenant, outlet, identity, permissions, event/outbox and storage contracts (WS-00); establish enforced RLS and migrations for tenant/brand/outlet, then resolution and support access. Test TEN-01–05 at API and database roles before downstream data.
2. Adapt identity and login, then MFA/session/device and role assignment; implement outlet/station scope and approval contracts together before sensitive operations.
3. Establish a common audit event contract and transactional event/outbox abstraction; attach notifications and image storage to the verified identity and tenant contracts.
4. Port finance invariants and implement entity/outlet CoA, approval, serializable close/reopen and journal integration; independently integrate notifications with realtime and edge design.
5. Adapt the AI gateway after tenant, permissions, audit and data contracts; build the shared AI/MCP catalog and enforce identical authorization for both entry points. Port UI primitives and tests as each contract settles.

Never copy `drizzle/meta/_journal.json`, schema snapshots, or numbered SQL en bloc over the target migration history. Extract relevant schema, create coherent new migrations against Legend, and check generated snapshots, exports, middleware order, route registration, dependencies and tests. Mixed-domain migrations and changed base integration files need hunk-by-hunk review.

## Baseline files changed in source

These paths existed at target `ef5bc4c` but differ byte-for-byte in source; unchanged base files should generally stay in Legend. Differences may be configuration, integration, branding or generated artifacts, not all reusable feature code.

```text
.codex/config.toml
.env.example
.github/workflows/ci.yml
.gitignore
.prettierignore
AGENTS.md
CLAUDE.md
README.md
apps/api/Dockerfile
apps/api/drizzle/meta/_journal.json
apps/api/package.json
apps/api/src/app.ts
apps/api/src/config/env.ts
apps/api/src/db/index.ts
apps/api/src/db/schema/index.ts
apps/api/src/db/schema/session.ts
apps/api/src/db/schema/user.ts
apps/api/src/lib/auth.ts
apps/api/src/lib/logger.ts
apps/api/src/lib/request-context.ts
apps/api/src/middleware/auth.ts
apps/api/src/middleware/body.ts
apps/api/src/routes/index.ts
apps/api/src/server.ts
apps/api/src/test/env.test.ts
apps/api/src/test/helpers.ts
apps/api/src/test/http.test.ts
apps/api/src/types/express.d.ts
apps/api/tsup.config.ts
apps/api/vitest.config.ts
apps/web/Dockerfile
apps/web/package.json
apps/web/src/components/auth-form.tsx
apps/web/src/components/brand.tsx
apps/web/src/components/providers.tsx
apps/web/src/components/sign-out-button.tsx
apps/web/src/components/ui/button.tsx
apps/web/src/components/ui/card.tsx
apps/web/src/components/ui/input.tsx
apps/web/src/components/ui/label.tsx
apps/web/src/components/ui/textarea.tsx
apps/web/src/lib/api/client.ts
apps/web/src/lib/api/upstream.server.ts
apps/web/src/lib/auth-client.ts
apps/web/src/routeTree.gen.ts
apps/web/src/router.tsx
apps/web/src/routes/__root.tsx
apps/web/src/routes/_auth.tsx
apps/web/src/routes/_auth/sign-in.tsx
apps/web/src/routes/_auth/sign-up.tsx
apps/web/src/routes/_protected.tsx
apps/web/src/start.ts
apps/web/src/styles/globals.css
docs/backend.md
docs/deployment.md
docs/frontend.md
docs/local-development.md
e2e/auth.spec.ts
e2e/helpers.ts
e2e/roles.spec.ts
eslint.config.mjs
package.json
packages/shared/package.json
packages/shared/src/permissions.ts
packages/shared/src/types/api.ts
playwright.config.ts
pnpm-lock.yaml
starter.config.json
```

## Licensing and secret handling

Source `LICENSE` is MIT with copyright attributed to ngodingpakeai contributors; preserve its copyright and permission notice for copied material. `THIRD_PARTY_NOTICES.md` attributes shadcn/ui and warns dependencies have separate licenses; `apps/web/public/images/KREDIT.md` identifies separately sourced images, so do not assume the code license covers assets. Confirm rights to private-repository contributions and assets before distribution.

Do not copy `.env.example`, `deploy/env.production.example`, `deploy/stack.env.example`, deployment domains, provider identifiers or infrastructure settings wholesale. `apps/api/src/seed-gateway.ts` contains hardcoded explicitly fictional but production-shaped sandbox keys; do not transplant them. Generate new secrets and use Legend-specific environment/secret management. The targeted scan cannot prove absence of credentials or cover source Git history (not present); run a dedicated secret scan and review any history available before porting. Do not put values from source into the inventory.

## Verification

- Static source/PRD review and byte comparison against `ef5bc4c`; no source code or source configuration was changed.
- Target `pnpm check`: passed lint, typecheck, 5 API test files / 18 tests and 9 root tests, using isolated temporary PostgreSQL. This validates the existing template, not the 119connect modules.
- `pnpm build` and source module tests not run: documentation-only analysis; no implementation was changed.
- Required `~/.agents/main.md` was absent on this host. Repository `AGENTS.md` and the explicit task instructions were followed where applicable.
