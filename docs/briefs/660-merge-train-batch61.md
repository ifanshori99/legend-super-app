# Brief: merge train — batch61 ke milestone/m1

Baca `~/.agents/team/roles/merge-train.md`. Prosedur sama dengan `docs/briefs/655-merge-train-batch60.md`.

## Repo
Worktree baru dari `milestone/m1` = b17554cb9. Cabang `int/batch61`.

## Isi batch (urutan ini)
1. `ws/edge-contract-followups` (df90b7ac5) — berisi `ws/edge-sales-gl` (51d67b182: uctlr, 132mw, vje21) + cqehx, yu8z0, zy43. Tanpa migrasi baru (0347 sudah di m1).
2. `ws/payroll-payout-gl` (83892702e) — wnkep.5, f5n9y. Migrasi `0534_payout_gl_postings`, `0536_session_mfa_challenge`.

## Migrasi
m1 terakhir 0347. Nomori ulang mulai **0348**. Aturan sama dengan batch60 (FK ke tabel ber-FORCE RLS: inline di `CREATE TABLE`).

## Gerbang
`colima-up`, tes root dulu, satu run penuh + build. e2e mock yang menyentuh form void/refund POS (pesan 409 baru) dan step-up payout bila ada. Flake berkartu boleh lanjut sesuai merge-train.md.

## Bukti selesai
Fast-forward `milestone/m1`, push tanpa --force, `main` jangan disentuh. Bersihkan worktree/cabang lokal tergabung (bukan `.worktrees/edge-resilience-659`, masih dipakai). Tutup bead yang utuh di m1. Lapor SHA, peta migrasi, gate, durasi, bead ditutup.

## Batas
Jangan `pkill`/`killall`, force push, deploy.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
