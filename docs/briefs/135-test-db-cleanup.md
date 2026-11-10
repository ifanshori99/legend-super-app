# Brief 135: engineer kecil — bersihkan container test DB yang bocor (legend-yw90)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Tingkat S: `reviewer` Sonnet sebelum melapor.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder proyek sedang di cabang lain; jangan checkout di sana.
`git worktree add .worktrees/test-db-cleanup -b ws/test-db-cleanup milestone/m1`. Jangan pakai `--worktree` Ghostex.

## Tujuan
`bd show legend-yw90`. Saat run test terbunuh (Ctrl-C, timeout, agent dihentikan), container dan jaringan `starter-pg-test-*` tertinggal dan memakan RAM Colima (batas 3 GiB). Tambahkan:
1. `trap` di skrip yang menyiapkan PG test sekali pakai, untuk EXIT, INT, dan TERM: hapus container dan jaringan milik run itu saja.
2. Sapuan di awal tiap run: hapus container dan jaringan `starter-pg-test-*` yang berumur lebih dari 30 menit. Jangan sentuh container run lain yang masih hidup, PG dev (`compose.dev.yaml`), atau volume bernama.
Di awal: `ghostex board associate legend-yw90`, `bd update legend-yw90 --status in_progress`. Saat melapor: `--status review` dan `bd comment`.

## Scope
- Boleh: skrip test DB di root (cari lewat script `test` di `package.json`), test skripnya.
- Jangan: kode aplikasi, `compose.dev.yaml`, volume Docker (`docker volume rm` dilarang), `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`.

## Bukti selesai
- Run yang dibunuh di tengah (kirim SIGTERM) tidak meninggalkan container/jaringan; container buatan tangan dengan label/nama test berumur >30 menit tersapu; container run paralel yang hidup tidak tersentuh.
- `LEGEND_TEST_FILES="<satu file test kecil>" pnpm test` tetap lulus. Lint skrip bila ada.
- Commit lokal di `ws/test-db-cleanup`, jangan push.

## Laporan
SHA, hasil uji bunuh-run, file berubah.
