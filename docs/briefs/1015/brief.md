# 1015 UI finance: flag recon payout, clearance dua orang, tarik klaim return (legend-o2b4m)

Tingkat K (uang). Base `e6e59f5bf` (1005 di atas 990). Worktree: `/Users/ifanshori99/Projects/legend super app/legend-0766a0e0`.

## Sumber

- Mockup disetujui founder (Q28): `design/mockups/backoffice/payout-recon-clearance.html`, catatan `design/mockups/backoffice/payout-recon-clearance-notes.md` (WAJIB dibaca: pemetaan field, keadaan, batas data), PNG `payout-recon-clearance-<state>-{desktop,mobile}.png` (state: normal, empty, loading, error, validation, success, approve, self, changed, reopened). Baca hanya PNG layar yang sedang dibangun.
- Kontrak recon: `docs/briefs/990/i2-contract.md`; API `apps/api/src/routes/payroll-payout-recon-clearance.routes.ts`; validator `packages/shared/src/validators/payroll-payout-recon-clearance.ts`; DTO `PayoutReconFlagDto` di `packages/shared/src/types/api.ts`.
- Kontrak tarik klaim return (1005): `docs/briefs/1005/design.md`; API `apps/api/src/routes/payroll-payout-return-withdraw.routes.ts`; validator `packages/shared/src/validators/payroll-payout-return-withdraw.ts`. Tidak ada mockup khusus: ikut pola dialog return yang ada di `apps/web/src/features/ws10-payroll-payout/components/status-dialogs.tsx` / status tab.
- Fitur web: `apps/web/src/features/ws10-payroll-payout/` (api.ts, queries.ts, hooks.ts, errors.ts, guard.ts, mock.ts, lib.ts, components/). Route: `apps/web/src/routes/_kelola/kelola.payroll.pencairan.tsx` (tab runs|approval|status|settings).
- Standar UI: `~/.agents/team/ui-standard.md`.

## Aturan

- Izin layar = izin API: `payroll.disburse.approve` (roleHasPermission di beforeLoad / guard yang ada). Hiding UI bukan pengaman; API tetap penjaga.
- Tombol setujui disembunyikan/nonaktif dengan penjelasan untuk pengusul sendiri (bandingkan `proposedBy`/`createdBy` dengan `currentUserId`, bukan nama).
- Password diminta di dialog (step-up), tidak pernah disimpan, dikosongkan setelah submit/tutup. Tidak ada aksi bayar dari layar ini. Copy tidak menjanjikan transfer/"gaji dibayar".
- Status: Terbuka / Diusulkan / Disetujui / Terbuka ulang (lihat notes). Konflik 409 (`PAYOUT_RECON_FLAG_CHANGED`, `PAYOUT_RECON_CLEAR_STATE`, PAYOUT-93/95) -> muat ulang data, tawarkan usulan baru.
- Pesan error baru masuk katalog `ws10-payroll-payout-review` (lihat errors.ts dan katalog teks); cek `node --test tests/text-contract.test.mjs` lewat `pnpm test` terarah.
- Data lewat lapisan api.ts -> queries.ts -> hooks.ts; komponen hanya pakai hooks. Mock scenario (`isMockScenarioRequest`) diikuti seperti tab lain.
- Tiap layar: loading, kosong, error, sukses; desktop 1280 dan mobile 390; angka tabular, Rupiah format id-ID; status bukan warna saja.
- Jangan menjalankan tsc/vitest/e2e kecuali kamu pemegang token heavy yang ditunjuk. Jangan commit.

## Antarmuka bersama (nama tetap, dipakai semua subagent)

Lapisan data (pemilik: implementer-data; file: api.ts, queries.ts, hooks.ts, errors.ts, mock.ts di `features/ws10-payroll-payout/`):

- api.ts: `listPayoutReconFlags(): Promise<PayoutReconFlagDto[]>`, `proposeReconClearance(flagId, {reason, password}): Promise<{clearanceId}>`, `approveReconClearance(clearanceId, {password}): Promise<{clearanceId}>`, `listBatchReturnClaims(batchId): Promise<PayoutReturnClaimDto[]>`, `proposeReturnWithdrawal(claimId, {reason, password}): Promise<{withdrawalId}>` (cek bentuk respons route), `approveReturnWithdrawal(withdrawalId, {password})`. Path: `/api/hris/payroll/payout-recon-flags`, `.../payout-recon-flags/:flagId/clearance`, `.../payout-recon-clearances/:clearanceId/approve`, `.../disbursement-batches/:id/return-claims`, `.../payout-return-claims/:claimId/withdrawal`, `.../payout-return-withdrawals/:withdrawalId/approve`. `encodeURIComponent` id.
- queries.ts: `payoutReconFlagsQuery()`, `batchReturnClaimsQuery(batchId)`; key di bawah key payout yang ada.
- hooks.ts: `usePayoutReconFlags()`, `useProposeReconClearance()`, `useApproveReconClearance()`, `useBatchReturnClaims(batchId)`, `useProposeReturnWithdrawal(batchId)`, `useApproveReturnWithdrawal(batchId)`. Mutasi invalidasi query terkait, juga saat 409 (data berubah).
- errors.ts: pemetaan kode ke teks Indonesia untuk PAYOUT_RECON_* , PAYOUT_RECON_FLAG_CHANGED, PAYOUT-92..95 (+ kode HTTP yang dipakai route withdraw), lewat katalog yang ada. Ekspor helper `isReconConflict(err)` / `isWithdrawConflict(err)` bila perlu.
- mock.ts: skenario mock untuk recon (normal, empty, loading, error, approve, self, changed, reopened) dan klaim return dengan withdrawal, mengikuti mekanisme mock scenario yang ada.

Layar recon (pemilik: implementer-recon; file baru `components/recon-*.tsx`, route baru `apps/web/src/routes/_kelola/kelola.payroll.rekonsiliasi.tsx` (h1 "Flag rekonsiliasi payout"), entri nav di `nav.ts` / definisi area bila perlu, guard izin `payroll.disburse.approve`).
Tarik klaim return (pemilik: implementer-withdraw; file baru `components/return-withdraw.tsx` + sambungan minimal di status tab / status-dialogs).
Test (pemilik: test-writer; file test baru saja).

## Tambahan (dari Explore)

- Teks UI baru: `packages/shared/src/i18n/messages/ws10-payroll-payout-review.ts` (namespace `payrollPayoutReview`, diimpor di `id.ts:86`). `tests/text-contract.test.mjs` menolak teks hardcode. File katalog dipakai bersama: edit hanya dengan Edit (sisip), jangan Write ulang; recon -> sub-objek `recon`, withdraw -> `returnWithdraw`, error -> tempat error yang ada.
- E2E proyek ini mock-only (`e2e/payout*.mock.spec.ts`, `pnpm test:e2e:mock <spec>`, role cookie `finance`, sessionStorage `payoutMockStepUp=password`, password benar `benar-123`). Mock recon/withdraw harus mendukung dua pengguna: pengusul membuat usulan, lalu pengguna lain (ganti identitas mock, mis. sessionStorage/cookie) menyetujui; pengusul yang sama melihat tombol setujui nonaktif. State mock usulan bertahan antar reload (sessionStorage) supaya e2e bisa ganti pengguna.
- Test web: `apps/web/test/*.test.ts` dengan `renderToString` (lihat `apps/web/test/payout-password-stepup.test.ts`), tanpa jsdom.
- Screenshot: ke `docs/review/img/ui1015-*` (bukan docs/screenshots).
