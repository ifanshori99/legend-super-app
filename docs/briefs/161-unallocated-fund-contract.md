# Brief 161: engineer — contract test EDC-06/PAY-04 gagal setelah multi-fund (legend-npwl)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.
Tingkat K (uang, kontrak dana): `reviewer` Opus sebelum melapor.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder proyek sedang di cabang lain; jangan checkout di sana.
`git worktree add .worktrees/unallocated-fund-contract -b ws/unallocated-fund-contract milestone/m1` (m1 9126f624 berisi batch5). Jangan pakai `--worktree` Ghostex.

## Tujuan
`bd show legend-npwl`. `tests/payment-admin-contract.test.mjs:201-211` gagal (actual true, expected false): `unallocatedFundViewSchema` menerima amount turunan yang salah. Dugaan: legend-knev (multi-fund) mengubah cara amount dana tak teralokasi diturunkan. Reproduksi dulu di m1 (`node --test tests/payment-admin-contract.test.mjs`), cari akar masalah: apakah refine schema di `packages/shared` melemah (bug, perbaiki schema) atau test memakai rumus lama (perbaiki test sesuai rumus multi-fund yang benar, tulis alasannya). Schema harus tetap menolak amount turunan yang tidak konsisten.
Di awal: `ghostex board associate legend-npwl`, `bd update legend-npwl --status in_progress`. Saat melapor: `--status review` dan `bd comment`.

## Scope
- Boleh: validator/DTO dana tak teralokasi di `packages/shared`, `tests/payment-admin-contract.test.mjs`, test terkait di `apps/api/src/test/`.
- Jangan: `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`, migrasi, adapter DOIT, logika refund, UI.

## Bukti selesai
- `node --test tests/payment-admin-contract.test.mjs` lulus; test API yang memakai schema itu (`LEGEND_TEST_FILES="src/test/..." pnpm test` dari root worktree, path `src/test/...`) lulus; typecheck shared+api, eslint, prettier lewat `heavy`.
- Commit lokal di `ws/unallocated-fund-contract`, jangan push.

## Laporan
SHA awal..akhir, akar masalah (schema atau test), hasil gate, temuan reviewer, bead baru.
