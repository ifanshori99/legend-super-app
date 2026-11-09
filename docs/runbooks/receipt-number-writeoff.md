# Hapus nomor struk yang hilang (write-off) (legend-0hzqw)

Runbook ini untuk owner tenant. Write-off menandai satu nomor struk (prefix + nomor urut) sebagai hilang permanen, dengan alasan tertulis. Setelah itu nomor tersebut dihitung seperti sudah ada, sehingga Tutup Hari bisa berjalan lagi.

## Kapan dipakai

- Tutup Hari ditolak dengan pesan: `Ada nomor struk yang hilang di outlet ini: ...`.
- Nomor yang hilang berasal dari perangkat yang sudah tidak aktif, perangkat yang dicabut, atau run yang sudah pensiun. Tidak ada perangkat yang bisa mengirim ulang nomor itu.

Jangan dipakai untuk menutupi nomor yang masih mungkin dikirim perangkat. Write-off tidak bisa dibatalkan.

## Cek dulu sebelum write-off

1. Cari struk di perangkat yang bersangkutan dan di cadangan edge (jika outlet memakainya). Pastikan nomor itu benar-benar tidak ada.
2. Cek status sinkronisasi. Pastikan perangkat tidak punya data yang belum terkirim.
3. Pastikan nomor itu memang tidak pernah dipakai untuk transaksi.
4. Catat alasan. Alasan wajib 10 sampai 500 karakter dan akan ikut tercatat di audit.

## Cara menjalankan

Hanya owner tenant yang punya izin `pos.receipt.writeoff`. Endpoint hanya berjalan di cloud, tidak di edge.

Ganti `:outletId` dengan ID outlet.

Tulis write-off (`POST`):

```
POST /outlets/:outletId/pos/receipt-writeoffs
{ "prefix": "C", "sequenceNumber": 2, "reason": "Struk fisik hilang, perangkat dicabut 3 Nov" }
```

Lihat daftar write-off outlet, terbaru di atas (`GET`):

```
GET /outlets/:outletId/pos/receipt-writeoffs
```

Respons berhasil `201` dengan `{ "data": ... }`. Setelah berhasil, jalankan lagi Tutup Hari.

Kemungkinan penolakan:

- `409`, nomor di luar rentang yang sudah terbit (lebih besar dari nomor terakhir).
- `409`, nomor ini sudah punya struk.
- `409`, nomor ini sudah di-write-off sebelumnya.
- `404`, prefix tidak dikenal.
- `403`, pengguna bukan owner.
- `400`, alasan kurang dari 10 karakter.

## Yang tercatat

Setiap write-off masuk audit dengan aksi `pos.receipt.written_off`. Audit mencatat pelaku, alasan, prefix, nomor urut, dan nomor struk yang sudah diformat. Data ini disimpan 2 tahun.

Di laporan shift, nomor tersebut tampil sebagai "di-write-off", bukan sebagai celah.

## Yang perlu disampaikan ke kasir

- Nomor struk itu tidak akan muncul lagi dan tidak bisa dikembalikan.
- Transaksi baru tetap memakai nomor berikutnya seperti biasa.
