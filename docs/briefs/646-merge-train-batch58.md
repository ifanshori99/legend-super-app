# Brief: merge train — batch58 ke milestone/m1

Baca `~/.agents/team/roles/merge-train.md` (gerbang tiga tahap: lint -> typecheck -> test). Prosedur sama dengan `docs/briefs/631-merge-train-batch56.md`.

## Repo
Worktree baru dari `milestone/m1` = 1cbb842d5. Cabang `int/batch58`.

## Isi batch (urutan ini, `git merge --no-ff origin/<cabang>`; cek SHA terbaru di origin)
1. `fix/flaky-641` (eba3abc4a) — 2 test flaky + `scripts/test.mjs` tes root jalan duluan.
2. `fix/payroll-o2-o3` (a9d87904a) — tanpa migrasi.
3. `ws/followups-640` (464645ff7) — WA inbound, printer ke edge, Brevo. Migrasi 0500-0502.
4. `fix/edge-order-reemit` (c93ffaca9) — migrasi 0508.
5. `fix/cash-bank-table-mapping` (27a5a508c) — dari fix/petty-fund-required (sudah di m1), tanpa migrasi.
6. `fix/purchase-return-variance` (e09eb217e) — dari ws/purchasing-posting + fix/purchase-return-test-setup (sudah di m1). Migrasi 0504.

JANGAN masukkan rantai QRIS. Konflik isi tidak jelas: lapor CTO, jangan tebak.

## Migrasi
m1 terakhir 0335. Nomori ulang berurutan mulai **0336** sesuai urutan merge. `migration-renumber`, `when` monoton, journal + snapshot konsisten, `db:generate` kosong, registry + referensi test ikut diganti. Buktikan upgrade dari DB m1 (0335) sebagai pemilik biasa tanpa BYPASSRLS.

## Gerbang
Tiga tahap; `~/.claude/scripts/colima-up` dulu; satu run penuh test + `heavy pnpm run build`. Gagal: catat berkas, ulang per berkas; ikuti bagian "Flake di tahap test" di roles/merge-train.md. Perbaikan mekanis boleh; logika: lapor CTO. Batas 1 worker tetap.

## Bukti selesai
Fast-forward `milestone/m1` ke `int/batch58`, push tanpa --force. `main` jangan disentuh. Hapus worktree + cabang yang tergabung dan bersih (cek dulu tidak ada thread lain memakainya). Tutup bead yang commit-nya kini ada di m1, hanya yang masih open dan pekerjaannya utuh. Lapor SHA m1, peta migrasi, hasil gate, durasi test penuh, bead yang ditutup.

## Batas
Jangan `pkill`/`killall`, jangan force push, jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`

## Tambahan (pelajaran batch57)
- Satu run penuh saja: jangan `&` di dalam perintah background, jangan hapus container Postgres yang dipakai run lain.
- Sebelum run penuh, jalankan dulu `node --test` tes root yang menyangkut berkas cabang (registry migrasi `data-import-registry`, `access-i18n`, `legend-g6d`) supaya kegagalan katalog ketahuan di awal.
