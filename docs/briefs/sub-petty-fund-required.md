# Sub-brief: dana kas kecil wajib sebelum petty purchase (Q8 founder 13 Nov 2026, tingkat K uang)

Aturan: outlet tanpa dana kas kecil DITOLAK saat mencatat petty purchase. Kode baru `PETTY_CASH_FUND_REQUIRED` (AccountingError, HTTP 422), pesan Indonesia: "Outlet ini belum punya dana kas kecil. Buat dana dulu di layar Kas kecil." Saldo kurang tetap `PETTY_CASH_INSUFFICIENT`.

Fakta kode (hasil Explore):
- `apps/api/src/services/accounting-petty-cash.service.ts:597-629` `drawPettyCashForPurchase`: `if (!fund) return;` (baris 612) = perilaku lama. Ubah jadi throw `AccountingError("PETTY_CASH_FUND_REQUIRED")`. Dipanggil dari `petty-purchase.service.ts:315` satu transaksi dengan insert (:296) -> rollback otomatis, tanpa baris petty_purchases/jurnal/ledger. Update komentar docstring.
- Kode error: `packages/shared/src/accounting/errors.ts` (status map ~:99, defaultMessages ~:178), `packages/shared/src/accounting/banking.ts` (daftar kode petty), `apps/web/src/features/ws07-cash-bank/lib.ts` + mock.ts memetakan kode ke teks UI.
- Test helper dana: `accounting-petty-cash.test.ts:154 fundWith(outletId, amt)` (lokal, POST topup 201). cash-bank-world.ts tidak punya pembuat dana.
- Test bergantung perilaku lama (beri fixture dana, JANGAN longgarkan asersi): `petty-purchase.test.ts` (PP-1..PP-8 semua record), `purchase-return-petty-e2e.test.ts` (PRE-2 :715 outletC, mungkin PRE-3, postPetty :408), `accounting-petty-cash.test.ts` PC-23 :905 (asersi perilaku lama 201 tanpa dana -> balik jadi 422 PETTY_CASH_FUND_REQUIRED).
- Tenant/outlet lain: tenantB di petty-purchase.test.ts:34; outletB + outletBManager.

Test gagal-dulu yang diwajibkan (uang): (a) outlet tanpa dana -> 422 PETTY_CASH_FUND_REQUIRED, 0 baris petty_purchases, 0 petty_cash_entries, 0 jurnal; (b) dana cukup -> 201, saldo turun tepat sebesar total, entri kind=purchase; (c) saldo kurang -> 422 PETTY_CASH_INSUFFICIENT, tidak ada baris; (d) dana outlet A tidak dipakai belanja outlet B (B tanpa dana ditolak); tenant lain ditolak/tidak melihat dana.

## Bagian web + teks (hasil Explore)
- Aksi: `apps/web/src/features/ws06-purchasing/components/petty-page.tsx` tombol "Pembelian baru" :396-400 (hanya bila `canCreate`), empty-state :450; error submit `setFormError(t(receivingErrorKey(error.code)))` :188-197, tampil :307.
- Peta kode->kunci teks: `receiving-lib.ts:243-265` (`ERROR_KEYS`; kode tak dikenal jatuh ke `inventoryReceiving.errors.action`; hanya `PETTY_PURCHASE_LIMIT_EXCEEDED` dipetakan). Tambah `PETTY_CASH_FUND_REQUIRED` DAN `PETTY_CASH_INSUFFICIENT` (saldo kurang: pesan jelas "Saldo kas kecil outlet tidak cukup untuk pembelian ini.").
- Katalog teks: `packages/shared/src/i18n/messages/ws06-receiving.ts` objek `errors` (`pettyLimit` :38 contoh). Semua teks lewat katalog; `node --test tests/text-contract.test.mjs` harus hijau (tanpa teks hardcode di UI).
- Dana per outlet di web: `usePettyCashFunds(legalEntityId)` (`ws07-cash-bank/api.ts:342`, `queries.ts:296`). Layar Kas kecil: `/kelola/akuntansi/kas-bank`. Layar belanja kecil: `/kelola/pengadaan/kecil`.
- Tampilkan alasan di layar belanja kecil bila outlet terpilih belum punya dana (banner/notice + tautan ke Kas kecil; tombol tetap bisa diklik atau dinonaktifkan dengan alasan; error server tetap dipetakan sebagai cadangan). Pesan katalog: "Outlet ini belum punya dana kas kecil. Buat dana dulu di layar Kas kecil."
- Test web: `tests/*.test.mjs` (mis. ws06/ws07 text/lib tests) + `e2e/legend-xkk.mock.spec.ts` (mock; jangan ubah baseline visual).

## Perbaikan test (temuan reviewer, test-writer)
1. `purchase-return-petty-e2e.test.ts` `fundOutletC` (:416-440) membuat bank_accounts, petty_cash_funds, petty_cash_entries, akun 1103; `afterAll` (:573-681) tidak menghapusnya (replica role skip FK). Tambah DELETE petty_cash_entries, petty_cash_funds, bank_accounts (tenant + entity) sebelum hapus chart/outlet.
2. PC-27 (`accounting-petty-cash.test.ts`) dan PP-10 (`petty-purchase.test.ts`): bukti tenant lain harus nyata: buat dana di entity/outlet tenant lain (`world.foreign` / tenantB) dan assert (a) tidak muncul di listFunds tenant A, (b) petty purchase tenant A ke outlet nyata tenant lain ditolak (403/404/422 spesifik, tanpa baris baru, saldo dana tenant lain tak berubah). Hapus fixture itu di afterAll.
3. PRE-2: assert tidak ada event outbox (domain_event_outbox) pada penolakan, seperti PC-23.
Jangan longgarkan asersi lama. Jangan jalankan test (test-runner nanti).

## Isolasi test antar file (flaky, akar masalah ditemukan CTO)
Tiga file test petty jalan paralel di tenant Cafe Legend yang sama. Bukti: run 3 file bersama gagal acak (PC-11 `PETTY_PURCHASE_LIMIT_EXCEEDED` 409, PC-12 `expected 10 to be 9`, PRE-2 `expected 4 to be 3`, PP-6 `12 vs 11`); tiap file sendirian hijau. Akar:
- `petty-purchase.test.ts` `deletePolicies()` (:152-157, juga :324) dan `afterAll` `DELETE FROM petty_purchases WHERE tenant_id` menghapus baris milik file lain (policy outlet segar accounting-petty-cash) -> 409 limit.
- Hitungan tenant-wide: `recordedEventCount()` di accounting-petty-cash.test.ts:295 (domain_event_outbox tenant-wide), `purchaseCount()` petty-purchase.test.ts:198, hitungan jurnal PRE-2.
Tugas: batasi setiap DELETE dan hitungan itu ke baris yang dimiliki file itu sendiri (outlet_id IN (outlet milik file) / id yang dibuat file / payload outlet), tanpa melonggarkan asersi (tetap harus menangkap kebocoran ke outlet B/tenant lain DI DALAM scope file: mis. purchaseCount gabungan outletA+outletB milik file). JANGAN ubah perilaku produk. Bukti: tiga file bersama 3x berturut hijau (test-runner, bukan kamu).
