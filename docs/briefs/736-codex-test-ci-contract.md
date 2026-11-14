# Brief: engineer (Codex) — tiga kartu test/CI/kontrak kecil (legend-52659, legend-pjty, legend-tkc19)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show <id>` read-only. Tiga kartu, file terpisah: satu subagent per kartu, paralel.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b ws/test-ci-contract .worktrees/test-ci-contract origin/milestone/m1`.

## Tujuan
1. legend-52659: test Duitku/worker gagal acak karena fixture saling mengganggu. Reproduksi (jalankan berulang/berpasangan), isolasi fixture. HANYA ubah test; jangan ubah logika pembayaran. Bila akar ternyata bug produk, berhenti dan laporkan.
2. legend-pjty: test db-role-provisioning berjalan di PostgreSQL 16 pada CI (ikuti isi kartu).
3. legend-tkc19: tambah `isSystem` ke `edgeMasterUomSchema` (`packages/shared/src/edge/master-sync.ts`) dan konsumennya.
Kartu yang ternyata lebih besar dari deskripsinya, atau menyentuh uang/auth/migrasi: lewati dan laporkan.

## Bukti, sebelum melapor
Gagal-dulu lalu hijau (`LEGEND_TEST_FILES=... heavy pnpm test`; flake: hijau 20x), pra-gate AGENTS.md (prettier, eslint, typecheck api, dan web bila shared berubah, lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Jangan ubah `docs/PROGRESS.md`. Push cabang tanpa force. Jangan merge, jangan deploy.
