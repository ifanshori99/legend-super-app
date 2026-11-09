# Brief: engineer (Opus) — WS-01 legend-k2l login member dan graf identitas (290b)

Brief lengkap: `docs/briefs/290b-k2l-member-signin-identity.md` di cabang `docs/arch-member-loyalty` (b07b1032 = milestone/m1 d2080951 + dokumen desain member). Baca itu dan `docs/briefs/290-aturan-bersama.md`, `docs/design/ws08-member-loyalty.md`, lalu ikuti.

Perubahan dari brief 290b (CTO, 10 Nov):
1. Cabang `ws/ws01-k2l` dibuat dari `docs/arch-member-loyalty`, supaya dokumen desain ikut di worktree. Worktree `.worktrees/ws01-k2l`. Disk Mac sempit: jangan buat worktree tambahan.
2. Migrasi: `0204`, `when` 1794283000000 (bukan 0194). `prevId` = snapshot terakhir di m1; merge train merangkai ulang bila perlu.
3. `ws/ws08-111j` (290a, legend-111j) sedang dikerjakan paralel oleh thread lain. Jangan sentuh berkas miliknya; bagian kode yang menunggu 290a tulis di laporan.
4. Kunci Brevo dan Google OAuth belum ada. Bangun jalurnya, dan biarkan mati bila kuncinya kosong. Tes memakai tiruan, tanpa kunci asli. Jangan baca `.env*`; nama key ambil dari `.env.example`.

Jangan push, jangan merge. Laporan sekali di akhir sesuai brief 290b.
