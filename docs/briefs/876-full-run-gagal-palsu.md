# Brief: engineer (Codex) — run penuh gagal palsu + PC-22

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit). Kamu Codex: jangan jalankan `bd`.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree sendiri dari `origin/milestone/m1` (69175e58a). Cabang: `fix/full-run-teardown-876`.

## Tujuan
Run penuh (`heavy pnpm test`, ~80 menit) gagal padahal 0 test gagal, karena unhandled error saat teardown. Ini menghabiskan lajur berat merge train. Perbaiki akarnya, tanpa melonggarkan test.
1. `legend-4ge79`: PG `57P01` "terminating connection due to administrator command" dari `edge-recipes-protocol-compat.test.ts` saat `afterAll` (`cloud.cleanup()` menutup DB test selagi koneksi lain masih terbuka; 1 dari 6 run sendiri).
2. `legend-38g0t`: audit semua pola `pool.end()` lalu DROP DATABASE di helper/test API; jadikan urutan aman (tunggu semua klien lepas, tutup pool, baru drop; tangani 57P01 dari koneksi milik test itu sendiri secara eksplisit, bukan menelan semua error).
3. `legend-4m357` (UANG): `accounting-petty-cash` PC-22 gagal di run penuh batch65 (harap 100000, dapat 60000). Cari akar masalah. Bila isolasi data test: perbaiki fixture. Bila bug produk (saldo/jurnal kas kecil salah di bawah beban atau balapan): JANGAN ubah kode uang, tulis temuan dan skenario gagal di laporan supaya CTO memutuskan.

## Scope
- Boleh: helper test API (`apps/api/src/test/`), setup vitest, file test di atas.
- Jangan: kode produk uang, migrasi, skip/longgarkan test.

## Pembagian paralel
3 subagent bawaan (satu per kartu) + satu pemegang heavy. Reproduksi dengan kombinasi file terarah (`LEGEND_TEST_FILES="..." heavy pnpm test` dari root worktree, path `src/test/...`), bukan run penuh.

## Bukti selesai
Per kartu: reproduksi sebelum fix, lulus 3x kombinasi sama sesudah fix (atau catat yang dicoba bila tak bisa direproduksi). Pra-gate AGENTS.md, typecheck API sekali lewat heavy. Commit, push tanpa force, jangan merge. Lapor sekali di akhir: cabang, SHA, akar masalah per kartu, angka subagent.
