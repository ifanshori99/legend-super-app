# Brief: engineer — e3k4p riwayat rekonsiliasi dedup (legend-9z10p)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Kerja di worktree yang SUDAH ADA: `/Users/ifanshori99/Projects/legend super app/legend-2c6b04f7`, cabang `ghostex/job-rekonsiliasi-edge-berkala` (head 96af9099f, bersih). Jangan buat worktree baru (disk sempit). Jangan edit folder utama.

## Tujuan
Tutup temuan architect atas legend-e3k4p: riwayat rekonsiliasi tidak lagi tumbuh tiap 5 menit tanpa perubahan, run manual operator tetap terlihat, dan standby tidak mencatat laporan stale tanpa arti.

## Kartu
`legend-9z10p` (detail di bead: `bd show legend-9z10p`). Awal: `ghostex board associate legend-9z10p`, `bd update legend-9z10p --status in_progress`. Lapor: `--status review` + `bd comment`.

## Scope
- Boleh: `apps/api/src/edge/reconciliation-sender.ts`, `apps/api/src/edge/runtime.ts` (bagian sender saja), `apps/api/src/services/edge-reconciliation.service.ts`, `apps/api/src/routes/edge-reconciliation.routes.ts`, test `apps/api/src/test/edge-reconciliation*.test.ts`.
- Jangan: migrasi 0684 atau trigger append-only; scope kredensial (sudah bersih, jangan diubah); rate limit (tidak dikerjakan).
- Migrasi: tidak ada. Bila dedup butuh indeks baru, lapor dulu ke CTO (nomor 0687).

## Pembagian paralel (giliran pertama)
- Explore (2): (a) jalur INSERT + GET riwayat + digest/throughLinkSeq; (b) apakah standby upload sendiri (cursor edge_to_cloud) dan di mana peran primary/standby ditentukan.
- test-writer: test gagal-dulu: POST kedua dengan status+throughLinkSeq/digest sama tidak menambah baris; run manual tetap muncul di GET riwayat setelah banyak run otomatis; standby tidak mengirim (atau laporannya tidak stale) sesuai temuan Explore (b).
- implementer (2): service/route dedup; sender/runtime standby.
- test-runner: pemegang token heavy (`LEGEND_TEST_FILES=... heavy pnpm test`, `heavy pnpm --filter @starter/api typecheck`).
- reviewer sonnet di akhir.

## Bukti selesai
Test gagal-dulu tercatat merah di 96af9099f lalu hijau; test edge-reconciliation lain tetap hijau; typecheck API, eslint, prettier berkas berubah; `db:generate` kosong.

## Sebelum melapor
Commit di cabang yang sama, push tanpa `--force`. Lapor: hasil, bukti, commit SHA, risiko. Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
