# E6 koreksi sale edge dari back office: keputusan CTO (27 Nov)

Bead legend-osqou.27. Dasar: founder no. 30 (untung, jangan merugikan kafe, standar kafe/resto Indonesia), prinsip "jangan sampai rugi" (aturan paling membatasi pembayaran).

## Prinsip
- Cloud adalah satu-satunya buku besar refund untuk sale edge yang sudah ter-ingest. Batas refund = nilai bayar tender dikurangi refund yang sudah ada (dikunci per order, idempoten per kunci).
- Hanya refund. Back office tidak boleh void sale edge sesudah bayar (D3). Void tetap hanya di kasir sebelum bayar.
- Izin: izin refund back office yang sudah ada + approval Owner/Finance sesuai aturan refund yang berlaku; alasan wajib; audit.
- Order failover (seri F) sesudah kembali ke edge tetap ditolak (keputusan F3 v1, bead legend-sxj96.2).

## D1 bagian tunai
Laci milik edge; back office tidak menyentuh shift/laci. Refund tunai dicatat sebagai "dibayar Finance di luar laci" (transfer atau kas kecil), wajib referensi pembayaran (nomor bukti transfer/kas kecil) dan approval Owner/Finance. Jurnal ke akun kas kecil/bank, bukan laci shift. Tanpa referensi = tetap `requested`, belum dianggap refund.

## D2 bagian kartu (EDC)
Refund kartu dilakukan supervisor di terminal outlet (refund/void bank manual). Back office mencatat refund dengan RRN dan kode approval slip refund. Status `requested` sampai referensi itu diisi; baru `succeeded` sesudahnya. Satu RRN refund tidak boleh dipakai dua kali (unik).

## D3
Hanya refund penuh atau sebagian. Tidak ada void sesudah bayar dari back office.

## D4 edge tahu refund?
Tidak di v1. Uang refund hanya di cloud, jadi tidak ada refund ganda dari edge (edge menolak refund sesudah bayar; refund online lewat cloud memakai batas yang sama). Laporan resmi dibaca dari cloud. Rekap lokal edge tetap angka sebelum refund; tampilkan label "belum termasuk refund back office" bila ada layar rekap edge. Kanal cloud->edge untuk ini: bead terpisah bila diperlukan.

## E4 P3
- (a) baris cloud `pending` yang tertinggal karena penolakan sesudah `created` dicerminkan: pindahkan ke status akhir gagal/ditolak yang sudah ada dengan alasan `edge_refused`, idempoten; tidak pernah `succeeded`.
- (b) rekonsiliasi cloud pada baris edge: hanya boleh mencocokkan settlement (tandai settled), tidak boleh mengubah nominal atau status bayar.
- (c) penjualan edge disetujui tanpa tender terkait: `hasOpenEdcRequest` harus false sesudah sale ter-ingest (tutup request terbuka).

## Test wajib
Refund ganda (kunci sama/berbeda) dan refund lebih dari nilai bayar ditolak; refund tunai tanpa referensi tidak mengurangi uang; RRN refund dipakai dua kali ditolak; void sesudah bayar dari back office ditolak; order seri F sesudah return ditolak; tenant/outlet lain 404.
