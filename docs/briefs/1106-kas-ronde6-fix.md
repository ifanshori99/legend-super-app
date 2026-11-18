# 1106 Perbaikan kas/payout ronde 6 (tingkat K uang)
Peran: engineer (`~/.agents/team/roles/engineer.md`). Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: `ghostex/cek-kas-1102-pinjaman-reimburse-supplier` (head f3e7c14eb), worktree yang sama dengan 1091. Push tanpa `--force`.
Laporan SO: `docs/qa/second-opinion-kas-payout-ronde6-1105.md` (P1-1, P1-2; lokasi, skenario, usul test ada di sana).

## Keputusan CTO (sudah diambil, aturan yang membatasi)
1. P1-1 net legacy NULL: `app.payout_waive_skipped` dan pemeriksaan deferred MENOLAK waive bila `settle_net_idr IS NULL` (fail closed). Tidak ada backfill net legacy di rilis 1: cadangan baris legacy tetap tertahan; finance menyelesaikan manual di luar sistem. Endpoint waive mengembalikan 409 kode jelas (mis. `PAYOUT_WAIVE_LEGACY_NET_UNKNOWN`).
2. P1-2 kunci: fungsi trusted mengambil entity advisory `acc-cashbank` dengan key dan urutan yang sama dengan jalur TS (`payroll-payout-gl.service.ts:1377`), SEBELUM advisory batch/posting, ditahan sampai commit.
3. Migrasi: 0691 sudah di-push. Bila 0691 belum masuk cabang `int/batch*` mana pun (`git branch -a --contains <commit 0691>`), boleh edit di tempat; bila sudah, buat 0692. Lapor pilihannya.

## Bukti
- Test usul SO: fixture legacy NULL sealed net Rp100.000, jurnal Rp1 + waive sebagai `legend_app` -> gagal, kind tetap skipped, tersedia Rp0. Dua koneksi + barrier untuk retry supplier vs waive: B menunggu A, A tetap menolak, GL tidak negatif; variasi kasbon + reimburse.
- Merah di f3e7c14eb, hijau di head. Regresi r1/r2/fixed-asset dan subset `payroll-payout-*`. Typecheck API, prettier/eslint, `db:generate` kosong.
- Subagent architect effort xhigh: review diff akhir (sekali).

## Laporan
Hasil per temuan, berkas, commit, head SHA, risiko. Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Jangan lapor kabar antara (tunggu job dengan Monitor, lapor sekali).
