# oa0qk lanjutan: kirim ke dapur setelah ends_at ditolak (keputusan CTO)

Worktree: `.worktrees/breakfast-pay`, cabang `ws/breakfast-pay`. Brief induk: `docs/briefs/sub-oa0qk-breakfast-pay.md`.
Perintah berat (tsc, vitest, playwright, db:generate) wajib lewat `heavy`. Jangan commit, jangan push, jangan `git stash`.

## Keputusan CTO

1. Sarapan yang dikirim ke dapur pada atau setelah `access_tickets.ends_at` ditolak, di API dan di trigger DB, walau worker sempat mati. Order dibatalkan dan refund penuh diajukan (sama dengan aturan uang telat). Test gagal-dulu.
2. Refund sarapan tidak boleh pakai teks QR atau `system:qr`. Pakai sumber facility: aktor `system:facility` (sudah ditambah di `packages/shared/src/payment/admin.ts`, konstanta `FACILITY_SYSTEM_ACTOR` di `facility-breakfast-money.ts`, double-payment lewat `requestQrDoublePaymentRefund(..., source)`). Sudah dikerjakan engineer.
3. `refunded_idr` naik saat refund diajukan: diterima, tidak diubah.
4. PB1: jangan dikerjakan.

## A. API (implementer A). File: `apps/api/src/services/facility-breakfast-money.ts`, `facility-breakfast.service.ts`, `facility-breakfast-consumers.ts`

- `fireBreakfastOrderTx`: query tiket ambil juga `endsAt`. `ended = ticket && at >= ticket.endsAt` (`at` = waktu fakta dari `lockIntentsForFact`). Bila `ticketDead || ended || balance.reserved > 0n`: `cancelBreakfastOrderTx` dengan reason `ticket_closed` / `ticket_ended` / `refund_committed`. Tambah outcome `"ended"` ke `BreakfastFireOutcome` (dipakai bila ended dan tiket tidak dead).
- `fireBreakfastOrderByStaff`: bila outcome `ended`, transaksi tetap commit (batal + refund tersimpan), lalu lempar `FacilityError("BREAKFAST_UNAVAILABLE")` (422) SETELAH commit. Pola sama dengan `payBreakfastOrderForMember` (return null di dalam tx, throw di luar, baris ~649 dan ~695).
- `fireDueBreakfastOrders`: hitung `ended` sebagai cancelled. Perbarui komentar kepala file consumers.
- Refund penuh = `cancelBreakfastOrderTx` (maks `paid_idr - refunded_idr`). Jangan ubah aturan itu.

## B. Trigger (implementer B). File: migrasi baru `apps/api/drizzle/0322_facility_breakfast_fire_window.sql`, `meta/_journal.json`, snapshot `meta/0261_snapshot.json`, mirror di `.custom.sql` yang memuat `app.breakfast_order_unpaid` (cari dengan grep di `apps/api/src/db/schema/`)

- `CREATE OR REPLACE FUNCTION app.breakfast_order_unpaid(p_tenant uuid, p_order uuid)`: tetap SECURITY DEFINER, `SET search_path = pg_catalog`, STABLE. Syarat lolos ke dapur jadi: baris linked `status = 'fired'`, `paid_at IS NOT NULL`, `fired_at IS NOT NULL`, dan `fired_at < access_tickets.ends_at` (join `public.access_tickets a ON a.tenant_id = f.tenant_id AND a.id = f.access_ticket_id`). Tiket hilang = tidak lolos. Pakai `fired_at`, bukan `now()`, supaya deterministik (test memakai jam suntikan).
- Grant tetap (CREATE OR REPLACE mempertahankan grant; tulis ulang GRANT bila ragu).
- Ikuti pola 0321 untuk entri journal (idx 261) dan snapshot (salin 0260, id baru, prevId = id 0260). `heavy pnpm --filter @starter/api db:generate` harus "No schema changes".
- Terapkan ke DB test worktree ini seperti cara test biasa memigrasi (lihat `apps/api` script/README); laporkan cara yang dipakai.

## C. Test (test-writer). File: `apps/api/src/test/facility-breakfast-pay.test.ts` (describe baru `BRK-PAY-07`), helper boleh ditambah di `facility-breakfast-helpers.ts`

1. Order lunas, worker mati sampai ends_at lewat: sweep `fireDueBreakfastOrders` dengan `now >= ends_at` tidak membuat kitchen ticket, order `cancelled`, satu refund request = total dibayar penuh, `requested_by = 'system:facility'`, teks reason tanpa "QR". Sweep diulang: tidak ada refund kedua, `order.paid` tidak tertulis.
2. Staff "Kirim sekarang" setelah ends_at: 422 `BREAKFAST_UNAVAILABLE`, tanpa kitchen ticket, order `cancelled`, refund penuh tetap tersimpan (commit walau error). Ulang: tetap tanpa refund kedua.
3. Trigger: lewat koneksi owner, set baris linked `fired` dengan `paid_at` dan `fired_at >= ends_at`, lalu INSERT kitchen_tickets dan kitchen_ticket_items → ditolak 23514 constraint `kitchen_tickets_breakfast_paid`. Kontrol `fired_at < ends_at` lolos.
4. Refund double-payment / late / cancel sarapan: `requested_by = 'system:facility'` dan reason tanpa "QR" (tambah assert di test BRK-PAY-02/03 yang ada).

- Cara memajukan waktu: ubah `access_tickets.ends_at` ke masa lalu lewat `asOwnerTenant`, atau `now` suntikan. Lihat test BRK-PAY-05 dan BRK-PAY-01 sebagai contoh.
- Jalankan: `LEGEND_TEST_FILES=src/test/facility-breakfast-pay.test.ts heavy pnpm --filter @starter/api test` (atau pola yang dipakai repo). Laporkan mana yang merah sebelum A/B selesai (bukti gagal-dulu) dan hijau sesudah.

## D. Screenshot review UI (subagent screenshot). Output: `design/screens/review-q60/`

- Pakai mode mock web (lihat `apps/web/src/features/facility/mock.ts`, `settleBreakfastPaymentInMock`) dan contoh `design/screens/ui-mixed-q36/shots.mjs`.
- Layar HP 390x844: (1) bagian sarapan di tiket dengan tombol "Bayar sarapan" (status menunggu bayar), (2) halaman `/bayar/$token` sarapan, (3) bila mudah: status lunas sesudah bayar. Tambah 1280 bila murah.
- Dev server maks 2 di seluruh Mac; cek `ps` dulu, matikan server sendiri setelah selesai. Playwright lewat `heavy`.
- Simpan skrip di `design/screens/review-q60/shots.mjs`, PNG di folder yang sama, plus `README.md` pendek: layar apa, cara buat ulang.

## E. PB1 sarapan (founder Q59, test-writer 2). File baru: `apps/api/src/test/facility-breakfast-tax.test.ts` (helper boleh ditambah di `facility-breakfast-helpers.ts` hanya fungsi baru di akhir file)

Fakta: `createBreakfastOrderForMember` sudah memakai mesin pajak POS (`computePosBill` + `loadPosTaxConfig`, `facility-breakfast.service.ts:452`), menyimpan `taxIdr` dan `taxResult`; fire memanggil `recordTaxSnapshots`; jurnal `order.paid` membaca kolom `orders` (`accounting-auto-journal-amounts.ts:862-889`). Outlet harga-termasuk-pajak ditolak fail-closed (`QR_ORDER_INCLUSIVE_TAX_UNSUPPORTED`), sama dengan POS dan QR. Tugas: buktikan dengan test, laporkan celah nyata.

1. Eksklusif (world bawaan: PBJT 10%): total order = harga + PB1 sesuai config; intent dibayar = total itu; klien tidak bisa mengubah.
2. Fire: baris `tax_snapshots` (atau nama tabel sebenarnya) ada untuk order; jurnal `order.paid` memuat baris pajak keluaran = `taxIdr` dan pendapatan = total - pajak. Cari test jurnal QR yang sudah ada sebagai contoh assert.
3. Outlet dengan `prices_include_tax`/aturan inklusif: buat order sarapan ditolak, tidak ada intent/uang ditarik.
4. Refund: batal setelah bayar → refund = dibayar (termasuk PB1), tidak lebih. Refund sebagian penjualan sarapan yang sudah fired lewat jalur WS-05 (cari bagaimana test QR melakukannya): jurnal refund membalik PB1 proporsional dan total refund tidak melebihi bayar. Bila jalur ini tidak ada untuk facility, laporkan sebagai celah dengan bukti.
- Bukti gagal-dulu: setelah hijau, mutasi sementara (mis. `taxIdr: idr(0)` di insert, atau buang `recordTaxSnapshots`) harus membuat test merah; kembalikan mutasinya, laporkan.
- Jalankan: `LEGEND_TEST_FILES="src/test/facility-breakfast-tax.test.ts" heavy pnpm test` dari root worktree.

## F. Mock bayar sarapan (implementer web). File: `apps/web/src/features/facility/mock.ts`, `apps/web/src/features/ws05-payment/mock.ts` (dan fixture terkait bila perlu), tanpa ubah kode non-mock

- Masalah (dari screenshot): token `pl_mock_*` dari mock pay sarapan tidak terdaftar di store payment-link mock, jadi `/bayar/$token` "Tautan pembayaran tidak ditemukan"; status lunas tak tercapai karena `settleBreakfastPaymentInMock` tidak pernah dipanggil.
- Perbaikan: saat mock pay sarapan membuat token, daftarkan payment link mock dengan tagihan sarapan (baris menu, PB1, total sama dengan order). Saat link itu dibayar di halaman mock `/bayar`, panggil `settleBreakfastPaymentInMock` sehingga tiket menampilkan status lunas.
- Bukti: `node --test tests/legend-ijv8-breakfast.test.mjs` hijau, typecheck web lewat `heavy`, lalu jalankan ulang `design/screens/review-q60/shots.mjs` (dev server sendiri, port 3262, matikan setelahnya) dan ganti PNG 02 dengan halaman bayar sarapan asli, tambah `04-tiket-lunas-{390,1280}.png`. Hapus PNG 03 bila tak relevan. Perbarui README folder.
