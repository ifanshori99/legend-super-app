# 527 Test infra: flake PAY-04 paralel + pisah langkah node:test (legend-xu9he, legend-3mgje)

Peran: engineer (~/.agents/team/roles/engineer.md). Tingkat S (hanya test/skrip test, tanpa kode produk, tanpa migrasi). Review akhir: satu reviewer.
Langkah 0: `git worktree add .worktrees/test-infra-flakes -b ws/test-infra-flakes origin/milestone/m1` (basis 7917440a).

1. legend-xu9he: suite terarah berisi berkas refund/payment (payment-refund-approval, -manual-settle, -review-fix, -settled-fund-conflict, -codex-fix, payment-admin-multi-fund) merah acak di test PAY-04 bila dijalankan bersamaan, lulus bila sendiri. Reproduksi dulu (jalankan himpunan berkas itu 2-3 kali lewat `LEGEND_TEST_FILES="..." heavy pnpm test`), cari akar (sweep job/approval global vs data berkas lain, tenant/fixture bersama, jam), betulkan isolasinya di test/fixture. Jangan melemahkan assertion uang.
2. legend-3mgje: `pnpm test` jadi merah bila satu node:test gagal setelah vitest lulus, dan `db-role-provisioning` node:test hanya lulus bila sendiri. Pisahkan vitest dan node:test jadi dua langkah yang dilaporkan terpisah di skrip test root; cari kenapa db-role-provisioning gagal saat bersama, betulkan.
Jangan jalankan `pnpm test` penuh (gate merge train). Cukup test terarah lewat `heavy`, ulang 3x untuk bukti flake hilang.
Selesai: commit + push ke ws/test-infra-flakes (tanpa --force). Laporan akhir: akar masalah tiap kartu, hash, bukti 3x hijau, angka subagent.
