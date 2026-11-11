# 542 Merge train batch48j
Peran: merge train (~/.agents/team/roles/merge-train.md). Ikuti pola docs/briefs/534-merge-train-batch48i.md dan pelajaran batch48i di docs/PROGRESS.md (renumber migrasi, `when` naik, upgrade dari DB m1).
Basis: origin/milestone/m1 ede015c9. Cabang integrasi int/batch48j.
1. Commit pertama: default `STARTER_TEST_PG_MEM` di compose test jadi 1536m (batch48i OOM 3x pada 512m/768m).
2. Gabung urut (6 cabang, semua sudah direview): ws/preflight-0301 85b70aad, ws/aig01-business-date e940a996 (tsc belum pernah dijalankan), ws/ten09-codecs c76ba6f7 (registry perlu direkonsiliasi dengan m1), ws/edge-catalog-fresh f3be4e16, ws/edge-promo-streams 6303c34d, ws/edge-hardening 597909f3 (catat di PROGRESS: rilis cloud dulu, lalu edge).
3. Renumber migrasi di atas m1 terakhir (idx 273 / 0286), `when` naik monoton. Bukti upgrade dari DB m1.
4. Gate: eslint/prettier berkas berubah, test terarah area, lalu SATU `heavy pnpm check` penuh. Hijau: fast-forward + push milestone/m1 (bukan main). Hapus worktree cabang yang sudah tergabung.
Cabang payroll, hris-misc, ws07-tax masih diperbaiki: batch berikutnya.
