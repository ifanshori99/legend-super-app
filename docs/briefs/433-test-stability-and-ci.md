# Brief: engineer — stabilitas test suite penuh + CI lighthouse

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Basis `origin/milestone/m1` (68ad0fa3). Satu cabang per kartu: `ws/<id>-<topik>` di `.worktrees/<id>`.

## Kartu
- `legend-dfvpq` (P3): test platform-access-api "tenant-wide owner gets every outlet sorted by name" rapuh di suite penuh (collation DB vs sort JS). Perbaiki test (bandingkan dengan collation yang sama) atau API (urutan eksplisit) — pilih yang benar secara produk, jelaskan.
- `legend-36t01` (P3): test ORDER BY created_at flake karena jam VM Colima mundur ~120 ms tiap 20 detik. Cari test yang bergantung urutan waktu; beri tie-breaker (id) atau timestamp eksplisit.
- Flake dikenal dari merge train 48c: `menu-print-db` (2 test) dan `tax-api` ORD-03 lulus sendiri, gagal di suite penuh. Buat kartu bd bila belum ada, cari akar masalah (data bersama antar file?), perbaiki.
- `legend-6crc` (P1): CI lighthouse butuh legend-qgr6 (sudah CLOSED) di m1. Cek apakah perbaikan qgr6 (GET /api/public/site) sudah ada di m1 68ad0fa3. Bila ada: jalankan pekerjaan kartu 6crc. Bila tidak: laporkan sha/cabang qgr6 dan berhenti untuk kartu ini.
JANGAN sentuh test identitas/WhatsApp (legend-5opkl dikerjakan thread lain).

Awal tiap kartu: `ghostex board associate <id>` + `bd update <id> --status in_progress`. Lapor: `--status review` + `bd comment`.

## Pembagian paralel (giliran pertama, satu giliran)
- 3 `Explore` (access sort + created_at, menu-print/tax flake, qgr6/6crc).
- Lalu `implementer` per kartu (maks 4). Satu token heavy per thread: hanya satu subagent menjalankan test pada satu waktu.
- Review: `reviewer` sonnet per diff.

## Bukti selesai
Untuk tiap test flake: jalankan file terkait BERSAMA (satu `heavy` run berisi semua file yang dulu bertabrakan) 3x berturut lulus. `heavy pnpm --filter @starter/api typecheck` 0.

## Batas kerja ulang
typecheck gagal 2x: baca log heavy-fail lengkap, betulkan semua sekaligus; gagal ke-3 lapor. Jangan pkill. Jam dari `date '+%H:%M'`.

## Sebelum melapor
Commit + push tiap cabang. Hapus worktree yang bersih.

## Laporan
Per kartu: akar masalah, perbaikan, bukti 3x lulus, sha. Subagent: total, puncak bersamaan, siapa memegang token heavy.
