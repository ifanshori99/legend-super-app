# Brief: engineer — penerima reconcile dibatasi ke tenant (legend-16iyk)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Basis: `origin/ws/merge-batch48d` (berisi ps-405 dan seluruh 48d; bila m1 sudah maju melewati 48d, pakai `origin/milestone/m1`). Cabang `ws/16iyk-reconcile-recipient` di `.worktrees/16iyk`.

## Kartu
`legend-16iyk` (`bd show legend-16iyk`). Awal: `ghostex board associate legend-16iyk` + `bd update legend-16iyk --status in_progress`. Lapor: `--status review` + `bd comment`.

## Tujuan
Architect batch48d: service reconcile (cari dengan Explore: kemungkinan bagi hasil/pemegang saham, ps-405) menerima user mana pun yang ada sebagai penerima. Batasi: penerima harus anggota tenant itu atau login milik pemegang saham itu sendiri. Tolak dengan error jelas (403/422 sesuai pola). Test gagal-dulu: user tenant lain ditolak, user tanpa keanggotaan ditolak, penerima sah lulus. "Jangan sampai rugi": tidak ada uang/dokumen bagi hasil ke orang di luar tenant.

## Pembagian paralel (giliran pertama, satu giliran)
- 2 `Explore` (service reconcile + caller/route; pola cek keanggotaan tenant yang sudah ada) + 1 `test-writer` (gagal-dulu, vitest backend).
- Lalu 1 `implementer`. Satu token heavy per thread.
- Review: tingkat K (akses + uang) -> satu subagent `architect` effort xhigh.

## Scope
Service reconcile + test. Tanpa migrasi.

## Bukti selesai
`LEGEND_TEST_FILES="<src/test/...>" heavy pnpm test` lulus; `NODE_OPTIONS=--max-old-space-size=6144 heavy pnpm --filter @starter/api typecheck` 0; gagal-dulu tercatat.

## Batas kerja ulang
typecheck gagal 2x: baca log heavy-fail lengkap, betulkan semua sekaligus; gagal ke-3 lapor. Jangan pkill. Jam dari `date '+%H:%M'`.

## Sebelum melapor
Commit + push. Hapus worktree yang bersih.

## Laporan
Hasil, bukti, sha, temuan architect. Subagent: total, puncak bersamaan, pemegang token heavy.
