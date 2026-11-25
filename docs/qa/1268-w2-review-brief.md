# 1268 W2 (layar bayar dan struk): brief review uang

Worktree `../legend-1268-w2`, diff `0c541105e..2e377153d` (30 file). Acuan: `docs/briefs/1268-pos-wire.md` bagian W2; aturan "jangan sampai rugi" di `~/.agents/main.md`. Read-only; jangan jalankan suite penuh.

Periksa:
1. Hasil bayar tidak jelas: semua metode terkunci, kirim ulang byte sama, kunci tidak pernah berganti diam-diam (reload, tab ganda, storage gagal, dua perangkat untuk satu tagihan, ganti kasir/outlet).
2. Tunai: kembalian, bayar kurang/lebih, double tap. QRIS tap-only: kedaluwarsa, QR lama dibayar, batal lalu bayar. EDC manual: approval code dan total.
3. Struk: `printResult` jujur, cetak ulang tercatat, tidak ada data kartu/PII berlebih.
4. "Batal memakai kunci baru tiap tap": aman di server? Buktikan dengan membaca service.
5. Konflik dengan W1 (`../legend-1268-w1`, ws/1268-w1) saat digabung.
6. Tes ditulis sesudah kode (7/7 mutasi tertangkap): cek tesnya bermakna.

Keputusan yang diminta (usulkan, pilih paling membatasi yang tidak membuat kasir buntu):
a. Hanya kasir awal yang bisa kirim ulang; bagaimana bila kasir itu pulang?
b. Catatan rusak tidak punya jalan buka kunci. Usulan CTO: buka hanya bila server dibaca ulang dan membuktikan tidak ada pembayaran berjalan/lunas di tagihan itu, dengan izin supervisor dan alasan; jika server tidak bisa dibaca tetap terkunci.

Laporan maks 15 baris: LULUS / TIDAK, temuan P1-P3 dengan file:baris dan perbaikan, jawaban a/b.
