# 1063 Perbaikan SO refund ronde 5
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Sesi baru (G2ve6 sudah compact 3x): mulai dari entri 1055 di docs/PROGRESS.md.
Cabang: worktree dasar `ghostex/1033-kredit-dp-pool-net-bersama` 2a525b3d3.
Temuan: `docs/qa/second-opinion-refund-ronde5-1062.md` (skenario dan usul test lengkap).
- legend-9dh7x (P1): pengenalan echo refund sendiri wajib membuktikan intent + transaksi sumber; ID yang dikenal di transaksi lain memasang hold konflik sebelum keluar. Fund T2 tidak boleh bisa di-request/approve/payout selama konflik.
- legend-awdwd (P1): hold yang terwakili fact hanya dikecualikan bila `providerPaymentRef` sama; hold konflik tetap mengurangi kredit DP (asli dan pindahan). Uji kedua urutan lock dengan barrier.
- legend-flj83 (P2): simpan ikatan `same_as_counted` ke fact anonim yang dipakai; pilih hanya fact belum terikat. Dua anonymous beda nominal, kedua urutan + replay, total tepat Rp30.000.
Keputusan CTO (aturan restriktif): saat ragu, tahan (hold) dan kurangi kredit; jangan pernah membuka dana selama konflik belum diselesaikan finance.
Bukti: test gagal-dulu tiap temuan, regresi berkas refund/hold/poller/kredit DP via heavy, pra-gate AGENTS.md. Migrasi baru bila perlu: rentang kerja 0679-0680.
Review: satu subagent architect xhigh (uang). Commit + push tanpa force, update docs/PROGRESS.md, tutup bead, lapor.
