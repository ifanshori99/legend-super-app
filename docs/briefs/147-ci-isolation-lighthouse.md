# Brief 147: engineer — CI isolasi tenant dan Lighthouse nyata (legend-wwsa)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Tingkat S, kecuali harness menemukan kebocoran data antar tenant: itu bug tingkat K, laporkan dulu sebelum memperbaiki.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder proyek sedang di cabang lain; jangan checkout di sana.
`git worktree add .worktrees/ci-isolation -b ws/ci-isolation milestone/m1`. Jangan pakai `--worktree` Ghostex.

## Tujuan
`bd show legend-wwsa` dan kartu asalnya `legend-5l9`. Ganti placeholder CI:
1. Lighthouse nyata untuk halaman tamu `/menu` dan `/t/*` (build produksi, lewat `heavy`), dengan ambang yang masuk akal dan tercatat di repo.
2. Harness isolasi lintas tenant diikat ke service nyata yang sudah ada (pesanan POS, menu, pembayaran/refund, inventori, akuntansi, HRIS): tenant A tidak bisa membaca/mengubah data tenant B lewat service maupun route. Pakai fixture yang ada.
Di awal: `ghostex board associate legend-wwsa`, `bd update legend-wwsa --status in_progress`. Saat melapor: `--status review` dan `bd comment`.

## Scope
- Boleh: konfigurasi CI (`.github/`), skrip QA, test isolasi di `apps/api/src/test/`, konfigurasi Lighthouse.
- Jangan: kode aplikasi (kecuali melaporkan bug), `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`, migrasi.

## Bukti selesai
Harness isolasi lulus dengan `LEGEND_TEST_FILES=...`; satu run Lighthouse lokal lewat `heavy` dengan skor tercatat; workflow CI tervalidasi (`actionlint` bila ada). Commit lokal di `ws/ci-isolation`, jangan push.

## Laporan
SHA, modul yang tercakup harness, skor Lighthouse, kebocoran yang ditemukan (bila ada), bead baru.
