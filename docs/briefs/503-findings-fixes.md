# 503 temuan second-opinion ledger guards (Codex G5xq7, 11 Nov) dan keputusan CTO

Cabang: ws/ledger-guards (0122d475). Migrasi tambahan sementara: 0317-0319 (jangan pakai 0320+). Tingkat K (uang): architect effort xhigh di akhir. Semua fix wajib test gagal-dulu; konkurensi pakai test dua koneksi.
Peran: engineer Sonnet (~/.agents/team/roles/engineer.md). Spawn test-writer + implementer per butir sekaligus (file 0312 vs 0313 vs service terpisah; 2-3 butir di 0313 satu implementer).

1. P1 0312:32 buka ulang periode melewati approval (UPDATE langsung status/version).
   Keputusan: cabut UPDATE langsung kolom transisi dari legend_app; transisi hanya lewat fungsi DB yang memvalidasi permintaan reopen yang approved dan pemisahan pelaku (peminta != penyetuju). Service ikut pindah ke fungsi itu. Test: UPDATE mentah ditolak; reopen tanpa approval ditolak; peminta=penyetuju ditolak.
2. P1 0313:178 satu koreksi membalik nominal dua kali lewat konkurensi.
   Keputusan: klaim jurnal koreksi secara atomik (satu koreksi = satu pemakaian; konflik juga menggagalkan snapshot basi). Test dua koneksi REPEATABLE READ: hanya satu sukses, total dibalik <= nilai koreksi.
3. P1 0313:114 koreksi yang sudah dibalik masih diterima.
   Keputusan: tolak koreksi yang punya jurnal pembalik; penautan dan reversal saling eksklusif (termasuk konkuren). Test kedua urutan.
4. P2 0313:62 INSERT melewati unique index aktif lewat reversed_at nonnull.
   Keputusan: tolak reversed_at nonnull saat INSERT (trigger) atau grant INSERT per kolom; pilih yang lebih ketat. Test konkuren.
5. P2 accounting-fixed-assets.service.ts:807 repost melewatkan bulan yang sebelumnya nol.
   Keputusan: horizon pemrosesan termasuk bulan nol; posting semua bulan positif jadwal baru sampai horizon, precheck periode tertutup sebelum tulis apa pun. Test kasus Rp3 -> Rp12 juta dari laporan: akumulasi sampai Oktober = Rp9,6 juta.

Aturan uang: tidak ada nominal yang bisa dibalik/diposting lebih dari sekali; bila ragu, tolak (409) daripada tulis.
Laporan: bukti gagal-dulu per butir, gate (tsc api heap 6144, eslint, prettier, db:generate), angka subagent, temuan architect. Push ke origin/ws/ledger-guards.
