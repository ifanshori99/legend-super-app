# Brief: engineer — Bundel platform: rotasi kunci secrets (dheu) + support-access global (ca4l) + revoke support-access tenant admin (8en8) (legend-dheu)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang `ws/dheu-<topik>` dari `origin/milestone/m1` (3c7217b2) di `.worktrees/dheu`.

## Kartu
`legend-dheu` (`bd show legend-dheu`, baca deskripsi + acceptance). Awal: `ghostex board associate legend-dheu` + `bd update legend-dheu --status in_progress`. Lapor: `--status review` + `bd comment`.

## Langkah 1 (wajib): cek basi
Kartu bisa sudah sebagian/seluruhnya dikerjakan di kartu lain. 2 `Explore` paralel: (a) `git log --all --grep` + cari kode yang sudah memenuhi acceptance, (b) pola yang ada untuk area ini. Bila sudah terpenuhi: tutup kartu dengan bukti file:baris dan lapor. Bila sebagian: kerjakan sisanya saja.

## Lalu
`test-writer` (gagal-dulu, vitest backend) + `implementer` (maks 3, file tidak bertumpuk). Satu token heavy per thread. Review: akses + rahasia -> architect xhigh. Aturan "jangan sampai rugi" berlaku untuk angka uang.

## Scope
Hanya area kartu + test. Migrasi bila wajib: nomor sementara 0287.

## Bukti selesai
`LEGEND_TEST_FILES="<src/test/...>" heavy pnpm test` lulus; `NODE_OPTIONS=--max-old-space-size=6144 heavy pnpm --filter @starter/api typecheck` 0; gagal-dulu tercatat.

## Batas kerja ulang
typecheck gagal 2x: baca log heavy-fail lengkap, betulkan semua sekaligus; gagal ke-3 lapor. Jangan pkill. Jam dari `date '+%H:%M'`.

## Sebelum melapor
Commit + push. Hapus worktree yang bersih.

## Laporan
Hasil (atau bukti basi), sha, temuan review. Subagent: total, puncak bersamaan, pemegang token heavy.
Kartu bundel: legend-dheu, legend-ca4l, legend-8en8 (associate + in_progress ketiganya). File: apps/api/src/lib/secrets.ts, services/platform-support.service.ts, routes/org.routes.ts, routes/platform.routes.ts, test platform-support-*. Cek basi per kartu dulu. Lint = eslint + prettier file berubah.
