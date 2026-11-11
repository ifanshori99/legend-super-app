# 523 Fix temuan Codex 522 admin pembayaran (untuk G92j5, worktree .worktrees/ws05-pay-admin, cabang ws/ws05-pay-admin)

Keputusan CTO: betulkan semua sesuai usulan.
1. P2 payment-admin-config.service.ts:555: hapus default kasir secara atomik dengan kondisi terminal/metode terkini (DELETE ... WHERE terminal_id = A AND ...), bukan by ID hasil baca. Test race dua koneksi (deaktivasi A vs pindah D->B): default B tetap.
2. P2 mock.ts:599: resolve dana di mock membuat refund pending terkait dana, permintaan kedua key beda -> 409, replay key sama -> jawaban tersimpan; refund muncul di approval.
3. P3 mock.ts:332: mock membersihkan default saat terminal nonaktif/metode dicabut dan menyaring saat GET.
Plus jawaban founder Q63 (batas nominal per level penyetuju) bila sudah ada di catatan CTO; bila belum, jangan dikerjakan.
Bukti: test gagal-dulu, test terarah lewat heavy, tsc, eslint/prettier. Commit, push (tanpa --force). Satu laporan akhir.
