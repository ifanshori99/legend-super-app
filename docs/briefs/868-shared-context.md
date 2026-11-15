# 868 konteks bersama (engineer, uang/akses)

Brief asli: docs/briefs/868-edc-recon-list-api.md. Kartu legend-p98qi.

## Keputusan desain (jangan ubah kontrak shared)
- Endpoint: `GET /api/payments/admin/edc/reconciliation-queue`, kontrak `listEdcReconciliationQueue` di `packages/shared/src/payment/admin.ts:750`. Kontrak TIDAK diubah (tidak ada field aksi). Aksi yang diizinkan diturunkan klien dari field yang dikembalikan lewat `apps/web/src/features/edc-reconciliation/lib.ts` `reconciliationGate` (status, needsReconciliation, saleWireOpenAt, dispatchedAt). Jadi API wajib mengembalikan field itu apa adanya dan benar.
- Isi daftar: `edc_transactions` dengan `type='sale'` DAN (`needs_reconciliation = true` ATAU `status='unknown'`). Baris unknown tanpa flag yang belum 10 menit sejak `dispatched_at` TETAP ikut (klien menampilkan terkunci); aturan 10 menit: `edge/edc/late-response.ts` `lateResponsePossible`. Baris yang sudah selesai (flag false, status bukan unknown) tidak ikut.
- Akses: router `payment-admin.routes.ts`, pakai guard `reconcileQuery` (payment.reconcile, outlet dari query bila ada; lihat :65, :345, :375). Tanpa izin: 403. Filter tenant + outlet-scope di SQL: `context.outletScope`, pola `outletIn()` di `services/accounting-cash-deposits.service.ts:80-89` (daftar outlet kosong = FALSE). Outlet di luar scope tidak boleh bocor (jangan 200 dengan baris outlet lain).
- Filter query: outletId, status, q (cari di reference/invoiceNo/billNumber/terminal; trim, maks 100), cursor page (`cursorPageQuerySchema`, strict). Urut stabil (createdAt desc, id desc) dengan cursor.
- Item: `transaction` lewat `toDto` (edc-reconciliation.service.ts:65, re-apply filter data kartu; tidak ada PAN penuh, `idempotencyKey` sudah bagian dari schema transaksi yang ada, jangan tambah field baru), `outletName`, `cashierName` (null bila tak ada), `terminalLabel` ("TERMINAL · BANK"), `billNumber` (= `orders.number` untuk `orders.number = reference` di outlet yang sama, null bila tak ketemu), `remainingIdr` (`remainingIdr(order, tendersOf(...))` di `services/pos-order-support.ts`, null bila bill tak ketemu), `saleWireOpenAt` (kolom `sale_wire_open_at`).
- Kode baru di service baru atau file `edc-reconciliation.service.ts` (fungsi `listEdcReconciliationQueueForActor`); route tipis di payment-admin.routes.ts. Jangan sentuh logika POST resolve (uang).
- Web: `features/edc-reconciliation/{api,queries,hooks}.ts` SUDAH memanggil endpoint lewat layer bertipe; mock hanya aktif dengan `VITE_API_MOCK=true`. Tugas web: pastikan tanpa flag mock layar membaca API nyata, tidak ada import mock di jalur produksi, e2e `e2e/edc-reconciliation.mock.spec.ts` tetap hijau (jangan diubah).

## Test (vitest API, `apps/api/src/test/edc-reconciliation-queue.test.ts`, pola `edc-reconciliation.test.ts`)
Gagal-dulu karena endpoint belum ada (404), bukan karena setup. Wajib:
1. Isolasi tenant: baris tenant lain tidak muncul.
2. Isolasi outlet: pengguna dengan payment.reconcile hanya di outlet A tidak melihat baris outlet B; `outletId` query di luar scope tidak membocorkan.
3. Role tanpa payment.reconcile: 403; tanpa sesi: 401.
4. Baris unknown <10 menit sejak dispatched_at: ada di daftar dengan status unknown + dispatchedAt, dan POST resolve untuk baris itu ditolak CONFLICT (terkunci); unknown >10 menit tanpa flag: ada di daftar dan POST (declined) diterima.
5. Parity aksi per status: untuk approved+flag, declined/cancelled/failed+flag, unknown, tiap hasil POST (approved/declined) cocok dengan `reconciliationGate`-nya (declined/cancelled/failed hanya declined; approved hanya approved-clear). saleWireOpenAt terisi: daftar menampilkannya dan POST ditolak.
6. Baris selesai (flag false, status approved/declined) dan type bukan sale tidak ikut.
7. Tidak ada PAN penuh: seed baris dengan message/invoiceNo berisi 16 digit; respons tidak memuat 13 sampai 19 digit beruntun, `maskedPan` bermask.
8. Pagination: limit + cursor tidak menggandakan/melewatkan baris; query tidak valid (limit 0, field tak dikenal) = 422/400 sesuai pola.
9. Label: outletName, terminalLabel, billNumber, remainingIdr benar untuk bill yang ada; null untuk bill yang tak ada.
Brand id: pakai helper bertipe, bukan `as`. Path test relatif `src/test/...`. Jalankan terarah: `LEGEND_TEST_FILES="src/test/edc-reconciliation-queue.test.ts" pnpm test`.
