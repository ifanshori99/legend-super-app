# 1230 Perbaiki full run batch102 (15 gagal, 6 file)

Worktree `../legend-int-batch102` (int/batch102, sudah setup). Log `.batch102-fullrun.log` di sana. Batch101 (base) hijau penuh, jadi penyebab ada di 5 merge batch102: 1217 (18a140497), 1218 (e50f0f72b), 1219 (d4a70d7cf), 1220 (c2f0aedf1), 1222 (1d16d7463).

Gagal: `access-audit` (1), `access-grant-grantee` (8), `access-grant-role-lock` (3), `access-hardening` (1), `e2e-az/az-j-opname-journal` (ACC-01 jurnal final tidak dihapus), `payment-link-cancel-provider-breakfast` (ukbq3-brk-expired).

Langkah: reproduksi terarah `LEGEND_TEST_FILES="src/test/access-grant-grantee.test.ts ..." heavy pnpm test`; bedakan flake/isolasi data (lolos sendiri) vs regresi; cari merge penyebab (`git log`/diff per merge). Akar masalah dulu. Kode produksi salah -> perbaiki di cabang ws asal lalu merge ulang ke int/batch102; test yang bergantung pada fixture/asumsi lama -> perbaiki test di int/batch102 tanpa melemahkan maksudnya. Jangan full run. Commit (`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`), push. Lapor: akar masalah per file, SHA, hasil test terarah semua 6 file. Budget 40 tool call; di 32 commit + lapor.
