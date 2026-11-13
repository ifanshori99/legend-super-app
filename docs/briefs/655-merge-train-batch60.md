# Brief: merge train — batch60 ke milestone/m1

Baca `~/.agents/team/roles/merge-train.md`. Prosedur sama dengan `docs/briefs/653-merge-train-batch59.md`.

## Repo
Worktree baru dari `milestone/m1` = ecab3cff8. Cabang `int/batch60`.

## Isi batch (urutan ini)
1. `fix/flaky-654` (cf6f01195) — test-only: legend-1jxh8, rr0x1, 30dhj.
2. `ws/edge-order-ingest` (c72bddf73) — legend-771dl. Dibangun di atas `ws/edge-sync-appliers` yang sudah di m1 (0510 -> 0342, 0508 -> 0339); jangan terapkan ulang migrasi itu. Migrasi barunya 0522.

## Migrasi
m1 terakhir 0346. Nomori ulang mulai **0347**. Aturan sama dengan batch59 (renumber, `when` monoton, journal/snapshot, `db:generate` kosong, registry, upgrade dari 0346 sebagai pemilik biasa tanpa BYPASSRLS).

## Gerbang
`colima-up`, tes root dulu, satu run penuh + build. Catat apakah flake `rotate-data-key`, `hris-leave-changed-event`, `platform-org-api` TEN-03/06 masih muncul (bukti fix 654). Flake lain berkartu boleh lanjut sesuai merge-train.md. e2e `legend-zueb.mock.spec.ts` seharusnya hijau sekarang.

## Bukti selesai
Fast-forward `milestone/m1`, push tanpa --force, `main` jangan disentuh. Bersihkan worktree/cabang lokal yang tergabung. Tutup bead yang utuh di m1 (bukan `legend-zy43`). Lapor SHA, peta migrasi, gate, durasi, flake yang masih muncul, bead ditutup.

## Batas
Jangan `pkill`/`killall`, force push, deploy.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
