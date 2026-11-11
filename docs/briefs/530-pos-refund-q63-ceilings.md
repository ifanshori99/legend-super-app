# 530 Batas refund Q63 untuk refund POS (legend-qrfv8, tingkat K uang)

Langkah 0: `git worktree add .worktrees/pos-refund-ceilings -b ws/pos-refund-ceilings origin/ws/ws05-pay-admin` (basis a4dae5fb, sudah berisi batas Q63 kumulatif untuk refund admin).
Masalah: batas Q63 (Supervisor <= Rp200.000, manajer outlet <= Rp1.000.000, GM <= Rp5.000.000, di atas itu hanya owner) sudah berlaku di refund admin, tetapi refund POS (kasir/supervisor di POS, termasuk edge) belum. Ini celah: refund besar bisa lewat jalur POS.
Tujuan: pakai aturan batas yang SAMA (satu fungsi bersama, jangan duplikasi) di semua jalur refund POS. Batas dihitung terhadap total refund pesanan itu dari SEMUA jalur (admin + POS + edge), tanpa menggandakan mirror gateway. Level penyetuju diambil dari peran pengguna yang menyetujui/PIN override, dicek di server.
Edge offline: bila edge tidak bisa membuktikan total refund sebelumnya, refund di edge dibatasi ke batas level terendah yang aman atau ditolak sampai online; pilih yang membatasi pembayaran dan catat sebagai keputusan.
Test wajib (jangan sampai rugi): tiap level tepat di batas lulus, Rp1 di atas ditolak; refund dipecah lintas jalur (admin Rp150rb + POS Rp100rb oleh Supervisor) ditolak; owner tanpa batas; total refund tidak melebihi bayar; edge offline tidak bisa melewati batas.
Tanpa migrasi kecuali perlu (rentang 0335 saja). Explore jalur refund POS dulu. Test gagal-dulu, test terarah + tsc lewat `heavy`.
Selesai: commit + push ws/pos-refund-ceilings (tanpa --force). Laporan akhir: jalur yang ditutup, keputusan edge offline, hash, test + hasil, angka subagent.
