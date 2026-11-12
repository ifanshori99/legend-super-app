# Brief: merge train (Codex) — batch51 HRIS U4 + test flaky ke milestone/m1

## Peran
Baca `~/.agents/team/roles/merge-train.md` (bila tidak ada: `engineer.md`) dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md`. Prosedur sama dengan `docs/briefs/566-merge-train-batch49.md` dan `570-merge-train-ui.md`.

## Repo
Worktree dari Ghostex basis `milestone/m1` = ab574d58. Cabang `int/batch51` (baru; jangan pakai ulang nama int/batch50).

## Isi batch (urutan ini)
1. fix/flaky-batch49 (062a4a7d) — perbaikan isolasi 4 test, review architect lulus.
2. ws/hris-u4-full (5042d392) — HRIS U4 backend + layar (sudah berisi ui/hris-u4-wire dan ws/hris-u4-be), architect xhigh 0 temuan.
Merge train tidak mereview ulang isi. Konflik isi yang tidak jelas: lapor ke CTO.

## Migrasi
ws/hris-u4-full membawa `0406_hris_u4`. m1 terakhir 0307. Nomori ulang jadi **0308** dengan `migration-renumber`, `when` monoton, journal + snapshot konsisten, `db:generate` kosong. Buktikan upgrade dari DB m1 sebagai pemilik biasa tanpa BYPASSRLS.

## Bukti selesai
- Satu `heavy pnpm check` penuh (sekali) + `heavy pnpm build`. Ketiga test flaky lama sudah diperbaiki di batch ini; kegagalan lain: lapor, jangan perbaiki sendiri kecuali format/lint mekanis.
- Bila hijau: fast-forward `milestone/m1` ke `int/batch51`, push tanpa --force. `main` jangan disentuh.
- Hapus worktree + cabang yang tergabung dan bersih (cek berkas untracked dulu).
- Lapor SHA m1 baru, nomor migrasi, hasil gate, catat singkat di `docs/PROGRESS.md`.

## Batas
Jangan `pkill`/`killall`, jangan force push, jangan deploy.
