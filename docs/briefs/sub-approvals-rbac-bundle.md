# Sub-brief: approvals + RBAC + org bundle (WS-01)

Worktree (ONLY work here): `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/approvals-rbac-bundle`
Branch `ws/approvals-rbac-bundle` from `origin/milestone/m1` (89540326). Do NOT commit/push (engineer does).

## Cards (`bd show legend-<id>` for full text)
- A. legend-5vlw + legend-6hr8 (approvals): contract for approver-PIN verify (6ew FE used verifyStaffPin), override reason codes (FE invented 6 codes), approval cancel by requester (pending only), staff roster endpoint if needed. PRD §3 F6, AUTH-06.
- B. legend-i6ff: `listAccessUsers` in `@starter/shared/identity` (cursor page; userId, displayName, kind, status only; perm `access.role.view`; tenant from session), API route, fixtures parse test, wire FE port `features/ws01-access/people.ts`.
- C. legend-wc25: NotificationRecipientResolver (`apps/api/src/worker/notification-adapters.ts` ~600) maps `approval.requested` -> active holders of snapshotted approverRoleIds whose scope covers request outlet/tenant; `approval.resolved` (approved/rejected/expired/cancelled) -> requester.
- D. legend-7art: `cafeLegendAccessFixtures.stations` ids must equal `@starter/shared/menu` fixture station ids; contract test: every access station id resolves via listStations fixtures.

## Security rules (tier K, access)
Every endpoint: requireAuth + requireTrustedOrigin + requirePermission; tenant filter in SQL (never trust body tenantId); tests for cross-tenant/outlet isolation. Directory: no other-tenant users, no PII beyond listed fields (no email/phone/PIN hash).
Cancel: only requester, only pending; other user/tenant -> 404/403; idempotency per house pattern.

## Tests / heavy
Tests in app-relative `src/test/...` or existing pattern near sibling tests. IDs: follow API (ULID if API wants ULID).
Run targeted tests ONLY via: `cd <worktree> && pwd && LEGEND_TEST_FILES=<file> heavy pnpm test` (or `heavy vitest run <path>` inside the package). Only the subagent told to run tests runs them. Never run tsc unless told.
Migration only if unavoidable: number 0294, unique `when`, drizzle snapshot.

## Explore findings + design (engineer decisions)

### A1. legend-6hr8 cancel (BE + shared contract) — files: packages/shared/src/identity/endpoints.ts (cancel entry only), apps/api/src/services/platform-approval.service.ts, apps/api/src/routes/platform-approval.routes.ts
- Service `cancelApprovalRequest` (service.ts:805) is module-scoped, pending-only, idempotent, emits approval.resolved + audit. Add HTTP wrapper `cancelOwnApprovalRequest(tx, context, {requestId, userId})`: load row by tenantId AND id in SQL; not found / other tenant / requestedBy != userId -> 404 (no leak); resolve chainId+sourceModule from the row and call existing cancel with actorUserId=userId. Already cancelled -> 200 same DTO (idempotent). Approved/rejected/expired -> 409.
- Route `POST /api/approvals/:requestId/cancel` in platform-approval.routes.ts (router already has requireAuth, requireTrustedOrigin, requireTenantContext, requireBackOfficeSurface; check if POS surface must also be allowed since modal runs on POS — mirror how POST create is mounted). jsonBody + Idempotency-Key like create. Response = same DTO as GET one.
- Shared: endpoint entry `cancelApprovalRequest` next to decide (~endpoints.ts:255-285), param schema = same as get.

### A2. legend-5vlw contract + FE wiring — files: packages/shared/src/access/override.ts, apps/web/src/features/ws01-device-pin/** (override-request-modal.tsx, mock.ts), apps/web/src/features/ws01-approvals/{api,mock}.ts
- Reason codes: add `posOverrideReasonCodes` const + `posOverrideReasonCodeSchema = z.enum(...)` in override.ts; use in createPosOverrideSchema (override.ts:189). Source codes from PRD §3 F6 (grep docs/ PRD) else adopt the 6 FE codes (override-request-modal.tsx:51). Update the 9 test usages in apps/api/src/test if they send other codes. FE modal imports the shared list (no local list).
- Approver PIN: modal supervisor-PIN path must use createPosOverride method `supervisor_pin` {approverUserId, pin} (device-pin.routes.ts:135) instead of verifyStaffPinCall/usePinSession (modal ~:170).
- Approver picker: if modal needs list of eligible approvers, check for existing endpoint; if none, report to engineer (do NOT invent a new endpoint).
- "Berhenti menunggu": call cancel endpoint (A1 name `cancelApprovalRequest`, POST /api/approvals/:requestId/cancel) then close. Mock: cancel works in ws01-approvals mock; device-pin mock approvals visible/decidable in approvals inbox mock (share one store).

### B. legend-i6ff directory — files: packages/shared/src/access/schemas.ts (+identity/endpoints.ts entry `listAccessUsers` — coordinate: add AFTER A1 entry, different line region), packages/shared/src/identity/fixtures.ts, apps/api/src/services/access.service.ts, apps/api/src/routes/access.routes.ts, apps/web/src/features/ws01-access/{people.ts,mock-people.ts,api.ts}
- `GET /api/access/users`, requireTenantPermission("access.role.view") like GET /role-assignments (access.routes.ts:114). Service like listRoleAssignments (access.service.ts:650): withTenant + assertTenantPermission.
- Population: staff only = distinct users with >=1 roleAssignments row in tenant (SQL tenant filter). No customers (CRM members are not grantees; avoid PII). Fields ONLY: userId, displayName (user.name), kind ("staff"), status ("active" = not banned and has an assignment valid now; else "inactive"). Never email/phone/image/pin.
- Query: cursorPageQuerySchema + optional `q` (name, ILIKE with escaped %/_ , max 100). Order name asc, id asc; limit+1; encodeCursor.
- Fixtures: accessUsersFixture parse test. FE port people.ts:31 calls real endpoint (keep mock path). Map to AssignablePerson.

### C. legend-wc25 — already implemented (notification-adapters.ts:261,376,416,912). Coverage tests only (test-writer running).

### D. legend-7art — files: packages/shared/src/access/fixtures.ts, packages/shared/src/menu/fixtures.ts (only if adding stations)
- Access stations: 6 ids fixedId("5a710000",1..6) codes bar_kopi,bar_nonkopi,dapur_panas,dapur_dingin,pastry (outlet bandung), bar_kopi_2 (bandung2). Menu: 4 stations base(200..203) Kopi,Beverage,Hot Kitchen,Pastry on outlets[0].
- Make access station ids reuse menu ids: bar_kopi->Kopi, bar_nonkopi->Beverage, dapur_panas->Hot Kitchen, pastry->Pastry. For dapur_dingin and bar_kopi_2: add matching stations to menu fixtures (Cold Kitchen outlets[0]; Kopi outlets[1] if menu has a 2nd outlet matching bandung2) unless that breaks menu tests counting stations -> then report. Lookups by code (permission-resolver.test.ts) must still pass.
- Contract test (apps/api/src/test/access-fixtures-contract.test.ts): every access station id is in menu fixture stations with same outletId.

## E. Keputusan CTO 2026-11-11 (gelombang 2)

Basis: commit 230bfd2e. Jangan commit/push (engineer yang commit). Semua test lewat `heavy` (lihat CLAUDE.md "Test terarah"). Bukti gagal-dulu: jalankan test baru sebelum fix, simpan baris gagalnya di laporan.

- E1. Mantan staf (status `inactive` di `GET /api/access/users`) tetap tampil di direktori, tapi tidak bisa dipilih untuk assignment atau penyetuju baru. Web: picker grant (`ws01-access/components/assignments-page.tsx`, `people.ts`) dan picker penyetuju manapun yang memakai direktori hanya menawarkan `active`. API: grant role ke user yang di-ban/nonaktif ditolak (cek dulu apakah sudah; kalau belum, tambah dengan test). Test wajib untuk keduanya.
- E2. Enam kode alasan override (`posOverrideReasonCodes`, `packages/shared/src/access/override.ts:~180`) adalah daftar resmi. Catat di docs (cari dokumen WS-01/akses yang membahas override; kalau tidak ada, `docs/access-override-reason-codes.md`) dengan label Indonesia dari i18n.
- E3. Jalur POS cancel: tombol "Berhenti menunggu" tidak boleh gagal karena MFA. Endpoint POS (guard sesi perangkat + staf aktif, seperti `routes/pos-acting-staff.routes.ts` + `routes/device-id.ts` dan route `POST /api/pos-overrides`) yang HANYA boleh membatalkan request override (sourceModule inbox, actionType override POS) milik staf aktif itu sendiri yang masih pending, di tenant+outlet perangkat. Jalur back-office `POST /api/approvals/:requestId/cancel` tetap MFA, tidak diubah. Pakai ulang logika `cancelOwnApprovalRequest` (platform-approval.service.ts:877). Test gagal-dulu: staf lain, perangkat/outlet lain, tenant lain, request non-override, sudah diputus, tanpa staf aktif, tanpa tanda tangan perangkat => ditolak; staf sendiri pending => cancelled + event. Tingkat K (akses): architect xhigh mereview diff ini.
- E4. Staf aktif tersimpan tanpa `outletId` (dari sebelum 230bfd2e): pakai outlet perangkat sebagai fallback bila ada; bila tidak ada, minta login PIN ulang dengan pesan jelas (bukan galat generik). Test gagal-dulu.

## F. Temuan architect xhigh atas E3 (basis 27d2b0cb), wajib dibetulkan

1. HIGH: `jsonBody` di `routes/device-pin.routes.ts:~230` (cancel POS) dan `routes/platform-approval.routes.ts:109` (cancel back-office) menjawab 415 karena FE tidak mengirim content-type untuk POST tanpa body (`apps/web/src/lib/api/client.ts:99`). Buang `jsonBody` dari kedua route cancel (pola: `identity-auth.routes.ts:148`). Test gagal-dulu: cancel tanpa body dan tanpa content-type = 200, di kedua jalur (test sekarang memakai `.send({})`).
2. Test tambahan di `pos-approval-cancel.test.ts`: request lewat deadline = 409 dan override tidak approved; sesudah cancel tidak ada event `pos_override.recorded` dan tidak ada audit override tercatat; token kasir dicabut / staf bukan lagi anggota outlet = ditolak; chain 2 level: level 1 approved lalu cancel memakai id level 1 = override cancelled.
3. LOW: `override-request-modal.tsx:~224` `sendToPhone` berhenti bila `requesterId` kosong (pesan `devicePin.override.noRequester`, seperti jalur PIN). Audit cancel POS memakai device id yang ditandatangani, bukan null.
4. NIT: docblock cancel di `packages/shared/src/access/override.ts:~334` dipindah ke `cancelPosOverrideApproval`; dua endpoint POS baru dicatat di `docs/plan/contracts.md`.
