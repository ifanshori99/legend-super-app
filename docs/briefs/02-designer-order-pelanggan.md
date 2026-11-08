# Brief: designer — mockup ulang alur order pelanggan (QR order)

## Peran

Baca `~/.agents/team/roles/designer.md` dan `~/.agents/team/ui-standard.md`, lalu ikuti. Ini langkah 2 peranmu (arah visual dulu).

## Repo

`/Users/ifanshori99/Projects/legend super app/legend`, cabang `ux/customer-order-benchmark` (kerja langsung di sini).

## Tujuan

Founder belum puas dengan UI/UX order pelanggan Legend dan ingin setara standar industri dan bagus. Buat dua arah visual yang benar-benar berbeda untuk alur order pelanggan, berdasarkan hasil benchmark.

## Masukan

- Benchmark: `design/benchmark/REPORT.md` (14 celah Legend, usulan arah), screenshot di `design/benchmark/{esb,richeese,legend}/`. Baca screenshot satu per satu seperlunya.
- Referensi: `design/REFERENCES.md`.
- PRD: `docs/PRD.md`, bagian QR order / pelanggan (mode "Hangat & Visual"). Batas gaya: `DESIGN.md`.
- Kode layar sekarang (untuk tahu isi dan kondisi, bukan untuk ditiru gayanya): `apps/web/src/features/ws03-qr-order`, `apps/web/src/features/ws03-menu`.

## Yang dibuat

Mobile 390 lebar adalah utama (pelanggan scan QR di meja). Per arah, 4 layar mobile:

1. Menu (dengan bar keranjang melayang berisi total, item yang sudah di keranjang terlihat).
2. Detail item + opsi/modifier (dengan validasi opsi wajib).
3. Keranjang / checkout satu layar sampai pilih metode bayar (QRIS terpilih, e-wallet, dan opsi "Bayar di kasir" (disetujui founder 2026-11-08: pelanggan tunjukkan kode ke kasir, pesanan masuk dapur setelah kasir terima uang)).
4. Menunggu pembayaran QRIS atau Pembayaran berhasil.
   Plus 1 desktop 1440 untuk Menu per arah.
   Nama berkas: `design/mockups/arah-a-<layar>-mobile.png`, `arah-b-...`. Tutup semua celah prioritas 1 sampai 9 di REPORT.md. Harga konsisten `Rp 23.000`. Data contoh Indonesia yang masuk akal (cafe, menu kopi dan makanan).

## Scope

- Boleh diubah: `design/mockups/**`.
- Jangan disentuh: kode, `design/benchmark/**`, file lain.

## Bukti selesai

- 10 gambar di atas ada dan dibuka sendiri untuk dicek (teks terbaca, tidak terpotong, tidak ada teks acak).
- `design/mockups/README.md`: daftar layar, satu paragraf alasan tiap arah, celah REPORT yang ditutup tiap layar.

## Sebelum melapor

Commit lokal di cabang ini, hanya `design/mockups/`. Pesan: `docs(design): mockup arah A dan B order pelanggan`.

## Laporan

Daftar path gambar, beda inti arah A vs B dalam 2 kalimat, tiga keputusan desain utama, asumsi yang perlu founder konfirmasi.
