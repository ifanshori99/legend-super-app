# review-q60: sarapan bayar dulu (oa0qk), mode mock web

PNG (suffix -390 = HP 390x844, -1280 = desktop 1280x800):

Semua layar memakai tiket mock "issued" (...T0VW, mulai 1 jam lagi), jadi sesudah bayar pesanan berstatus lunas dan menunggu jam dapur.
Harga: Nasi goreng kampung Rp 38.000 + PB1 10% (eksklusif) Rp 3.800 = Rp 41.800.

- 01-tiket-menunggu-bayar: kartu sarapan di tiket, status menunggu bayar, "Total bayar Rp 41.800", tombol "Bayar sarapan" (viewport saja).
- 02-bayar-sarapan: halaman /bayar/pl_mock_... setelah menekan "Bayar sarapan". Tagihan sarapan asli dari mock: Subtotal Rp 38.000, Pajak Rp 3.800, Total Rp 41.800.
- 03-bayar-kode-qris-sarapan: setelah pilih QRIS dan "Lanjutkan pembayaran": kode QRIS, status menunggu pembayaran.
- 04-tiket-lunas: tiket setelah bayar (kembali lewat riwayat browser). Kartu "Pesanan sarapan sudah lunas", akan dikirim ke dapur pukul 07.35.
- 05-bayar-lunas-sarapan: halaman bayar sesudah mock menganggap kode terbayar ("Pembayaran berhasil").

Cara mock: kode QRIS sarapan dianggap terbayar sekitar 6 detik setelah dibuat (polling halaman bayar tiap 5 detik),
lalu memanggil `settleBreakfastPaymentInMock`. Tautan fixture bill biasa tidak pernah dianggap terbayar.
Batas mock: tombol "Selesai" di halaman bayar memuat ulang halaman, dan state mock hidup di memori browser, jadi
pesanan hilang. Skrip memakai `page.goBack()` supaya state tetap ada.

Buat ulang:
1. Mock server: `WEB_URL=http://localhost:3262 VITE_API_MOCK=true DEPLOYMENT_MODE=development DATA_CLASSIFICATION=synthetic VITE_API_MOCK_LATENCY_MS=0 pnpm --filter @starter/web dev`
2. `LEGEND_MOCK_PORT=3262 heavy node design/screens/review-q60/shots.mjs`
3. Matikan server.
