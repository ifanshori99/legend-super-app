# Brief: fix/codex-money (legend-eh9i4, legend-5i6k1)

Branch base: ws/payment-link-cancel 1f0247da + merge origin/fix/money-journal-refund c660fd6b. Keputusan CTO sudah final.

## Kartu A (legend-eh9i4) — QRIS DP hold
A1. `apps/api/src/services/payment.service.ts` (~baris 2611): jalur polling/status-check melewati cek hold. Contoh: QR Rp33.000, webhook hilang, status paid Rp36.000 -> kini capture 33.000 + parkir 3.000. Benar: seluruh Rp36.000 diparkir (QH-13: nominal salah tidak menutup hold). Pindahkan cek hold ke jalur settlement bersama (webhook DAN polling) di bawah lock yang sama.
A2. `apps/api/drizzle/0419_pos_qris_holds.sql` (~baris 93): backfill hanya tender POS. Tambah backfill intent QRIS tamu (split) dan gagalkan migrasi bila ditemukan >1 QR collectible per tagihan. 0419 belum di m1: edit di tempat, JANGAN nomor baru. Jaga drizzle/meta konsisten (`db:generate` harus kosong).

## Kartu B (legend-5i6k1) — jurnal
`apps/api/src/services/accounting-journal.service.ts` (~baris 620): perlindungan akun pajak/service charge harus memakai gabungan peta akun saat ini DAN historis. Contoh: penjualan pajak ke akun A, lalu mapping PBJT dan customer_deposit ke B -> refundGateway Rp100.000 kini lolos mengkredit akun pajak B; harus diparkir `ACCOUNT_MAPPING_MISSING`. Referensi test serupa: `apps/api/src/test/accounting-refund-payout-map-race.test.ts`.

## Aturan uang
Test gagal-dulu dengan skenario di atas. Buktikan: tidak ada pihak dibayar lebih, outlet tidak rugi, uang diparkir tepat sekali.

## Batas
Hanya heavy-holder (test-runner) yang menjalankan tsc/vitest. Jangan pkill, jangan merge ke m1, jangan deploy. Test file baru di `apps/api/src/test/`.
