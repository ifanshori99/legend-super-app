# Brief: second-opinion — WS-03 pindah dan gabung meja

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree baca: `git worktree add --detach .worktrees/so-419 origin/milestone/m1`, hapus setelah selesai.
Rentang: commit di `git log --oneline origin/milestone/m1 -- apps/api/src/services/table-session-operations.service.ts` yang menyangkut pindah/gabung meja (split bill sudah direview di brief 380; jangan ulang). Baca versi terkini di m1.

## Invariant
- Pindah/gabung meja tidak menggandakan atau menghilangkan item, pembayaran, diskon, atau service charge.
- Aman saat dua kasir memindah/menggabung meja yang sama bersamaan; status sesi meja konsisten.
- Tidak bisa memindah ke meja outlet/tenant lain; RLS.
- Sesi yang sudah dibayar sebagian: sisa tagihan dan pembayaran tetap benar setelah gabung.
- Audit mencatat siapa memindah/menggabung.

## Effort
xhigh (uang).

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
