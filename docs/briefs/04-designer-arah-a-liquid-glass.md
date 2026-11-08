# Brief lanjutan: designer — arah A + liquid glass, semua layar

Lanjutan brief `docs/briefs/02-designer-order-pelanggan.md`, cabang yang sama `ux/customer-order-benchmark`, scope yang sama (`design/mockups/**`).

## Keputusan founder (8 Nov 2026)
- Q4: **Arah A (katalog foto)** dipilih.
- Q5: jumlah tamu ditanya inline di chip/bar kecil di atas menu, wajib sebelum item pertama ditambah. Tidak ada jendela sambutan.
- Catatan founder, apa adanya: "coba implementasikan juga style liquid glass agar ui ux kita modern sesuai dengan trend sekarang ini masih ai slop dan jadul".

## Tujuan
Ulang arah A supaya terasa modern 2026, berkarakter, tidak generik. Pakai liquid glass sesuai aturan kaca di `~/.agents/team/ui-standard.md` (bagian "Kaca"): kaca hanya pada elemen yang mengambang di atas konten (header yang menempel saat scroll, baris kategori sticky, bar keranjang melayang, footer sheet detail, footer checkout, tombol kembali/aksi mengambang). Kartu menu, daftar harga, dan form tetap solid. Kontras teks di atas kaca harus aman di atas foto paling terang dan paling gelap. Terinspirasi, jangan menyalin tampilan Apple.

Yang founder anggap "AI slop dan jadul" di versi sebelumnya, perbaiki secara sadar: tipografi dan hierarki yang datar, tombol pill outline generik ("+ Tambah"), latar putih polos tanpa kedalaman, komposisi template. Jalankan dulu checklist anti-slop di `ui-standard.md`, lalu tulis di README 3 sampai 5 hal konkret yang kamu ubah supaya tidak generik. Tetap patuh palet/font `DESIGN.md` kecuali perubahan yang kamu ajukan eksplisit di README (founder sudah membuka ruang untuk gaya lebih modern).

## Layar (mobile 390 utama, foto menu harus tampak lewat di balik kaca supaya efeknya terlihat)
1. `menu-mobile.png`: setelah scroll sedikit, header + kategori kaca menempel, bar keranjang kaca berisi total.
2. `menu-awal-mobile.png`: scan pertama, chip "Jumlah tamu · Pilih" belum diisi, keranjang kosong.
3. `jumlah-tamu-mobile.png`: kontrol jumlah tamu inline terbuka.
4. `detail-mobile.png`: sheet detail item dengan validasi gula wajib, footer kaca.
5. `checkout-mobile.png`: satu halaman, QRIS/E-wallet/Bayar di kasir inline, footer kaca total + CTA.
6. `qris-menunggu-mobile.png`: QR tampil, menunggu bayar, sisa waktu.
7. `kode-kasir-mobile.png`: kode untuk kasir, pesanan belum masuk dapur.
8. `berhasil-mobile.png`: pembayaran berhasil, status pesanan, ajakan poin di sini.
9. `stok-habis-mobile.png`: menu dengan 1 item habis dan pesan error jaringan ringan (boleh digabung jadi satu layar kondisi).
10. `menu-desktop.png` (1440): katalog + nota keranjang kanan, kaca pada header dan panel mengambang.
Nama berkas final: `design/mockups/final-a-<layar>.png`. Gambar arah lama biarkan.

## Bukti selesai
- Semua gambar dibuka sendiri: teks terbaca, kaca terlihat jelas (bukan putih polos), tidak terpotong, tidak ada teks acak.
- `design/mockups/README.md` diperbarui: bagian "Final arah A + liquid glass", daftar layar, aturan kaca yang dipakai (blur, tint, border, fallback solid), perubahan anti-slop, usulan perubahan `DESIGN.md`.
- Commit lokal: `docs(design): final arah A liquid glass order pelanggan`.

## Laporan
Path gambar, 3 keputusan utama, perubahan dari DESIGN.md yang perlu disetujui, asumsi.
