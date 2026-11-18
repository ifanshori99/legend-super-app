# 1123 Performa web: pecah katalog i18n per area (legend-nmn9j, tingkat S)
Peran: engineer (`~/.agents/team/roles/engineer.md`). Langkah pertama: Explore (cara i18n dimuat, ukuran bundle per route) + implementer + test-runner paralel dalam satu giliran.
Base `origin/milestone/m1`. Cabang `ws/1123-perf-web-i18n`. Push tanpa `--force`. Tanpa migrasi, tanpa ubah API.
Isi: bundle web 774 KB karena katalog i18n tunggal; index 707 KB; CLS 0,114 di shell. Pecah katalog per area route (muat malas per area, bahasa aktif saja), kecilkan index, perbaiki sumber CLS shell. Teks tidak berubah (`node --test tests/text-contract.test.mjs` hijau). Tampilan tidak berubah.
Bukti: ukuran bundle sebelum/sesudah dari `heavy pnpm --filter @starter/web build`; typecheck web sekali lewat heavy; test web terarah; prettier/eslint; satu reviewer sonnet. Screenshot tidak perlu kecuali CLS (satu run Playwright lewat heavy bila ada skrip).
Laporan: angka sebelum/sesudah, commit, head SHA. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
