# 192c hasil architect (legend-sduiq), 9 Nov 2026

Diperiksa di `integ/m1-batch28` 1f83d4aa. Merge sduiq: 38cd3585 (fefbb93b).

**Bersih.** Tidak ada temuan P1/P2.

Yang dicek:
- Cloud: `listDeviceReceiptSequences` (pos-receipt.service.ts:1256) mengirim daftar penuh run sekarang yang terikat ke (node, instance) ini, di setiap halaman, sesudah klaim di transaksi yang sama. Edge memensiunkan run lokal yang terpakai di sini (binding sendiri atau NULL) bila tidak ada di daftar (:1455-1488). Ini berjalan di transaksi apply yang sama dan di bawah lock outlet.
- Penjualan yang bersamaan menunggu lock baris. Sesudah itu `retired_at IS NULL` gagal, jadi hasilnya CONFLICT, bukan nomor pada run pensiun.
- Edge normal tidak kehilangan run. Klaim selalu mengikat atau memutar semua run perangkat aktif ke binding ini, dan run perangkat dicabut tetap terdaftar.
- Daftar kosong, daftar ditolak (error ditangkap, `retired` = 0), daftar tanpa entri binding sendiri, dan standby tidak memensiunkan apa pun (edge-device-sync.ts:624-632, 658-677, 891-904).
- Bila pengganti ditolak, edge tidak lagi menomori run yang sudah dipensiunkan cloud. Perangkat fail closed. Pemulihan otomatis untuk bentrok prefix/id datang dari hfq3z.
- Field status opsional (`receiptSequencesRetired(+At)`) cocok dengan pola refused/alert. Tidak ada migrasi.

P3 (catatan, tanpa kartu):
- Pengganti yang ditolak karena cloud lastNumber > 0 baru pulih lewat rotasi regresi. Rotasi itu berbagi throttle 2 per 24 jam, jadi perangkat bisa terblokir sampai 24 jam (dengan alert). Ini fail closed yang disengaja.
