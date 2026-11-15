# Sub-brief 865: UI rekonsiliasi EDC (bead legend-khi8n)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-657a7596`, branch `ui/edc-rekonsiliasi-865`.
Mockup (disetujui founder Q5): `design/mockups/payments/edc-reconciliation/` (README.md, PNG per kondisi; baca hanya PNG layar bagianmu, desktop + mobile).
Standar: `~/.agents/team/ui-standard.md`. Konvensi: `AGENTS.md`, `docs/frontend.md` ("Typed endpoints and mock mode", "Page guard"). Pola acuan: `apps/web/src/features/ws05-payment-admin/` (api/queries/hooks/mock/components, `guard.ts`, `lib.ts`).
Jangan menjalankan tsc/vitest/build/Playwright kecuali brief bagianmu menyuruh (satu token heavy per thread, dipegang test-runner). Jangan commit.

## Fakta API (sudah ada di branch)

- `POST /api/payments/admin/edc/transactions/:id/reconciliation` (`apps/api/src/routes/payment-admin.routes.ts:201`), service `apps/api/src/services/edc-reconciliation.service.ts`. Body `resolveEdcReconciliationBodySchema` (`packages/shared/src/edc/index.ts:513`): `outcome` `approved|declined`, `evidence.source` `inquiry|terminal_receipt|bank_statement`, `evidence.note` 1–500 (tanpa nomor kartu), `approvalCode` opsional `[A-Za-z0-9]{1,12}`, `rrn` opsional `[A-Za-z0-9]{1,24}`, `chargedAmountIdr` wajib saat approved dan harus = `amountIdr`. Response `{ data: EdcTransaction }`.
- Error: `MFA_REQUIRED` (sesi tanpa MFA), `CONFLICT` (tidak menunggu rekonsiliasi; terminal masih memproses = `sale_wire_open_at` terisi; unknown < 10 menit sejak `dispatchedAt`; outcome tidak cocok status), `EDC_AMOUNT_MISMATCH`. Izin `payment.reconcile` di outlet baris (role `owner` dan `finance` punya).
- Rekonsiliasi TIDAK membukukan pembayaran; tender ECR kasir tetap satu-satunya pencatatan (copy wajib menyebut ini di konfirmasi).
- BELUM ADA endpoint GET daftar. Kita definisikan kontrak usulan + mock; backend menyusul (kartu terpisah).

## A. Kontrak + lapisan data (implementer A)

File: `packages/shared/src/payment/admin.ts` (tambah di akhir bagian EDC), `apps/web/src/features/edc-reconciliation/{lib.ts,api.ts,queries.ts,hooks.ts,mock.ts}`.

Kontrak (nama persis, dipakai bagian lain):

```ts
export const edcReconciliationQueueItemSchema = z.strictObject({
  transaction: edcTransactionSchema,          // dari ../edc/index.ts
  outletName: z.string(),
  cashierName: z.string().nullable(),
  terminalLabel: z.string(),                  // "EDC-SNP-02 · BCA"
  billNumber: z.string().nullable(),          // "INV-1511-084"
  remainingIdr: idrSchema.nullable(),         // sisa tagihan
  saleWireOpenAt: isoDateTimeSchema.nullable(),
});
export type EdcReconciliationQueueItem
export const listEdcReconciliationQueue = defineEndpoint({ method:"GET", path:`${ADMIN}/edc/reconciliation-queue`,
  query: cursorPageQuerySchema + { outletId?: uuid, status?: edcTransactionStatus, q?: string max 100 }, response: cursorPageSchema(item) })
export const resolveEdcReconciliation = defineEndpoint({ method:"POST", path:`${ADMIN}/edc/transactions/:id/reconciliation`,
  params: resolveEdcReconciliationParamsSchema, body: resolveEdcReconciliationBodySchema, response: dataResponseSchema(edcTransactionSchema) })
```

Ikuti gaya file (clientInputSchema/strict, komentar singkat yang menandai GET sebagai kontrak usulan legend-khi8n, backend belum ada).

`lib.ts` (murni, tanpa `@/`, tanpa React; diimpor test node): `EDC_RECON_WAIT_MS = 10*60*1000`; `reconciliationGate(item, nowMs)` → `{ kind: "wire-open" } | { kind: "too-early"; eligibleAtMs: number } | { kind: "not-eligible" } | { kind: "open"; outcomes: ("approved"|"declined")[] }`, meniru service persis (baca service: eligibility, lock wire, 10 menit, outcome yang boleh per status). Juga `ageMinutes(item, nowMs)` (sejak `createdAt`).

`api.ts`/`queries.ts`/`hooks.ts`: pola ws05. Ekspor: `edcReconciliationQueueQuery(filters)`, `useEdcReconciliationQueue(filters: { outletId?: string; status?: string; q?: string })`, `useResolveEdcReconciliation()` (mutation `{ id, body }`, invalidasi queue). Header idempotensi/attempt-key bila endpoint ws05 sejenis memakainya.

`mock.ts` (registerMock kedua endpoint, data contoh Cafe Legend sesuai mockup): EDC-1048 unknown flagged 42 mnt Senopati Dimas Rp425.000; EDC-1052 approved flagged Kemang Rani Rp280.000; EDC-1057 declined flagged Senopati Sari Rp175.000; EDC-1061 unknown `saleWireOpenAt` terisi 2 mnt Kemang Rani Rp320.000; satu unknown TANPA flag dispatched 4 mnt (terlalu dini). Mock resolve meniru aturan `lib.ts` + `EDC_AMOUNT_MISMATCH` + menghapus baris dari antrean. Skenario `?mock=empty|error` lewat `paginateFixture`.

## B. Daftar (implementer B)

File: `apps/web/src/features/edc-reconciliation/components/{queue-page.tsx,queue-list.tsx}`, katalog `packages/shared/src/i18n/messages/edc-recon-queue.ts` (sudah di-mount sebagai `edcRecon.queue`). PNG: `edc-reconciliation-*.png`, `empty-*`, `error-*`.

- `EdcReconciliationPage` (ekspor dari queue-page.tsx): breadcrumb Pembayaran / EDC / Rekonsiliasi, judul "Rekonsiliasi EDC", subjudul, band info izin+MFA, filter (cari, outlet, status terminal, Muat ulang), kartu "Transaksi ditandai" + jumlah + catatan umur, lalu detail dari bagian C untuk baris terpilih.
- State URL lewat `useSearch({ strict: false })` + `useNavigate()`: `tx`, `outletId`, `status`, `q`. Mobile (< md): bila `tx` terisi, daftar disembunyikan, tampil tombol "Kembali ke daftar".
- Desktop tabel (Transaksi/outlet, Kasir, Nominal `<Money>`, Jam WIB, Status terminal badge berteks + ikon, Umur, tombol "Periksa"); mobile kartu berlabel. Baris unknown tanpa flag yang belum 10 menit tetap tampil dengan status "Belum bisa diperiksa" + kapan bisa.
- Kondisi: skeleton seukuran tabel, kosong (penjelasan + Muat ulang), error (apa yang salah + Coba lagi), sukses. Badge `common.sampleData` saat `API_MOCK`.
- Impor detail: `import { EdcReconciliationDetail } from "./detail"` dengan props `{ item: EdcReconciliationQueueItem; onResolved: () => void }` (dibuat C).

## C. Detail + penyelesaian (implementer C)

File: `apps/web/src/features/edc-reconciliation/components/{detail.tsx,resolve-form.tsx,confirm-dialog.tsx}`, katalog `packages/shared/src/i18n/messages/edc-recon-resolve.ts` (di-mount `edcRecon.resolve`). PNG: `detail-*`, `waiting-*`, `confirmation-*`, `save-error-*`, `success-*`.

- `EdcReconciliationDetail({ item, onResolved })`: kepala (ID, badge, outlet · kasir · waktu, umur), kiri "Ringkasan & bukti" (nominal permintaan, sisa tagihan, tagihan, terminal, peringatan unknown, struk terminal dari field transaksi: nominal, trace, RRN, kode persetujuan, kartu masked, hasil; `<details>` "Lihat jejak terminal": status, responseCode, message, inquiryCount, dispatchedAt), kanan form.
- Form: radio Approved · Disetujui / Declined · Ditolak (hanya outcome dari `reconciliationGate`), Sumber bukti (select 3 nilai), Nominal pada bukti (hanya approved, `inputmode="numeric"`, harus = nominal), Kode persetujuan & RRN opsional, Catatan pemeriksaan wajib ≤ 500. Validasi saat blur dan kirim, pesan di dekat field. Tombol "Tinjau penyelesaian".
- Gate `wire-open`: kontrol nonaktif + band "Terminal masih memproses…"; `too-early`: nonaktif + "Bisa diperiksa pukul HH.MM"; `not-eligible`: pesan.
- Dialog (komponen `components/ui/dialog`): ringkasan, peringatan "tidak langsung melunasi tagihan, pencatatan mengikuti proses kasir", checkbox wajib, tombol "Kembali periksa" / "Selesaikan approved|declined". Kirim → bila `MFA_REQUIRED`/`REAUTH_REQUIRED` tangkap dengan `useStepUp` + `VerifyPanel` dari `features/ws10-payroll-payout/components/approval-verify.tsx` di dalam dialog, lalu ulangi. Error lain (CONFLICT, EDC_AMOUNT_MISMATCH, jaringan) tampil di dialog, form tidak hilang. Sukses: status sukses (aria-live) lalu `onResolved()`.

## D. Route + pintu masuk (implementer D)

File: `apps/web/src/routes/_kelola/kelola.pembayaran_.edc-rekonsiliasi.tsx`, `apps/web/src/features/edc-reconciliation/guard.ts`, `apps/web/src/features/ws05-payment-admin/components/edc-panel.tsx` (tambah link "Rekonsiliasi transaksi" ke halaman baru, hanya bila pemegang `payment.reconcile`), `apps/web/src/routeTree.gen.ts` (regenerasi seperti biasa proyek).

- Guard: `paymentAdminGuard(["payment.reconcile"])` (beforeLoad, `notFound()`); `validateSearch` zod untuk `tx`, `outletId`, `status`, `q` (semua opsional, string pendek). Loader seperti `kelola.pembayaran.tsx` (lewati prefetch saat mock).

## E. Test (test-writer)

`tests/edc-reconciliation-gate.test.mjs` (node:test atas `lib.ts`: wire-open, too-early 9:59 vs 10:00, not-eligible, outcome per status, gagal-dulu sebelum lib ada), `e2e/edc-reconciliation.mock.spec.ts` (pola `e2e/finance-exceptions.mock.spec.ts`: daftar, empty/error, detail, terkunci wire, dialog + checkbox, sukses, 390 px tanpa scroll horizontal), `scripts/ui-check-edc-reconciliation.mjs` (pola `scripts/ui-check-payout-finance.mjs`: axe desktop + 390, tiap kondisi). Jangan jalankan suite; laporkan perintahnya.
