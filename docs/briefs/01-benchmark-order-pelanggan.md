# Brief: designer-research — benchmark alur order pelanggan (ESB, Richeese)

## Peran

Kamu peneliti UX untuk tim. Baca `~/.agents/team/ui-standard.md` (seluruhnya, termasuk radar tren dan bagian REFERENCES) dan `~/.agents/team/TEAM.md` bagian "Kerja berat". Ikuti aturan `heavy` untuk Playwright.

## Repo

`/Users/ifanshori99/Projects/legend super app/legend`, cabang `ux/customer-order-benchmark` (sudah dibuat, kerja langsung di sini, tanpa worktree).

## Tujuan

Founder belum puas dengan UI/UX order pelanggan Legend. Jalani end to end dua web order pesaing dari sisi pelanggan, sampai layar pilih/bayar pembayaran, lalu bandingkan dengan alur order pelanggan Legend saat ini. Hasilnya jadi dasar desain ulang (mockup oleh designer setelah ini).

Target:

1. ESB Order (dine-in, meja): https://esborder.qs.esb.co.id/JJB/JBLGB/order?mode=dinein&tableNumber=Urban%209
2. Richeese web order: https://web-order-richeese.stamps.id/en/

## Aturan keras (wajib)

- Data asal saja, bukan data founder. Nama "Uji Coba", email `uji.coba@example.com`. Nomor HP: pakai format jelas palsu (mis. `081234567890`). Kalau situs mengirim OTP/WA ke nomor itu atau wajib verifikasi nomor asli: berhenti di situ, screenshot, catat.
- JANGAN membuat pesanan nyata. Berhenti di layar pemilihan metode pembayaran atau ringkasan sebelum tombol akhir (Bayar / Place order / Kirim pesanan / Konfirmasi). ESB dine-in bisa langsung mengirim pesanan ke dapur restoran di meja "Urban 9": kalau tombol berikutnya akan mengirim pesanan sebelum pilih pembayaran, JANGAN tekan; screenshot dan catat bahwa pembayaran ada setelah kirim pesanan.
- Jangan login dengan akun apa pun, jangan isi data kartu, jangan bayar.
- Jangan membebani situs: satu sampai dua kali jalan per situs cukup.

## Cara

- Pakai Playwright (lewat `heavy`) atau browser Ghostex, viewport mobile 390x844 (utama) dan satu putaran desktop 1440 bila situs mendukung.
- Screenshot setiap langkah: landing, pilih outlet/mode, menu, detail item + modifier/opsi, keranjang, upsell, data pelanggan, ringkasan, pilihan pembayaran. Juga kondisi khusus yang terlihat (stok habis, toko tutup, loading, error validasi).
- Catat untuk tiap langkah: jumlah tap, pola navigasi (sticky cart, kategori, search), cara modifier, harga/pajak/service ditampilkan, CTA, tipografi, warna, kepadatan, micro-interaction, aksesibilitas kasar (ukuran target sentuh, kontras).
- Lalu jalankan alur order pelanggan Legend (`apps/web/src/features/ws03-qr-order`, `ws03-menu`; cek `docs/PRD.md` bagian QR order) di dev server lokal dengan data contoh, screenshot langkah yang sama. Dev server maks 2 di seluruh Mac; matikan setelah selesai.

## Scope

- Boleh diubah: `design/benchmark/**` (screenshot, catatan), `design/REFERENCES.md`.
- Jangan disentuh: kode aplikasi, `docs/PRD.md`, file lain.

## Bukti selesai

- `design/benchmark/esb/`, `design/benchmark/richeese/`, `design/benchmark/legend/`: screenshot bernomor per langkah (`01-landing-mobile.png`, ...).
- `design/benchmark/REPORT.md`: tabel langkah per langkah ketiga produk, jumlah tap sampai pembayaran, yang bagus untuk ditiru, yang buruk untuk dihindari, dan daftar celah Legend diurutkan dari dampak terbesar (maks 15 butir, tiap butir: masalah, bukti screenshot, usulan).
- `design/REFERENCES.md` sesuai format `ui-standard.md` (ESB, Richeese, plus 1 sampai 3 produk sejenis kelas dunia yang kamu kenal, mis. GoFood/GrabFood/Starbucks/McD app, tanpa harus dijalankan).
- Ukuran: kompres screenshot (PNG wajar atau JPG kualitas 80) supaya total `design/benchmark` di bawah 40 MB.

## Sebelum melapor

Commit lokal di cabang ini, hanya file dalam scope. Pesan: `docs(design): benchmark order pelanggan ESB Richeese`.

## Laporan

Ringkasan 5 sampai 8 temuan terpenting dalam bahasa biasa, jumlah tap tiap produk, path REPORT.md dan folder screenshot, apa yang tidak bisa dijalani (dan kenapa), commit, serta 3 usulan arah desain untuk designer.
