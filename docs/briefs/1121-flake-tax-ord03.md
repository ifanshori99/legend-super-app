# 1121 Flake tax-api ORD-03 (legend-u79df, tingkat S)
Peran: engineer kartu S (`~/.agents/team/roles/engineer.md`). Codex. Langkah pertama: spawn subagent paralel (baca test + service, cari sumber race).
Base `origin/milestone/m1` (4418628e0). Cabang `ws/1121-flake-tax-ord03`. Push tanpa `--force`. Tanpa migrasi, tanpa ubah kode produk kecuali akar masalah ada di sana (lapor dulu).
Gejala: `apps/api/src/test/tax-api.test.ts` ORD-03 gagal di full run beban tinggi (`expected 409 to be 422`), batch90 dan batch91; lulus 13/13 terarah. Cari ketergantungan urutan/waktu/data bersama (tanggal, unik, transaksi belum commit, test lain menulis data sama). Perbaiki dengan isolasi data atau tunggu kondisi eksplisit; jangan melonggarkan assert.
Bukti: test terarah 5x berturut lewat `heavy` (`LEGEND_TEST_FILES="src/test/tax-api.test.ts" heavy pnpm test`), hijau semua; jelaskan akar masalah. Jangan jalankan suite penuh. Prettier/eslint.
Laporan: akar masalah, commit, head SHA. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
