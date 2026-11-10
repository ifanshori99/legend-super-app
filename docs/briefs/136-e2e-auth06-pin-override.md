# Brief 136: engineer kecil — e2e mock AUTH-06 override PIN supervisor gagal (legend-631e)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Tingkat S (auth UI test), tapi bila akar masalah ada di logika override/otorisasi: tingkat K, `reviewer` Opus + `architect`.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder proyek sedang di cabang lain; jangan checkout di sana.
`git worktree add .worktrees/e2e-auth06 -b ws/e2e-auth06 milestone/m1`. Jangan pakai `--worktree` Ghostex.

## Tujuan
`bd show legend-631e`. `e2e/legend-6ew.mock.spec.ts:170` AUTH-06 gagal: nama penyetuju "Yusuf Hidayat" tidak tampil.
1. Cek dulu apakah sudah lulus di `integ/m1-batch3`, `integ/m1-batch2`, atau `prep/e2e-az` (09e68483). Bila sudah, `bd comment` dengan bukti dan selesai.
2. Bila belum: reproduksi satu spec itu saja lewat `heavy` (Playwright mock, satu file, satu worker), cari akar (UI berubah vs logika `voidOverrideId`), lalu perbaiki yang salah. Jangan melemahkan assertion keamanan (PIN peminta sendiri harus tetap ditolak).
Di awal: `ghostex board associate legend-631e`, `bd update legend-631e --status in_progress`. Saat melapor: `--status review` dan `bd comment`.

## Scope
- Boleh: spec e2e terkait, komponen UI override PIN di `apps/web`, service override bila akar di sana.
- Jangan: `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`, modul refund/DOIT/pajak.

## Bukti selesai
Spec AUTH-06 lulus 2 kali berturut lewat `heavy`. Test unit/API terkait bila kode non-test berubah (`LEGEND_TEST_FILES=...`). Commit lokal di `ws/e2e-auth06`, jangan push.

## Laporan
SHA, akar masalah, hasil spec, file berubah.
