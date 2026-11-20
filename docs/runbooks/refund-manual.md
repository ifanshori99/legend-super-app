# Runbook: refund manual

Untuk manajer dan finance. Dipakai bila refund tidak bisa atau tidak boleh dibayar otomatis oleh penyedia (Duitku), dan untuk refund penjualan kasir yang dibuat saat offline.

Catatan sumber: nomor `[n]` di tiap langkah menunjuk ke bagian "Sumber" di bawah. Baris diambil dari cabang/worktree yang disebut di sana, bukan dari checkout `main` ini (lihat "Yang belum pasti").

## Aturan utama

1. Refund hanya dibayar bila ada bukti dari penyedia atau bukti transfer. Tanpa bukti: jangan bayar, jangan dicatat (founder, keputusan no.9). [1]
2. Satu refund, satu pembayaran. Bila ragu penyedia sudah membayar, jangan transfer. Cek dulu. [2]
3. Mencatat refund manual wajib lewat verifikasi dua langkah (MFA) dan izin `payment.reconcile`. [3]

## A. Refund Duitku dibayar manual

Kapan: refund berstatus `approved` (sudah disetujui) tetapi tidak dikirim otomatis. Contoh: refund otomatis penyedia dimatikan, atau refund macet dan ditandai untuk dicek manual. [4]

Batas layar: refund macet yang sudah punya referensi penyedia (tanda `MANUAL_RECONCILIATION` atau `PAYOUT_NOT_FOUND_MAYBE_SENT`) TIDAK bisa dicatat dari layar; tombol "Catat refund manual" tidak muncul. Eskalasi ke tim teknis untuk memastikan di penyedia. Layar sengaja dibatasi supaya pembeli tidak dibayar dua kali (keputusan CTO). [23]

Langkah:

1. Manajer menyetujui refund (status `approved`). Hanya refund `approved` yang bisa dicatat manual; status lain ditolak "REFUND_NOT_SETTLEABLE". [5]
2. Finance cek ke dashboard Duitku bahwa uang belum dikembalikan ke pembeli.
   - Bila refund sudah punya referensi penyedia, poll, atau percobaan kirim, sistem menanyakan status ke penyedia lebih dulu. [6]
   - Penyedia menjawab "berhasil": ditolak (`REFUND_PROVIDER_PAID`), refund selesai sendiri sebagai dibayar penyedia. Jangan transfer. [7]
   - Penyedia masih "pending": ditolak (`REFUND_PROVIDER_PENDING`). Tunggu. Pencatatan manual saat penyedia masih pending dimatikan (keputusan legend-17ml). [8]
   - Penyedia "tidak ditemukan", tidak menjawab, atau menjawab untuk referensi lain: ditolak (`PROVIDER_REFUND_STATUS_UNKNOWN`). Hubungi Duitku untuk memastikan, lalu coba lagi. [9]
   - Bila sistem menolak dengan `REFUND_AT_PROVIDER`, penyedia sudah memegang refund ini; biarkan pengecekan otomatis menyelesaikannya. [10]
3. Bila boleh, manajer atau finance mentransfer manual sesuai jumlah refund persis. Simpan bukti transfer.
4. Catat lewat layar: Kelola > Pembayaran > Refund, buka refund itu lewat "Tinjau", lalu tekan "Catat refund manual". Tombol hanya muncul bagi akun dengan izin `payment.reconcile` dan hanya untuk refund `approved` yang belum punya referensi penyedia. [23]
   - Langkah 1 (isi bukti): tanggal dan jam transfer (tidak sebelum refund diajukan, tidak di masa depan), cara pembayaran (transfer bank, tunai, dompet digital, dashboard penyedia, lainnya), referensi transfer (3 sampai 100 karakter, bukan nomor rekening pembeli), jumlah yang dibayar (harus sama persis dengan jumlah refund), dan catatan (3 sampai 500 karakter). [11] [12] [13]
   - Langkah 2 (konfirmasi): periksa ringkasan, lalu tekan "Ya, catat refund manual". Kirim ulang setelah gagal memakai kunci yang sama, jadi tidak tercatat dua kali. [23]
   - Bila sistem meminta verifikasi dua langkah (`MFA_REQUIRED`), masuk ulang dengan verifikasi dua langkah, lalu catat lagi. [3]
   - Penolakan tampil dalam Bahasa Indonesia di layar yang sama (kode di daftar "Penolakan lain" dan di langkah 2 di atas). [23]
   - Endpoint di balik layar: `POST /api/payments/admin/refunds/:refundId/settle-manually`. [11]
5. Hasilnya: refund menjadi `completed` dengan tanda "dibayar di luar penyedia", pembayaran menjadi (sebagian) direfund, dan tercatat di audit `payment.refund_settled_manually` lengkap dengan bukti. [14]

Penolakan lain yang mungkin muncul:

- `REFUND_CAP_EXCEEDED`: refund melebihi sisa yang boleh direfund. Jangan bayar. [15]
- `REFUND_PAYOUT_IN_FLIGHT`: ada percobaan kirim berjalan. Coba lagi beberapa menit kemudian (sistem menunggu sampai masa sewa percobaan kirim berakhir, ditambah 10 menit: `SETTLEMENT_STALL_MARGIN_MS`). [16]
- `REFUND_LOOKUP_STALE`: data refund berubah saat penyedia ditanya. Ulangi. [17]
- `MFA_REQUIRED`: login ulang dengan verifikasi dua langkah. [3]

- `PROVIDER_REFUNDED`: penyedia sudah mengembalikan dana ke pembeli. Jangan transfer dan jangan dicatat; tutup lewat jalur release. [18] [24]

Bila refund sudah terlanjur dikembalikan penyedia ke pembeli, jangan dicatat manual; refund dilepas/ditutup lewat jalur release. [18]

## B. Refund penjualan kasir yang dibuat saat offline

Kapan: kasir melakukan refund ketika perangkat kasir offline (jalur edge lama), lalu kejadiannya diparkir dan belum punya catatan refund resmi di pusat. [19]

Langkah:

1. Manajer outlet membayar tunai kepada pelanggan dan menyimpan struk atau catatan. Jumlah tidak boleh melebihi yang dibayar pada pesanan itu.
2. Finance membuka daftar pengecualian keuangan dan mencari jenis `edge_refund_unreconciled`. Satu baris = satu pesanan yang punya refund offline terparkir tanpa catatan refund resmi. Daftar ini tidak dibatasi tanggal dan hanya menampilkan outlet yang boleh dilihat si pemeriksa. [19]
3. Baca kolom detail tiap baris: [20]
   - `within_paid`: jumlah refund masih dalam jumlah yang dibayar. Cocokkan dengan uang tunai yang dikeluarkan manajer.
   - `exceeds_paid`: total refund melebihi yang dibayar. Selidiki sebelum apa pun; kemungkinan salah atau ganda.
   - `order_unknown`: pesanan tidak dikenal di pusat. Telusuri ke outlet.
   - `unreadable`: data tidak bisa dibaca atau diverifikasi; jumlah tidak ditampilkan. Telusuri ke outlet.
4. Sampai baris itu selesai, sistem menahan refund berikutnya untuk pesanan yang sama (`REFUND_HISTORY_UNVERIFIED`), supaya uang tidak dibayar dua kali. [21]
5. Cara menandai selesai: tidak ada tombol "tandai selesai". Baris hilang sendiri bila sudah ada catatan refund resmi (`pos_order_refunds`) dengan id refund, pesanan, dan jumlah yang sama. Id saja tidak cukup. [22]

## C. Yang tidak boleh

- Refund tanpa bukti penyedia atau bukti transfer. [1]
- Transfer manual saat penyedia masih memproses atau sudah membayar. [8] [7]
- Mencatat jumlah yang berbeda dari jumlah refund, atau melebihi sisa yang boleh direfund. [13] [15]
- Menonaktifkan atau menghindari MFA untuk mencatat refund manual. [3]
- Menganggap baris `edge_refund_unreconciled` beres karena uang tunai sudah keluar; baris itu baru beres setelah catatan resmi cocok. [22]

## Sumber

Kode yang dibaca (path relatif ke root repo; worktree `legend-int-batch106` untuk refund Duitku, `legend-1244` untuk cabang `ws/1244-edge-refund-exception`):

- [1] `docs/briefs/1255-1258-keputusan-founder.md:23-24` (keputusan no.9, dikutip di kartu 1258; teks keputusan asli di `docs/founder/keputusan-2026-11-21.md`, tidak dibaca)
- [2] `apps/api/src/services/payment-refund.service.ts:3634-3641`
- [3] `apps/api/src/services/payment-refund.service.ts:3810-3812`; `apps/api/src/routes/payment-admin.routes.ts:363-367` (`payment.reconcile`)
- [4] `apps/api/src/services/payment-refund.service.ts:2103-2117` (otomatis dimatikan), `:3611-3614` (ditandai macet)
- [5] `apps/api/src/services/payment-refund.service.ts:3821-3826`
- [6] `apps/api/src/services/payment-refund.service.ts:3643-3675`
- [7] `apps/api/src/services/payment-refund.service.ts:3742-3747`
- [8] `apps/api/src/services/payment-refund.service.ts:3585`, `:3748-3757`
- [9] `apps/api/src/services/payment-refund.service.ts:3696-3704`, `:3719-3724`, `:3741`
- [10] `apps/api/src/services/payment-refund.service.ts:3858-3866`
- [11] `packages/shared/src/payment/admin.ts:409-415`, `:426-442`, `:993-999`; `apps/api/src/routes/payment-admin.routes.ts:363-380`
- [12] `apps/api/src/services/payment-refund.service.ts:3574`, `:3890-3898`
- [13] `apps/api/src/services/payment-refund.service.ts:3884-3889`
- [14] `apps/api/src/services/payment-refund.service.ts:3899-3913`, doc `:3760-3769`
- [15] `apps/api/src/services/payment-refund.service.ts:3838-3854`
- [16] `apps/api/src/services/payment-refund.service.ts:3576-3577`, `:3871-3883`
- [17] `apps/api/src/services/payment-refund.service.ts:3726-3735`
- [18] `apps/api/src/services/payment-refund.service.ts:3827-3829`, pesan `:1940`
- [19] `apps/api/src/services/accounting-finance-exceptions.service.ts:16-18`, `:962-971` (cabang 1244)
- [20] `apps/api/src/services/accounting-finance-exceptions.service.ts:1060-1110` (cabang 1244)
- [21] `apps/api/src/services/accounting-finance-exceptions.service.ts:963-967` (cabang 1244); `apps/api/src/services/payment-refund-approval-limits.ts:409`, `:517` (cabang 1244)
- [22] `apps/api/src/services/accounting-finance-exceptions.service.ts:987-1008`, `:1039-1048` (cabang 1244)
- [24] `apps/api/src/services/payment-provider-refunded-guard.ts:26`, `:143`
- [23] `apps/web/src/features/ws05-payment-admin/components/refund-followup-dialog.tsx` (`ManualSettleStep`), `manual-settlement.ts` (cabang 1259)

## Yang belum pasti

- Layar "Catat refund manual" (kartu 1259) ada di cabang `ws/1259-manual-refund-ui`; sebelum cabang itu digabung, langkah A.4 hanya bisa lewat endpoint API. Tangkapan layar ada di `docs/review/img/refund-manual-*`.
- Cara finance membuka daftar pengecualian (layar atau endpoint) tidak diverifikasi di runbook ini.
- Kode dibaca dari worktree, bukan dari checkout `main`; nomor baris bisa bergeser setelah merge.
- Pembayaran tunai manajer untuk refund offline (B.1) tidak diwajibkan atau dicatat oleh kode yang dibaca; itu prosedur, bukan fitur sistem.
