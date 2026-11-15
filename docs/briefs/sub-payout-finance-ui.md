# Sub-brief: UI pencairan gaji + pengecualian finance (ui-engineer, 14 Nov 2026)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-7c4c01a1` (base `ws/finance-exceptions` 598cd9cb1). Cabang akhir `ui/payout-finance-exceptions`.

Mockup disetujui founder (W6 Q1), salinan lokal di scratchpad:
`/private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app-legend-7c4c01a1/461caf72-891d-4f34-9906-4cdba8b0ce6e/scratchpad/mock/design/mockups/{payout,finance-exceptions}/` (README.md, review.html, PNG per layar/kondisi desktop+mobile). Baca hanya PNG layar yang kamu bangun.

## Layar
A. Pencairan gaji (legend-wnkep.6, .7): empat tab Siap bayar (run) / Persetujuan / Status karyawan / Pengaturan PT. Persetujuan dua orang (pembuat != penyetuju), status per karyawan (menunggu, berhasil, gagal, dibayar manual, hasil belum pasti tanpa tombol bayar ulang), rekening sumber nonaktif ditolak, Duitku belum aktif -> jalur manual. Gaji diterima dipisah dari biaya PT (biaya tidak dipotong dari gaji).
B. Pengecualian finance (legend-4oclu): `GET /api/accounting/finance-exceptions`, lima jenis, filter jenis/outlet/tanggal (wajib, maks 92 hari), nilai null = "Tidak tersedia" (bukan Rp0), ringkasan per jenis (tidak dijumlah), `truncated`, tabel -> kartu di mobile (<700px).

## Aturan keras
- Jangan ubah service/route API (`apps/api/src/services`, `routes`). Thread lain mengubah payout service. Field kurang: catat, laporkan.
- Tombol uang tidak boleh aktif hanya karena UI; server tetap pemeriksa. UI boleh menonaktifkan tombol untuk kejelasan, tapi selalu tampilkan error server.
- Teks UI didaftarkan ke katalog teks proyek (lihat temuan Explore web).
- Tiap layar: loading, kosong, error, sukses; desktop 1280 dan mobile 390.
- Pola web: `features/<x>/{api,queries,hooks}.ts`, komponen pakai hooks, loader `ensureQueryData`. shadcn di `components/ui`.
- Ikuti `~/.agents/team/ui-standard.md`.

## Fakta API (dari Explore, jangan ubah API)
Payout (`/api/hris/payroll`, routes `apps/api/src/routes/payroll-payout*.routes.ts`, schema `packages/shared/src/validators/payroll-payout.ts`, DTO `packages/shared/src/types/api.ts:46-100`):
- GET/PUT `/payout-configs/:legalEntityId` (PUT: `payroll.payout.configure` + MFA). Config: method `duitku|manual_bank`, integrationId, manualSourceBankAccountId, manualBankFormat, maxPerTransferIdr, dailyCapIdr, feePerTransferIdr, enabled.
- GET/POST `/runs/:id/disbursement-batches` (POST `{channel}`, `payroll.disburse.request`). GET `/disbursement-batches/:id`.
- POST `/disbursement-batches/:id/{submit|approve|cancel|export|confirm|resolve|confirm-cash|return}`; approve `{contentHash}` + MFA (`payroll.disburse.approve`); export = file sekali (409 kedua); confirm/resolve/confirm-cash/return MFA + password.
- Item: `amountIdr` = gaji bersih, `feeIdr` = biaya PT (tidak dipotong). Batch `totalIdr` = jumlah gaji; total biaya = jumlah `feeIdr` item. Item tanpa nama karyawan/rekening: gabung dari data karyawan yang ada.
- Status batch: draft, pending_approval, approved, sending, exported, completed, partially_failed, halted, cancelled. Item: prepared, blocked, approved, sending, exported, unknown, succeeded, failed, not_sent, cancelled, returned, overpaid. excludedReason: inquiry_failed, name_mismatch, bank_code_missing, bank_format_unsupported, over_cap.
- Error: PAYOUT_SELF_APPROVAL, PAYOUT_CONFIRM_SELF, PAYOUT_SOURCE_ACCOUNT_INVALID (422), PAYOUT_SOURCE_ACCOUNT_MISSING, PAYOUT_CHANNEL_NOT_AVAILABLE (409, Duitku belum aktif), PAYOUT_CONFIG_DISABLED, MFA_REQUIRED, REAUTH_REQUIRED, REAUTH_PASSWORD_INVALID, PAYOUT_APPROVAL_EXPIRED, PAYOUT_HASH_MISMATCH, PAYOUT_BATCH_STATE(_CHANGED), PAYOUT_EXPORT_ALREADY_DOWNLOADED, PAYOUT_BATCH_EMPTY, PAYOUT_NOTHING_TO_PAY, PAYOUT_RUN_NOT_PAYABLE, PAYOUT_RUN_ALREADY_PAID.
- Item `unknown`: tidak ada tombol bayar ulang (server pun tidak punya). Tidak ada route daftar batch per PT: daftar per run.
Finance exceptions: `apps/api/src/routes/accounting-finance-exceptions.routes.ts`, query `packages/shared/src/validators/finance-exceptions.ts`, DTO `types/api.ts:113-136`, kontrak `docs/briefs/662-finance-exceptions-contract.md`. Izin `accounting.journal.view`.

## Pola web yang dipakai
- Contoh layar: `features/ws10-payroll-run/` (api/queries/hooks/mock/lib/guard/nav, `?mock=` skenario, `isMockScenarioRequest`), route `routes/_kelola/kelola.payroll.run.index.tsx`. Typed endpoint + mock mode: `docs/frontend.md` bagian "Typed endpoints and mock mode" dan "See loading, empty and error states". Step-up MFA di UI: `features/ws01-approvals/components/decision-panel.tsx`.
- Tab: `features/ws06-inventory/components/hpp-page.tsx:154`. Uang: `components/ui/money.tsx`, `formatRupiah`. Outlet: `useOutlets()` `features/ws07-accounting/hooks.ts:41`. Halaman akuntansi: `AccountingPage` + `SECTIONS` di `features/ws07-accounting/components/accounting-shell.tsx`, guard `accountingGuard(ACCOUNTING_VIEW)`.
- Teks: `const t = useT()`; katalog sudah disiapkan dan di-wire (jangan edit `id.ts`): `packages/shared/src/i18n/messages/{ws10-payroll-payout,ws10-payroll-payout-settings,ws10-payroll-payout-review,ws07-finance-exceptions}.ts` (namespace `payrollPayout`, `payrollPayoutSettings`, `payrollPayoutReview`, `financeExceptions`). Tiap implementer hanya mengisi file katalognya. Penegak: `tests/text-contract.test.mjs`.

## Pembagian file (tidak bertumpuk)
A. Data + shell payout (implementer A): `apps/web/src/features/ws10-payroll-payout/{api,queries,hooks,mock,lib,guard,nav,errors}.ts`, endpoint defs bila perlu di shared (bukan service), `components/payout-page.tsx` (judul, pilih PT, empat tab via search `tab=runs|approval|status|settings`, `entity`, `batch`), `components/runs-tab.tsx`, route `routes/_kelola/kelola.payroll.pencairan.tsx`, mock handlers, katalog `payrollPayout`. Nama ekspor WAJIB (B/C/D memakainya):
  - hooks.ts: `usePayoutLegalEntities()`, `usePayoutConfig(legalEntityId)`, `useUpsertPayoutConfig(legalEntityId)`, `usePayoutSourceAccounts(legalEntityId)` → `{id,label,maskedNumber,active}[]`, `usePayableRuns(legalEntityId)`, `useRunBatches(runId)`, `useCreateBatch(runId)`, `useBatch(batchId)`, `useSubmitBatch()`, `useApproveBatch()` (`{batchId,contentHash}`), `useCancelBatch()`, `useExportBatch()`, `useConfirmBatch()`, `useResolveBatch()`, `useConfirmCash()`, `usePayoutEmployees()` → `Map<employeeId,{name,subtitle,bankLabel:string|null}>`.
  - guard.ts: `payoutGuard`, `payoutAccess(access)` → `{canView,canConfigure,canRequest,canApprove}` (`PayoutAccess`).
  - lib.ts: `batchStatusMeta(status)`, `itemStatusMeta(status)` → `{labelKey, kind}`, `batchFeeTotal(batch)`, `batchFundsNeeded(batch)` (= totalIdr + fee), `excludedReasonKey(reason)`.
  - errors.ts: `payoutErrorKey(error)` → MessageKey (kode di atas, fallback umum).
  - Props tab: `{ legalEntityId: string; batchId?: string; access: PayoutAccess; currentUserId: string; onSelectBatch: (id: string) => void }`. Tab: `components/{runs-tab,approval-tab,status-tab,settings-tab}.tsx` ekspor `RunsTab`, `ApprovalTab`, `StatusTab`, `SettingsTab`.
B. Pengecualian finance (implementer B): `features/ws07-finance-exceptions/**`, route `routes/_kelola/kelola.akuntansi.pengecualian.tsx`, satu entri `SECTIONS` di accounting-shell.tsx, katalog `financeExceptions`. Filter di URL (kind, outletId, from, to; bawaan 14 hari terakhir Asia/Jakarta), validasi 92 hari di klien juga. Ringkasan lima kartu (klik = filter jenis, tidak dijumlah), daftar terbaru dulu, outlet null = "Seluruh PT", amount null = "Tidak tersedia", catatan payout saat filter outlet, catatan `truncated`, detail referensi (`details`), kartu di < 700px. Mock handlers + skenario.
C. Pengaturan PT (implementer C): `components/settings-tab.tsx` (+ subkomponen `components/settings-*.tsx`), katalog `payrollPayoutSettings`. Metode manual/Duitku (Duitku belum aktif: opsi nonaktif + penjelasan jalur manual), rekening sumber hanya aktif; rekening tersimpan nonaktif = banner ditolak + minta pilih aktif; batas per transfer, harian, biaya per transfer; simpan = MFA; tampilkan error server.
D. Persetujuan + Status (implementer D): `components/{approval-tab,status-tab}.tsx` (+ `components/approval-*.tsx`, `status-*.tsx`), katalog `payrollPayoutReview`. Persetujuan: dua kartu urutan (pembuat, penyetuju berbeda), tabel karyawan/rekening/gaji diterima, panel rincian: gaji diterima, metode, rekening sumber, biaya PT, total dana disiapkan; checkbox pemeriksaan; tombol "Verifikasi & setujui" (pembuat sendiri: nonaktif + alasan, tetap tampilkan error server; MFA_REQUIRED: arahkan verifikasi). Status: per karyawan dengan label teks, export manual sekali, konfirmasi transfer (bankRef, MFA+password), tandai gagal/tidak terkirim, `unknown` = penjelasan tanpa tombol bayar ulang, item dikecualikan + alasan.
Semua: mobile < 700px tabel jadi kartu, aksi utama ≥ 44px, empat kondisi. Jangan jalankan tsc/vitest/playwright (token heavy dipegang agent induk); cukup `pnpm exec prettier --write` dan `pnpm exec eslint` pada file sendiri.
