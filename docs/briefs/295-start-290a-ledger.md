# Brief: engineer (Opus) — WS-08 legend-111j profil, consent, buku poin (290a)

Brief lengkap: `docs/briefs/290a-111j-profile-consent-ledger.md` di cabang `docs/arch-member-loyalty` (b07b1032 = milestone/m1 d2080951 + dokumen desain member). Baca itu dan `docs/briefs/290-aturan-bersama.md`, `docs/design/ws08-member-loyalty.md`, lalu ikuti.

Dua perubahan dari brief 290a (CTO, 10 Nov):
1. Cabang `ws/ws08-111j` dibuat dari `docs/arch-member-loyalty` (bukan langsung dari m1), supaya dokumen desain ikut di worktree. Worktree `.worktrees/ws08-111j`. Disk Mac sempit: jangan buat worktree tambahan.
2. Migrasi: `0203`, `when` 1794282000000 (bukan 0193). Nomor 0193-0197 di desain sudah lewat: m1 akan lebih dulu menerima migrasi sampai 0202, dan migrator Drizzle melewati `when` yang lebih kecil dari yang sudah terpasang. `prevId` = snapshot terakhir di m1; merge train merangkai ulang bila perlu.

Jangan push, jangan merge. Laporan sekali di akhir sesuai brief 290a.
