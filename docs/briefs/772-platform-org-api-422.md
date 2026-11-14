# 772 platform-org-api.test.ts:148 gagal 422 vs 200 (legend-mnyzw)
Peran: engineer (Codex, kartu S). Base: milestone/m1. Cabang: fix/platform-org-api-422. Tanpa migrasi.
Masalah: test apps/api/src/test/platform-org-api.test.ts:148 mengharap 200, dapat 422 (gagal di main 1f0b6d244, baseline 29/30). Langkah 0: jalankan berkas itu sendiri di milestone/m1 (LEGEND_TEST_FILES=... heavy pnpm test); bila lolos di m1, lapor dan berhenti.
Bila gagal: cari akar (validator shared, perubahan kontrak, data test). Tentukan mana yang salah, test atau kode. Bila kode production yang salah dan menyentuh auth/akses platform: lapor dulu sebelum mengubah. Jangan longgarkan validator hanya supaya test lolos.
Aturan umum: baca ~/.agents/team/roles/engineer.md dan "Paralel dulu" di ~/.agents/team/TEAM.md. Kerja berat lewat `heavy`, satu job sekaligus. Test bukti gagal-dulu. Satu reviewer. Pra-gate AGENTS.md. Commit, push cabang tanpa force, jangan merge. Lapor angka subagent.
