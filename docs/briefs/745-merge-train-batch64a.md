# Brief: merge train batch64a

Lanjutan batch63 (sudah di `milestone/m1` ec4f7dfc6). Cara kerja sama seperti `docs/briefs/724-merge-train-batch63.md` (baca bagian "Wajib", berlaku penuh). Maks 7 merge. Jangan merge ke `main`, jangan deploy. Baca `~/.agents/team/roles/` peran merge train di TEAM.md.

## Cabang (urut)
1. `fix/migration-fk-inline-guard` 86a4191ad (masuk dulu; guard FK inline lalu ikut di m1)
2. `fix/migration-replay-flake` fc8e69215 (legend-odyct)
3. `ui/ai-settings-v2` 29f52256a (founder Q21 setuju)
4. `fix/ai-lock-nowait` 3f97f66cc (sudah memuat `fix/ai-lock-second-opinion` 31f4fedb9; masuk bersama 3)
5. `fix/shell-scroll-region-a11y` bd7332434
6. `fix/customer-shell-scroll-a11y` 3dd865c10
7. `fix/flakes-u47g8` 18b769544 (cabang ini mengubah `docs/PROGRESS.md`: ambil versi m1 bila bentrok)

Tidak ada migrasi baru yang diketahui di cabang ini; bila ada, nomori setelah 0360 dengan aturan yang sama.

## Antre berikutnya (bukan batch ini, untuk info)
64b: reservasi (followups + guest-contract 0603 + guest-page), KDS (ui/kds-config-scanner + ws/kds-station-save 0590/0591 + fix/kds-routing-inactive), ws/s-tier-flakes-ci. 64c: payout. 64d-e: fix/edge-*, panic, codec, CI, dll.

## Laporan
Sesuai brief 724, plus kartu flake baru bila run penuh merah.
