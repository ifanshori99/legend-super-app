# sub-539-u1 fix 3 (bandingan mockup, commit 7f82d858)

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-cashier-captain`. Path relatif `apps/web/src/features/ws04-pos-order/`. Jangan commit; jangan tsc/build. Boleh cek di dev server mock http://localhost:3241 (jangan start server lain). Bandingkan PNG `design/screenshots/pos-u1/<layar>` dengan mockup `design/mockups/pos/<mockup>`. Jangan ubah AreaFrame/header `_ops`, `components/ui/money` (komponen bersama). Laporan ≤8 baris.

## K kasir: components/cashier/*, components/modifier-dialog.tsx, i18n pos-order-{catalog,cart}.ts, fixtures.ts (hanya waktu katalog)

1. Desktop (kasir-main-1280 vs cashier-main-desktop): panel keranjang setinggi viewport; daftar item scroll sendiri; subtotal + "Tahan pesanan" + "Kirim item ditahan" + "Lanjutkan pesanan" menempel di bawah panel, selalu terlihat di 1280×800.
2. Mobile keranjang (kasir-keranjang-mobile-390 vs cashier-main-cart-mobile): footer tetap (subtotal + 3 tombol) dalam satu layar; hapus baris "Kembali ke menu" (ganti ikon kembali kecil di judul "Keranjang").
3. Baris keranjang: baris ditahan menampilkan pil status "Tahan · {course}" seperti mockup; tombol − / + persegi 56 px; kontrol tahan per baris tetap tapi tenang.
4. Bobot huruf seperti mockup: judul "Pesanan baru" 800, "Keranjang" 700-800, nama menu 700, tombol 700.
5. Kartu "Es teh manis" abu-abu (kasir-main-\*): abu-abu hanya untuk stok habis; cari sebabnya (gaya "sudah di keranjang"/hover/fixture soldOut) dan betulkan.
6. Offline (kasir-offline-1280 vs cashier-main-offline-desktop): hapus chip "Offline" ganda di judul bila header area sudah menampilkan status; sisakan satu Notice katalog. Waktu katalog cache di fixture relatif terhadap jam sekarang (mis. 25 menit lalu), bukan 14.08 tetap, supaya tidak bertentangan dengan "Sinkron terakhir".

## C captain: components/captain/*, i18n pos-captain-{tables,order}.ts, fixtures.ts (hanya meja/panggilan)

1. Judul: bilah header kecil hanya kembali + konteks ("Captain" / kode meja) + badge; isi dibuka dengan `<h1>` 24 px bobot 800 ("Pilih meja", "Tambah pesanan", "Tinjau pesanan", "Pesanan meja", "Panggilan waiter") dan chip "Contoh data" sejajar di kanan; subjudul di bawahnya. Satu `<h1>` per layar. Judul bilah tidak terpotong di 390.
2. Tambah pesanan (captain-tambah-\* vs captain-order): daftar scroll di atas bottom bar tetap berisi CTA "Tinjau pesanan · N item" + keterangan "Item baru belum dikirim ke dapur"; saat kosong CTA tetap tampil (aria-disabled + petunjuk), tanpa teks yang menimpa daftar; padding bawah daftar ≥ tinggi bar.
3. Daftar meja (captain-main-\* vs captain-tables): fixture A01 "Sesi QR aktif" (tanpa panggilan), hanya A03 punya panggilan; kembalikan catatan "Meja terisi ditandai latar abu-abu dan teks status."; tiga chip filter muat di 390; banner panggilan ≤2 baris di 390.
4. Bottom bar lebar sama dengan kolom konten di 1280; daftar diberi padding bawah supaya tidak tertutup bar.
5. Tinjau pesanan (setelah script fixer): cocokkan dengan captain-review (kartu per item + "Ubah", grup "Kirim sekarang"/"Ditahan · {course}", "+ Tambah menu", CTA "Kirim pesanan ke dapur" + "N dikirim sekarang · M ditahan").
