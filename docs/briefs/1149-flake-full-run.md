# 1149 Bundel flake full run (tingkat S, test saja)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Codex. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (satu penyelidik per flake, berkas terpisah).
Cabang `ws/1149-flake-full-run` dari `origin/milestone/m1` (worktree dari Ghostex). Push tanpa `--force`. Tanpa migrasi. Codex tidak menjalankan `bd`: CTO memindah kartu.

Kartu:
1. `legend-5voa6` (P1): 'audit writer failed after appending' gagal di full run batch92 dan batch93, lolos terarah. Log: `~/.claude/state/heavy-fail/20261119T075729-17408.log`. Kemungkinan sama dengan `legend-h4ary` (rbac-audit-writer §3.7): periksa keduanya.
2. `legend-c2z4x`: payroll-payout-897-proof-binding [897-parallel-overpaid-vs-return-2] 503 PAYOUT_STEP_GRANT_UNAVAILABLE di full run.
3. `legend-inflf`: payroll-payout-990-recon-attest gagal intermiten saat paralel (3 berkas atau suite penuh).

Aturan: cari akar masalah (isolasi DB per berkas, data bersama antar test, timer, urutan, pool). Perbaiki test atau setup test. JANGAN ubah logika produksi uang/payout/akses; bila akar masalah ada di kode produksi, berhenti di kartu itu dan tulis temuannya di laporan.
Bukti: reproduksi dulu (mis. jalankan berkas bersama berkas tetangga yang memicu, atau `--sequence.shuffle`/ulang N kali), lalu lulus berulang sesudah fix. Semua lewat `LEGEND_TEST_FILES="..." heavy pnpm test` (jalur ringan, maks 2). Tidak menjalankan suite penuh. Prettier/eslint berkas yang diubah. Typecheck API sekali lewat `heavy` bila kode TS non-test berubah.
Laporan: head SHA, kartu tertutup/tidak (dengan akar masalah satu kalimat), risiko. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
