# Mockup tambahan POS — WS-04

Mockup statis untuk review, bukan aplikasi atau bukti pembayaran. Semua identitas, waktu dan nominal adalah data contoh. Mengikuti arah POS di `DESIGN.md` dan `common.css`; tidak mengubah layar shift atau supervisor yang dikerjakan thread lain. Gambar memakai lebar 390 px dan 1280 px; struk publik hanya 390 px. Tinggi gambar mengikuti isi agar tidak terpotong.

| Kartu | Sumber dan contoh gambar | Keadaan |
| --- | --- | --- |
| `legend-1uk9` | [Struk elektronik](pos-extra-1uk9-struk.html) · [390](pos-extra-1uk9-struk-normal-390.png) | Normal, memuat, gagal, tautan tidak tersedia |
| `legend-shabi` | [Tagih selisih](pos-extra-shabi-charge.html) · [1280](pos-extra-shabi-charge-normal-1280.png) · [390](pos-extra-shabi-charge-normal-390.png) | Belum lunas, memproses, status belum pasti, lunas |
| `legend-pspy` | [Kas keluar dan jejak shift](pos-extra-pspy-shift.html) · [1280](pos-extra-pspy-shift-supervisor-1280.png) · [390](pos-extra-pspy-shift-supervisor-390.png) | Tercatat, supervisor, kosong, memuat, gagal |
| `legend-0ixe` | [Pemberitahuan dapur](pos-extra-0ixe-notice.html) · [1280](pos-extra-0ixe-notice-notice-1280.png) · [390](pos-extra-0ixe-notice-notice-390.png) | Pemberitahuan, kosong, memuat, gagal |
| `legend-hn5q` | [Karantina refund](pos-extra-hn5q-karantina.html) · [1280](pos-extra-hn5q-karantina-karantina-1280.png) · [390](pos-extra-hn5q-karantina-karantina-390.png) | Karantina, konfirmasi pelepasan, dilepas, buka ulang, kosong, gagal, memuat |
| `legend-kfkt` | [Tindak lanjut refund](pos-extra-kfkt-refund.html) · [1280](pos-extra-kfkt-refund-failed-1280.png) · [390](pos-extra-kfkt-refund-unknown-390.png) | Ditolak, gagal final, coba ulang setelah gagal sementara, hasil belum pasti, menunggu, kosong, memuat, gagal memuat |

Gambar lain memakai nama `pos-extra-<kartu>-<layar>-<keadaan>-<lebar>.png`; keadaan juga dapat dipilih dengan `?screen=<keadaan>` pada HTML. `supervisor.html` dan `shift.html` sudah diperiksa: keduanya belum memperlihatkan kondisi khusus enam kartu ini secara lengkap.

## Keputusan desain

1. Status dan langkah berikutnya ditempatkan dekat transaksi: pemberitahuan dapur tidak langsung mengubah tagihan; kasir memeriksa dan mengajukan void POS.
2. Kas keluar tertahan hanya ditampilkan kepada supervisor. Jejak memisahkan selisih fisik dari selisih buku; contoh Rp2.230.000 − Rp2.250.000 + Rp200.000 = Rp180.000.
3. Hasil refund yang belum pasti meminta pemeriksaan status sebelum percobaan ulang. Pelepasan karantina mengakhiri refund sebagai gagal dan melepas cadangan; buka ulang mengembalikannya ke status menunggu untuk ditinjau.

## Pemeriksaan dan batas

Chromium Playwright merender 60 gambar dari HTML pada lebar di atas. Pemeriksaan otomatis memeriksa error JavaScript, gambar rusak, isi yang terlihat, dan luapan horizontal. Mockup HTML dan PNG tidak membuktikan integrasi, tindakan pembayaran, perilaku backend, atau aksesibilitas interaktif secara menyeluruh. Pola penagihan selisih memakai tunai sesuai kontrak yang tersedia saat penyusunan; data contoh dan tindakan ilustratif perlu dicocokkan kembali ketika UI diimplementasikan.
