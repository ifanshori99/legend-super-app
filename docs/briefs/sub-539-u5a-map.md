# Map 539-U5a (dari Explore)

## S1 restore + S2 owner (platform)

- Belum ada layar. Rumah: `apps/web/src/features/ws01-platform-tenants/components/tenant-detail-page.tsx` (route `routes/_platform/platform.tenant.$tenantId.tsx`, guard `features/ws01-platform-tenants/guard.ts`).
- Pola API: `features/ws01-platform-tenants/api.ts` (`callEndpoint` dari `@/lib/api/endpoint` + `platformEndpoints`), `queries.ts`, `hooks.ts`. Contoh dialog: `status-change-dialog.tsx`. Input mfaCode: `features/ws01-support-access/components/request-dialog.tsx` (tidak ada OTP di components/ui).
- Kontrak `@starter/shared/platform`: `platformEndpoints.{getTenantRestoreWindow,restoreTenant,getOutletRestoreWindow,restoreOutlet}` (endpoints.ts:192-234); input `restoreTenantInputSchema`/`restoreOutletInputSchema` {reason ≥10} (org.ts:44,390-397); DTO window tenant `{tenantId,status,archivedAt|null,restoreTo|null,restorableUntil|null,restorable}`, outlet pakai `outletId`,`closedAt`. Error codes `platform/errors.ts:42-44`.
- S2: `platformEndpoints.{assignTenantOwner,replaceTenantOwner}` (endpoints.ts:263-278, params {tenantId,assignmentId}); input `platform/tenant-owner.ts` `{account:{userId}|{invite:tenantFirstAdminSchema}, reason 1-500, mfaCode? /^\d{6}$/}`; respons `tenantOwnerAssignmentSchema` (account member|reused|invited).
- Celah: tidak ada endpoint daftar owner → asal `assignmentId` untuk replace belum jelas. Cek tenant detail DTO; bila tak ada, tampilkan alur sesuai mockup dengan data yang ada dan catat kartu backend yang dibutuhkan (jangan tulis backend).
- Kepemilikan berkas: S1 boleh edit `tenant-detail-page.tsx` (mount RestoreSection + outlet restore di daftar outlet). S2 JANGAN edit tenant-detail-page.tsx; buat komponen `OwnerSection` sendiri, agent utama yang memasang. api/queries/hooks: S1 tulis di `restore-api.ts`/`restore-hooks.ts` baru, S2 di `owner-api.ts`/`owner-hooks.ts` baru (jangan edit api.ts/hooks.ts bersama).

## Umum

- `routeTree.gen.ts`: jangan edit/regenerasi; agent utama yang regenerasi di akhir. Route baru cukup tulis berkas route-nya.

## S3 domain (legend-az8z5)

- Kontrak: `packages/shared/src/platform/endpoints.ts:431-451` `orgEndpoints.{listDomains,addDomain,verifyDomain,removeDomain}`; `platform/domains.ts:59-84` `TenantDomain {id,tenantId,brandId,hostname,kind,tlsStatus,verifiedAt|null,verification:{type:"TXT",name,value}|null,createdAt}`, `DomainVerificationRecord`, `addDomainInputSchema`. Error: DOMAIN_RESERVED, DOMAIN_TAKEN, DOMAIN_VERIFICATION_FAILED (`apps/api/src/services/org.service.ts:768-858`).
- Web belum ada. Tambah fungsi di `features/ws01-org/{api,queries,hooks}.ts` (S3 pemilik berkas ini), komponen `features/ws01-org/components/domain-settings-page.tsx`, route baru `routes/_kelola/kelola.pengaturan_.domain.tsx` meniru `kelola.pengaturan_.outlet.tsx`.

## S4 MFA recovery (legend-sw980)

- Kontrak `packages/shared/src/identity/endpoints.ts:229-247`: `getMfaRecoveryStatus` (GET), `generateMfaRecoveryCodes` (POST /api/auth/mfa/recovery-codes), `verifyMfaRecoveryCode` (POST /api/auth/mfa/recovery). DTO `MfaRecoveryCodes {codes[10],generatedAt}`, `MfaRecoveryStatus {remaining,generatedAt|null}`, hasil verify `{verifiedAt,remaining}`, body `mfaRecoveryVerifySchema {code}` + `MFA_RECOVERY_CODE_INPUT_PATTERN`. Error `MFA_RECOVERY_CODE_INVALID`.
- Web: `features/ws01-auth/{api,hooks,errors}.ts` (S4 pemilik), `components/totp-enroll.tsx` (`TotpEnrollFlow`, `onEnrolled`), dipakai `mfa-panel.tsx:220` + `mfa-verify-page.tsx:263` → tampilkan kode sekali setelah enrol di keduanya. Login challenge `mfa-verify-page.tsx` `CodeChallenge` (:49) → toggle "pakai kode cadangan". `mfa-panel.tsx:144` placeholder backupTitle/backupHint (status sisa kode + buat ulang).

## Test (berlaku semua layar)

- Web TIDAK punya vitest/testing-library. Pola repo: logika murni layar di modul `features/<f>/<layar>-state.ts` (impor relatif, tanpa alias `@/`, bisa dimuat Node type stripping), diuji `tests/<kartu>-<layar>-ui.test.mjs` (node:test), contoh `tests/payslip-pin-ui.test.mjs` + `features/ws10-payslip/pin-state.ts`. Uji: validasi, pemetaan error→teks, turunan status/keadaan. Jalankan: `heavy node --test tests/<berkasmu>.test.mjs` (boleh, ringan).

## S5 UOM (legend-7z38l)

- Layar read-only `features/ws06-inventory/components/units-page.tsx`, route `routes/_kelola/kelola.inventori.satuan.tsx` (guard `inventoryGuard(["inventory.stock.view"])`). Ada `api.listUnits`, `unitsQuery`, `useUnits`, `useInventoryMutation` (hooks.ts:50). Tambah `createUom`/`updateUom` di api.ts+hooks.ts (S5 pemilik ws06-inventory api/hooks), invalidasi query list.
- Kontrak `packages/shared/src/inventory/endpoints.ts`: createUom POST body `{code:/^[a-z0-9]{1,10}$/ lowercase, name 1..150}`, updateUom PATCH `{name}`; `uomSchema {id,tenantId,code,name,isSystem}` (isSystem = terkunci). Izin tulis: `inventory.item.manage` (cek di API route).

## S6 account-role mappings (legend-fzvh)

- CoA `features/ws07-accounting/components/coa-page.tsx`, route `routes/_kelola/kelola.akuntansi.index.tsx`, `EntityScope` (entity.id), `AccountingPage active="coa"`, guard `accountingGuard(ACCOUNTING_VIEW)`, tulis `useCanPostJournals()`. Ada `accountsQuery(legalEntityId)`, `useAccounts`.
- Kontrak `packages/shared/src/accounting/endpoints.ts:190,196` listAccountMappings GET / replaceAccountMappings PUT `/legal-entities/:legalEntityId/account-mappings` body `{mappings:[{role,accountId}] max100}`; `AccountMapping {tenantId,legalEntityId,role,accountId}`. `coa.ts`: `POSTING_ACCOUNT_ROLES` (:174), `allowedAccountTypesForRole` (:258), `accountMappingIssues` (:281, string Inggris → buat pemetaan teks Indonesia sendiri). Cek `payroll_custom_deduction`.
- S6 pemilik: berkas baru `features/ws07-accounting/{mapping-api.ts,mapping-hooks.ts,mapping-state.ts,components/account-mappings-page.tsx}`, route baru `routes/_kelola/kelola.akuntansi.pemetaan.tsx`, BOLEH tambah satu entri tab di `accounting-shell.tsx` (hanya S6 yang menyentuhnya).
