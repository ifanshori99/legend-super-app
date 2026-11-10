# Hasil Codex 150: second opinion EDC PAN scrub (G7mxn, 9 Nov 15:14)

Range read-only `3143577d..d25cf41b` di `ws/edc-pan-scrub`. Test terarah 36/36 lulus. Dua skenario gagal direproduksi di PostgreSQL 17 disposable dan parser JS. Belum diuji: deploy cloud/edge nyata, jalur HTTP POS/error handler.

## Temuan
- **P1, `apps/api/drizzle/0113_edc_pan_scrub.sql:60`**: pola hanya menerima satu pemisah. `4111  1111  1111  1111` bertahan utuh di `message`, `rrn`, dan `masked_pan` setelah migrasi. Query deteksi dan read scrub juga melewatkannya; seluruh test tetap hijau. Tangani pemisah berulang/gabungan (mis. `[ -]*`) konsisten di SQL, JS, dan deteksi.
- **P2, `docs/runbooks/edc-pan-scrub.md:103`**: instruksi manual tidak mewajibkan transaksi tunggal. Menjalankan file dengan autocommit lalu gagal saat UPDATE meninggalkan FORCE RLS nonaktif (direproduksi: `relforcerowsecurity=false`). Wajibkan `psql -1 -v ON_ERROR_STOP=1` atau transaksi eksplisit.
- **P2 celah test, `apps/api/src/test/edc-pan-scrub-migration.test.ts:38` dan `apps/api/src/test/edc-pan-logs.test.ts:63`**: oracle memakai ambang 13+ global, sehingga PAN 12 digit lolos pemeriksaan bebas PAN. Pakai ambang per kolom, tambah fixture batas panjang dan pemisah berulang.
