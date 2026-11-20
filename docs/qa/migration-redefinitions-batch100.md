# Penilaian redefinisi migrasi batch98-100 vs milestone/m1 (20 Nov)

`node scripts/check-migration-redefinitions.mjs --base milestone/m1` (dari int/batch101) melaporkan 17 baris LOST, semuanya di fungsi payout yang sengaja didefinisikan ulang:

- 0506 `app.payout_recon_clear_approve/2`: cek advisory lock per database (0503:97-106) diganti guard episode lock SO 1173. Disengaja.
- 0506 `app.payout_recon_flag/5`: dedupe reason `left(p_reason,200)` (0473:43,50) diganti bentuk SO 1173. Disengaja.
- 0509 `app.payout_recon_hold_unwritten/5`: tanda tangan `RETURNS void` (0507:81) diganti hasil hold release 1192. Disengaja.
- 0510 `app.payout_grant_issue/11`: daftar kind detail (0472:221-222) diperluas untuk hold release 1192. Disengaja.

Keputusan CTO: migrasi yang sudah diterapkan tidak diedit untuk menambah anotasi `-- redefine-drops:` (aturan: jangan menulis ulang migrasi terapan). Sesudah batch100 mendarat di m1, base pemeriksaan berikut sudah memuat definisi ini, jadi baris ini tidak muncul lagi. Migrasi baru wajib memberi anotasi sendiri.
