# Brief: second-opinion (Codex, xhigh) — area payout (legend-liw8n)

## Peran
Baca `~/.agents/team/roles/second-opinion.md`, lalu ikuti. Read-only: jangan ubah kode, jangan commit, jangan jalankan `bd`.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Review read-only di worktree baru: `git worktree add --detach .worktrees/so-payout origin/ws/payout-api-gaps`. Diff: `git diff origin/milestone/m1...origin/ws/payout-api-gaps` dan `git diff origin/milestone/m1...origin/ui/payout-finance-exceptions`.

## Fokus (uang dan akses)
Pembayaran ganda atau lebih, bukti batch/tenant lain dipakai, kebocoran nomor rekening penuh, migrasi 0600 (CHECK, trigger PAYOUT-24, RLS), unggah file (tipe asli, ukuran, pemindai fail-closed), paginasi cursor, guard permission/MFA/trusted origin, dan UI yang menampilkan atau memicu aksi uang tanpa guard server.

## Laporan
Temuan diurut keparahan: file:baris, skenario gagal konkret, saran perbaikan. Tandai yang sudah diketahui (legend-01gg8 bukti tidak dicek ada, legend-2t69x PDF 503). Hapus worktree setelah selesai.
