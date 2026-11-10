# Brief: engineer — kegagalan PIN yang mengunci tetap dihitung di batas device (legend-sp9vq)

## Peran
Baca `~/.agents/team/roles/engineer.md` lalu ikuti. Tingkat K (auth) tapi kecil: satu subagent architect high review.

## Worktree
`.worktrees/jmsdx-pepper` (ws/jmsdx-pepper 469673f2, berisi u7g9w). Commit dan push cabang yang sama. Jangan --force.

## Tujuan
Temuan Codex 382, P2, `apps/api/src/services/staff-pin-proof.service.ts:413`: tebakan salah ke-5 menghasilkan `PIN_LOCKED` dan slot device dikembalikan. Penyerang menyiapkan banyak staf pada 4 kegagalan, menunggu jendela device (10 gagal / 5 menit) berganti, lalu mencoba tebakan ke-5 untuk semuanya tanpa kena batas atau alert device.
Fix: bedakan "baru terkunci oleh tebakan ini" (tetap dihitung sebagai kegagalan device, ikut alert) dari "sudah terkunci sebelumnya" (tidak memakan slot). Tahan permintaan paralel.

## Bukti
- Test gagal-dulu: skenario di atas melewati batas device di kode lama, ditolak 429 sesudah fix.
- `heavy` typecheck api, test staff-pin-proof terkait. Batas Retro 11: 2x gagal typecheck, baca log.

## Kartu
`legend-sp9vq`: `bd update --status in_progress`, selesai `--status review` + `bd comment`.

## Laporan
SHA, test, hasil typecheck (EXIT eksplisit), temuan architect.
