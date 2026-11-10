# Merge train batch45

Basis: ref `milestone/m1` 7d388b02 (batch44). Prosedur sama dengan brief 303/296: `--no-ff`, `db:generate` kosong sesudah tiap merge, gate lewat `heavy` (typecheck, `pnpm test` penuh, e2e), reviewer untuk hunk konflik, lalu majukan ref m1. Jangan checkout di folder utama; kerja di worktree sendiri `.worktrees/merge-batch45`. Jangan push.

## Urutan merge (tidak ada migrasi baru di batch ini)
1. `ws/ia54l-claim-after-close` e4efc823 (legend-ia54l)
2. `ws/worker-audit-writer` 5391163c (berisi `ws/arj6-auto-clearance` ab88dae4; legend-arj.6 + legend-j88cz)
3. `ws/msqvi-points-journal` babb3174 (legend-msqvi)

Ketiganya menyentuh `docs/PROGRESS.md`: konflik di sana gabungkan keduanya (keep both). Konflik kode lain: berhenti dan lapor ke CTO dengan nama cabang dan berkas.

## Catatan rilis (tulis di catatan rilis/PROGRESS)
- Worker audit writer: sebelum deploy, jalankan query 3 di `docs/runbooks/worker-audit-writer-m1-window.md` (persetujuan lewat tenggat). Deploy di jendela sepi bersama 0203: sapuan pertama mengedarkan semua persetujuan kedaluwarsa sekaligus.
- Jurnal poin: tenant lama perlu `pnpm db:backfill-defaults` (akun 4105). Jurnal poin tetap tidak dinyalakan sampai `legend-kbbma` selesai dan akuntan founder konfirmasi (DECISIONS.md "WS-08: loyalty points journal, PSAK 72").

## Sesudah gate
Hapus worktree yang cabangnya sudah di m1 dan bersih (tanpa `--force`): `small-305`, `msqvi-points-journal`, dan worktree merge sendiri. Jangan hapus worktree thread lain. Daftar berkas untuk alat: berkas sementara + `xargs`, jangan ekspansi array zsh.

## Laporan
Sekali di akhir: SHA m1 baru, konflik, angka gate (file/tes api, root, e2e), temuan reviewer, perbaikan di luar konflik, worktree dihapus, ruang disk.
