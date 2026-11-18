# Gerbang sandbox Duitku

Kartu `legend-7tqe8` dan `legend-1yig6`. Probe disiapkan pada 18 November 2026 dan belum dijalankan; kredensial sandbox menyusul 20 November. Probe selalu dilewati di CI dan ketika `DUITKU_SANDBOX_MERCHANT_CODE` atau `DUITKU_SANDBOX_API_KEY` kosong. Gunakan hanya kredensial merchant sandbox; host dikunci ke `https://sandbox.duitku.com`, tanpa opsi host production.

Setelah kedua variabel tersebut dimuat secara privat ke lingkungan terminal, jalankan sekali dari root worktree:

```sh
LEGEND_TEST_FILES="src/test/payment-duitku-sandbox.test.ts" heavy pnpm test
```

Probe membuat inquiry sandbox Rp10.000 yang tidak dibayar, tanpa pembayaran kartu, pembatalan, atau refund. Merchant sandbox perlu mengaktifkan e-wallet, kartu `VC`, dan QRIS. URL callback/return memakai `example.invalid` agar tidak mengirim pemberitahuan ke layanan lain. Respons penolakan URL berarti konfigurasi sandbox perlu disepakati sebelum probe diulang.

- Membandingkan host `paymentUrl` e-wallet dan kartu dengan allowlist adapter: HTTPS, `duitku.com`, atau subdomainnya.
- Mencatat nama dan tipe field respons `VC`, termasuk keberadaan `creditCardDetail`, tanpa nilai kartu, referensi, atau URL bertoken. Memutar ulang respons e-wallet dan `VC` ke parser produksi `duitkuInquiry` tanpa panggilan jaringan tambahan, sehingga bentuk referensi, URL, dan nominal ikut diperiksa.
- Mencatat hasil `expiryPeriod=0` sebagai batas bawah, lalu mensyaratkan `expiryPeriod=1` diterima. Nilai nol dapat berarti masa berlaku bawaan provider; penerimaannya tidak dianggap bukti masa berlaku nol.
- Memeriksa status QRIS yang tidak dibayar setelah 75 detik; status yang diharapkan `02` (gagal/kedaluwarsa).
- Mencatat bentuk/kode respons `merchantOrderId` acak yang tidak dikenal dan membuktikan parser tidak menganggapnya lunas.

Bukti tersunting ditulis ke `docs/qa/evidence/duitku-sandbox/gerbang.redacted.json`, termasuk saat salah satu pemeriksaan gagal. Berkas hanya menyimpan host, nama/tipe field, kode metode/status, dan hasil boolean; tidak ada API key, tanda tangan, nomor kartu, payload QR, atau data pembayar. Error dan log yang membawa key membuat test gagal dengan pesan umum. Jangan mengubah adapter berdasarkan dugaan sebelum hasil probe tersedia. Refund otomatis tetap mati sesuai Q45.
