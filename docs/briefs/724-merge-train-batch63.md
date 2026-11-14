# Brief: merge train batch63

Lanjutan batch62 (sudah di `milestone/m1` 7745e40e3). Cara kerja sama seperti batch62 (`docs/briefs/705-merge-train-batch62.md`). Maks 7 cabang. Jangan merge ke `main`, jangan deploy.

## Cabang (urut)
1. `ws/payment-approvals` d16dfb45b (0565)
2. `ws/payment-approvals-dedupe` 7d66e2d62 (0574)
3. `ws/payment-approvals-matched-close` 81f0c7e5a (0578). Nomor 1-3 wajib masuk bersama: bila salah satu gagal, keluarkan ketiganya.
4. `ws/loyalty-referral-followups` 15ccf6e86
5. `ws/loyalty-earn-replay-fix` aa6f820ec
6. `ws/auto-journal-gaps` 95871c8a3
7. `ws/reports-dashboard-fixes` 1b8382dfb (DASH-02 sudah dibetulkan: fixture dashboard menandai metrik review tersedia padahal kosong). Bila DASH-02 masih merah di cabangnya sendiri: keluarkan, lapor.

Antre batch64 (bukan batch ini): `ui/ai-settings-v2` + `fix/ai-lock-second-opinion` 31f4fedb9, `ws/reservation-followups`, `ws/s-tier-flakes-ci`, `fix/shell-scroll-region-a11y`, `fix/migration-replay-flake`, dll.

## Wajib
- Nomori ulang migrasi berurutan setelah 0356, `when` naik monoton (pelajaran 0356 batch62), snapshot berantai. `node ~/.agents/team/check-journal.mjs origin/milestone/m1`, `db:generate` kosong, `tests/migration-fk-inline.test.mjs` hijau.
- Uang (approval, rekonsiliasi, loyalty, jurnal): test cabang tersebut hijau di tip akhir, termasuk bukti tidak ada pihak dibayar lebih.
- e2e `auth.spec` hijau. Satu run penuh bersih di tip akhir. Batas TEAM.md: 2 kali run penuh gagal/mati, berhenti dan lapor.
- Tutup bead yang terbukti selesai oleh cabang-cabang ini (lihat pesan commit dan brief tiap cabang), sebutkan di laporan.
- Akhir gelombang: `python3 ~/.claude/scripts/session-usage.py <session-uuid>` dan `~/.claude/scripts/parallel-report <repo> --since <HH:MM>`, catat di `docs/PROGRESS.md`.
- Disk < 15 GB: hapus worktree cabang yang sudah tergabung dan bersih; jangan sentuh worktree thread lain.
