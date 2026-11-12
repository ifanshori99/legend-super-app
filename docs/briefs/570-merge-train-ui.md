# Brief: merge train (Codex) — batch50 UI ke milestone/m1

## Peran
Baca `~/.agents/team/roles/merge-train.md` (bila tidak ada: `engineer.md`) dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit). Prosedur sama dengan `docs/briefs/566-merge-train-batch49.md`.

## Repo
Worktree dari Ghostex. Basis `milestone/m1` = facdf39d. Buat cabang `int/batch50`.

## Isi batch (5 cabang, urutan ini)
1. ui/pos-cashier-captain (576770a8) — 257 commit di belakang m1, konflik paling mungkin.
2. ui/pos-extra (2843d057)
3. ui/backoffice-platform (d658f2d3)
4. ui/ai-mcp (ef48bc30) — Tanya AI, founder setuju Q52.
5. ui/hris-u4-wire (6e580652) — sebagian tersambung; bagian yang ditahan tetap ditahan.
Tidak ada migrasi di cabang ini. Merge train tidak mereview ulang isi. Konflik isi yang tidak jelas (dua cabang mengubah perilaku yang sama): lapor ke CTO, jangan tebak. `routeTree.gen.ts`: generate ulang, jangan gabung tangan.

## Bukti selesai
- Satu `heavy pnpm check` penuh (sekali) + `heavy pnpm build`. Tiga test flaky yang sudah ada kartunya (legend-3zp8b edge-catalog-sync, legend-hopta hris-leave-db, legend-jz0tl pos-shift device bind): bila hanya itu yang gagal, ulang terarah 2x; lulus = boleh lanjut, catat.
- Bila hijau: fast-forward `milestone/m1` ke `int/batch50`, push `milestone/m1` tanpa --force. `main` jangan disentuh.
- Hapus worktree + cabang yang sudah tergabung dan bersih.
- Lapor SHA m1 baru, hasil gate, catat singkat di `docs/PROGRESS.md`.

## Batas
- tsc gagal 2x: baca log `~/.claude/state/heavy-fail/` sampai habis. Gagal ketiga: lapor.
- Jangan `pkill`/`killall`, jangan force push, jangan deploy.
