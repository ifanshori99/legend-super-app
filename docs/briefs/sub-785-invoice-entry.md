# Sub-brief 785: layar input faktur pemasok (legend-0xnm)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-ea02685f` (cabang kerja saat ini). Tanpa migrasi, tanpa ubah API/service/contract di `packages/shared/src/inventory`.
Ikuti `DESIGN.md` (Money/formatRupiah, FormField, status pill ikon+teks, tanpa warna mentah: `node scripts/ci/color.mjs`), semua teks UI lewat katalog i18n + `useT()`.

## Fakta (hasil Explore)

- Hook: `apps/web/src/features/ws06-purchasing/receiving-hooks.ts:178` `useCreateSupplierInvoice` (belum dipakai). API fn `receiving-api.ts:134` kirim `Idempotency-Key`. Mock `receiving-mock.ts:394` (create mengembalikan `match: null`; `getSupplierInvoice` mock menghitung pratinjau match untuk faktur `pending`, `:380`). API asli menyimpan `matchSnapshot` saat create.
- Kontrak: `packages/shared/src/inventory/purchasing/endpoints.ts:321` `supplierInvoiceLineInputSchema` (purchaseOrderLineId|null, kind goods|service, description, quantity decimal4, unitPriceIdr), `:330` `createSupplierInvoiceInputSchema` (outletId, supplierId, purchaseOrderId, number, invoiceDate, dueDate>=invoiceDate, lines>=1, ppnIdr, pph23Idr, idempotencyKey). Respon `SupplierInvoiceDetail` `{invoice, lines, match}` (`schemas.ts:1476`, `:1091`, `ThreeWayMatch` `:1217`, row `:1203`).
- API memvalidasi pajak: PPN <= 12% DPP; PPh23 = 0 bila tanpa baris jasa dan <= nilai jasa; server menghitung total & payable. Tidak ada endpoint dry-run.
- Pola form PO + idempotency: `components/receiving-form-page.tsx` (`useAttemptKey`, `newIdempotencyKey` dari `apps/web/src/lib/idempotency.ts`, `usePurchaseOrders`, `usePurchaseOrder`, `useReceiptLinesForOrder`). Daftar/match: `components/invoice-page.tsx` (`InvoiceDetailDialog`, `MatchStatusPill`), route `routes/_kelola/kelola.pengadaan_.faktur.tsx` (`purchasingGuard(["purchasing.invoice.match"])`, `PurchasingFrame active="invoices"`).
- Katalog i18n: `packages/shared/src/i18n/messages/` (didaftarkan di `id.ts`, contoh `ws06-receiving.ts`). E2E mock: `e2e/legend-xkk.mock.spec.ts` (helper `open`, `retry`, `captureBoth`, `e2e/screenshots.ts`), jalan `pnpm test:e2e:mock <spec>`.

## Keputusan desain (uang)

- PPN dan PPh23 diketik user persis seperti tercetak di faktur pajak pemasok (input kontrak). Web TIDAK menghitung total, DPP, PPN, payable, atau selisih sebelum simpan. Sebelum simpan tampil hanya data referensi API (qty dipesan, qty diterima/diterima-baik, harga PO) dan nilai yang diketik.
- Simpan = `useCreateSupplierInvoice` dengan satu idempotency key per percobaan form (key sama untuk retry setelah error jaringan; key baru hanya setelah sukses/ubah isi). Tombol disabled saat pending. Faktur tersimpan berstatus `pending` (belum dibukukan sebagai bayar; match dicatat di daftar faktur).
- Setelah sukses: tampil langkah "Pratinjau 3-way match" dari `getSupplierInvoice` (data API): total dari API (goods, priceVariance, services, PPN, total, PPh23, payable) + tabel per baris PO (dipesan vs diterima vs ditagih, selisih harga bp/Rp, issues) + headerIssues + status matched/discrepancy dengan toleransi. Angka tampil = angka API, apa adanya.
- Aksi lanjut: tautan ke `/kelola/pengadaan/faktur` (catat match di dialog yang sudah ada) dan "Catat faktur lain".
- Validasi: `createSupplierInvoiceInputSchema` (zod bersama) di klien, error per field via FormField; error API 4xx (mis. PPN > 12%) ditampilkan di field/summary.

## Pembagian file (tidak bertumpuk)

- A (implementer form): route baru `routes/_kelola/kelola.pengadaan_.faktur.baru.tsx` (guard sama), `components/invoice-form-page.tsx`, `invoice-entry-model.ts` (fungsi murni: default baris dari PO+penerimaan, bangun payload), katalog baru `packages/shared/src/i18n/messages/ws06-invoice-entry.ts` + daftarkan di `id.ts`, tombol "Catat faktur" di header `invoice-page.tsx` (satu sisipan kecil). Setelah sukses render `<InvoiceMatchPreview invoiceId=… />` dari B.
- B (implementer pratinjau): `components/invoice-match-preview.tsx` (export `InvoiceMatchPreview({ invoiceId })`, pakai `useSupplierInvoice`/hook detail yang ada; loading/error/sukses), teks di katalog `packages/shared/src/i18n/messages/ws06-invoice-match-preview.ts` + daftarkan di `id.ts` (B menambah baris import/spread sesudah A; bila konflik, tambah saja barisnya). Boleh pakai ulang `MatchStatusPill` dengan export dari invoice-page (satu kata `export`).
- T (test-writer): unit `tests/supplier-invoice-entry.test.mjs` atau sesuai pola root untuk `invoice-entry-model.ts` (payload lolos schema, baris default dari PO, PPh23 0 tanpa jasa tidak dihitung web), e2e mock `e2e/legend-0xnm.mock.spec.ts` (buka /kelola/pengadaan/faktur/baru, pilih PO, isi, simpan sekali, klik ganda tidak membuat 2 faktur, pratinjau tampil angka dari API, screenshot 390+1280 via `captureBoth` ke `docs/design/screenshots/legend-0xnm/`). Tulis gagal-dulu; jangan jalankan e2e (agent yang menjalankan sekali di akhir). Unit test boleh dijalankan: `heavy pnpm test` dengan `LEGEND_TEST_FILES` bila perlu, pegang token heavy sendirian.

## Bukti selesai per subagent

Lapor: file diubah, keputusan, yang belum diverifikasi. Jangan commit. Jangan jalankan tsc/build/e2e (token heavy milik agent).
