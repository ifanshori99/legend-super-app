# Referensi desain: QR order pelanggan

Diperiksa: 2026-11-08. Format mengikuti `~/.agents/team/ui-standard.md` bagian "Referensi untuk designer".
Bukti dan perbandingan lengkap: `design/benchmark/REPORT.md`.

| Produk | Dijalani? | Yang diambil | Yang sengaja dihindari |
|---|---|---|---|
| ESB Order (web order dine-in, mis. Jabarano Coffee) | Ya, sampai layar pilih pembayaran (`design/benchmark/esb/`) | Bar keranjang melayang dengan jumlah, total, dan CTA. Tombol + di kartu berubah jadi stepper. Dropdown kategori satu baris yang ikut scroll. Satu halaman pembayaran dengan metode inline dan total di footer. Upsell "Menu Terkait" di keranjang. Opsi "Bayar di Kasir" | Popup promo saat scan. Harga "0" di kartu. Checkbox untuk pilihan wajib tunggal tanpa pesan validasi. Target sentuh 24–28 px. Kategori huruf kapital semua. Pajak tersembunyi di "Biaya lainnya" |
| Richeese Factory RFOrder (Stamps) | Sebagian: landing, gerbang login, katalog publik (`design/benchmark/richeese/`). Alur order terkunci login | Tombol mode order besar dan jelas (Dine In, Takeaway, Delivery). Karakter merek yang kuat lewat warna dan ilustrasi | Login wajib sebelum melihat menu dan harga. Tombol nonaktif tanpa penjelasan. Katalog tanpa harga |
| Starbucks app (order ahead) | Tidak, dari pengetahuan umum | Kustomisasi minuman bertahap dengan ringkasan pilihan di bawah nama item. Harga di tombol ikut pilihan. Rewards ditampilkan setelah transaksi, bukan sebelum bayar. Rujukan PRD untuk "Mode Hangat & Visual" | Alur akun wajib dan dompet prabayar; tidak cocok untuk tamu yang baru scan QR |
| GoFood / GrabFood (menu merchant) | Tidak, dari pengetahuan umum | Satu baris kategori sticky yang sinkron dengan posisi scroll. Kartu menu dengan stepper langsung. Bar keranjang bawah "N item · Rp X". Pencarian lintas seluruh menu merchant | Kepadatan promo, badge, dan banner diskon yang bersaing dengan menu |
| McDonald's app (kiosk dan order di restoran) | Tidak, dari pengetahuan umum | Langkah upsell yang jelas tapi bisa dilewati ("Jadikan paket?"). Ringkasan pesanan besar sebelum bayar | Upsell berlapis yang memperlambat pesanan kecil |

## Prinsip yang dibawa ke desain ulang

1. Jalan ke checkout selalu terlihat dengan total (bar keranjang).
2. Checkout satu layar: ringkasan, rincian pajak jujur, metode bayar inline, satu tombol akhir.
3. Tidak ada login, popup, atau formulir wajib sebelum pelanggan memesan.
4. Foto besar dan hangat, teks bantu seperlunya, target sentuh ≥ 44 px.
