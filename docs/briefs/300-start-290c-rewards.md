# Brief: engineer (Opus) — WS-08 legend-m4p5 katalog hadiah, penukaran, misi, voucher (290c)

Brief lengkap: `docs/briefs/290c-m4p5-rewards-missions.md` (ada di cabang dasar di bawah). Baca itu, `docs/briefs/290-aturan-bersama.md`, dan `docs/design/ws08-member-loyalty.md`, lalu ikuti.

Perubahan dari brief 290c (CTO, 10 Nov):
1. Cabang `ws/m4p5-rewards` dibuat dari `ws/ws08-111j` (e15950fe, buku poin 290a yang sudah selesai dan belum masuk m1), bukan dari m1. Worktree `.worktrees/m4p5-rewards`. Disk Mac sempit: jangan buat worktree tambahan.
2. Migrasi: `0207`, `when` 1794286000000 (bukan 0195). `prevId` = snapshot 0203 di cabang dasar; merge train merangkai ulang.
3. Tambahan dari review 290a: kerjakan juga `legend-wa4hp` (void dan refund ikut menurunkan jumlah kunjungan dan total belanja member), karena misi membaca angka itu.
4. Penyimpangan 290a yang sudah diterima CTO, jangan diubah: FK `orders` pola 2 contracts.md, event `points.*` tingkat tenant (`outletId` null), grant INSERT `points_balance` dijaga trigger saldo nol. Ringkasan lengkap: `bd comments legend-111j`.
5. Thread lain mengerjakan login member (`ws/ws01-k2l`) dan split bill (`ws/split-bill`) paralel: jangan sentuh berkasnya.

Jangan push, jangan merge. Laporan sekali di akhir sesuai brief 290c.
