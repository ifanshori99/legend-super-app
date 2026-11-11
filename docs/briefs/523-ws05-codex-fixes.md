# 523 Fix temuan Codex 522 admin pembayaran (untuk G92j5, worktree .worktrees/ws05-pay-admin, cabang ws/ws05-pay-admin)

Keputusan CTO: betulkan semua sesuai usulan.
1. P2 payment-admin-config.service.ts:555: hapus default kasir secara atomik dengan kondisi terminal/metode terkini (DELETE ... WHERE terminal_id = A AND ...), bukan by ID hasil baca. Test race dua koneksi (deaktivasi A vs pindah D->B): default B tetap.
2. P2 mock.ts:599: resolve dana di mock membuat refund pending terkait dana, permintaan kedua key beda -> 409, replay key sama -> jawaban tersimpan; refund muncul di approval.
3. P3 mock.ts:332: mock membersihkan default saat terminal nonaktif/metode dicabut dan menyaring saat GET.
Plus jawaban founder Q63 (11 Nov 21:45, kerjakan): batas nominal refund per level penyetuju. Supervisor <= Rp200.000, manajer outlet <= Rp1.000.000, GM <= Rp5.000.000, di atas Rp5.000.000 hanya owner. Batas dicek di server (bukan hanya UI), terhadap total refund pesanan itu (gabungan refund sebelumnya, supaya tidak dipecah jadi beberapa refund kecil). Test: tiap level tepat di batas lulus, Rp1 di atas batas ditolak, refund dipecah ditolak, owner tanpa batas.
Bukti: test gagal-dulu, test terarah lewat heavy, tsc, eslint/prettier. Commit, push (tanpa --force). Satu laporan akhir.
