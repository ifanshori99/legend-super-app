# Tinjauan HR: absen saat cuti disetujui

Mockup usulan untuk ditinjau, bukan tampilan aplikasi yang sudah tersedia. Data orang dan waktu pada gambar merupakan contoh. Desktop 1280 px dan mobile 390 px. Acuan visual: `DESIGN.md` v3 dan antrean tinjauan selfie di `apps/web/src/features/ws10-attendance-qr/components/`; referensi desain proyek `design/REFERENCES.md` membahas alur QR pelanggan, bukan HR.

## Alur dan teks

1. **Antrean** — HR melihat lencana **Absen saat cuti**, nama, tanggal, jenis cuti, jam masuk dan jam keluar; pilih **Tinjau**. Bila jam keluar belum ada, tampilkan **Belum absen keluar**. Sebelum keputusan, saldo cuti dan gaji tidak berubah.
2. **Detail** — Ringkasan absen dan cuti yang disetujui; pilihan **Tetap cuti** atau **Batalkan cuti hari ini, hitung hadir**. Penjelasan dampak: “Tetap cuti mempertahankan saldo dan status cuti; membatalkan cuti mengembalikan saldo untuk hari ini dan menghitung hari ini sebagai hadir untuk dasar gaji.” Untuk cuti multi-hari: “Hanya cuti pada tanggal ini yang dibatalkan; hari cuti lain tetap berlaku.” Gaji aktual mengikuti proses penggajian yang berlaku, bukan perubahan langsung saat clock-in.
3. **Konfirmasi tetap cuti** — “Tetap cuti untuk tanggal ini?” Jelaskan bahwa cuti dan saldo tetap, absen tidak dihitung sebagai hadir; pilihan **Kembali** / **Tetap cuti**.
4. **Konfirmasi pembatalan** — “Batalkan cuti hari ini dan hitung hadir?” Jelaskan bahwa hanya tanggal yang ditinjau dibatalkan, saldo hari itu dikembalikan, dan hari itu menjadi dasar hadir; pilihan **Kembali** / **Batalkan cuti hari ini**.
5. **Hasil** — Setelah konfirmasi, tampilkan **Tetap cuti** atau **Cuti hari ini dibatalkan** dengan rincian keputusan dan jalan kembali ke antrean. Jangan tampilkan status teknis `rejected` sebagai “Ditolak” untuk keputusan tetap cuti.
6. **Tanpa hak membatalkan** — Tombol pembatalan nonaktif dan alasan yang tetap terbaca: “Anda tidak memiliki hak untuk membatalkan cuti. Minta HR yang berwenang meninjau keputusan ini.” Aksi tetap cuti tetap tersedia bila hak tinjau absensi dimiliki.
7. **Koreksi absen manual** — Jika koreksi manual terjadi pada hari cuti disetujui, detail memakai dua aksi yang sama: **Tetap cuti** dan **Batalkan cuti hari ini, hitung hadir**; tidak ada aksi Terima/Tolak. Pembatalan selalu satu hari penuh, bukan setengah hari.
8. **Perlu ditinjau ulang** — Log yang telah diterima dan kemudian mendapat cuti baru disetujui pada tanggal itu kembali ke antrean dengan teks **Perlu ditinjau ulang: ada cuti baru disetujui**.
9. **Antrean kosong** — “Tidak ada tinjauan absensi” dan “Absensi yang memerlukan tinjauan akan muncul di sini.”

## Keputusan desain

- Mengikuti antrean selfie yang ada: tabel dan pencarian pada desktop, kartu yang mudah dibaca pada mobile, status dengan teks, dan dialog keputusan. Kanvas netral hangat dan aksen petrol mengikuti `DESIGN.md`.
- Dua pilihan diberi nama berdasarkan hasil bisnis, bukan status teknis; konfirmasi menyebut dampak dan tanggal agar tidak terkesan seluruh rentang dibatalkan.
- Pembatasan hak dijelaskan di dekat tombol nonaktif. Contoh data hanya ilustrasi; jam keluar yang belum ada tidak boleh disajikan sebagai angka pasti.

## Kontrak dan pekerjaan lanjutan

- Keputusan founder W8 Q21/Q27 menjadi target desain. Cabang `origin/ws/9y6ri-leave-clockin-flag` saat ini mengembalikan `ATTENDANCE_LEAVE_MULTI_DAY` untuk pembatalan cuti multi-hari. API harus mendukung pembatalan tanggal tunggal terlebih dahulu; mockup bukan bukti dukungan tersebut telah tersedia.
- Respons antrean API saat ini belum menyediakan seluruh nama, jenis/rentang cuti dan jam keluar yang dibutuhkan; UI memerlukan sumber data atau pengayaan yang sah. Pembatalan membutuhkan `hr.attendance.manage` dan `hr.leave.approve` pada outlet cuti; tinjauan absensi sendiri tidak diizinkan.
- Cabang API juga belum menandai ulang log yang sudah ada ketika cuti disetujui belakangan, dan koreksi manual yang disetujui di hari cuti masih dapat menulis log valid. Kedua jalur perlu ditutup sebelum perilaku baru ini tersedia.
- Payroll saat ini belum membaca absensi/cuti. Kalimat tentang dasar gaji menjelaskan tujuan keputusan, bukan janji bahwa payroll sudah terintegrasi atau otomatis menghitung ulang.
- State loading, error, kegagalan konfirmasi, navigasi keyboard dan pembacaan screen reader perlu dirancang dan diuji saat implementasi.

## Berkas gambar

| Keadaan | Desktop | Mobile |
|---|---|---|
| Antrean berisi | `antrean-desktop.png` | `antrean-mobile.png` |
| Detail | `detail-desktop.png` | `detail-mobile.png` |
| Konfirmasi tetap cuti | `konfirmasi-tetap-desktop.png` | `konfirmasi-tetap-mobile.png` |
| Konfirmasi pembatalan | `konfirmasi-batalkan-desktop.png` | `konfirmasi-batalkan-mobile.png` |
| Hasil tetap cuti | `hasil-tetap-cuti-desktop.png` | `hasil-tetap-cuti-mobile.png` |
| Hasil pembatalan | `hasil-batalkan-cuti-desktop.png` | `hasil-batalkan-cuti-mobile.png` |
| Tanpa hak membatalkan | `tanpa-izin-desktop.png` | `tanpa-izin-mobile.png` |
| Koreksi manual | `koreksi-manual-desktop.png` | `koreksi-manual-mobile.png` |
| Perlu ditinjau ulang | `tinjau-ulang-desktop.png` | `tinjau-ulang-mobile.png` |
| Antrean kosong | `kosong-desktop.png` | `kosong-mobile.png` |

Gambar dibuat secara generatif sebagai ilustrasi tiap keadaan, bukan rekaman satu sesi: nama, tanggal, navigasi, dan identitas contoh dapat berbeda antar gambar. URL dan logo yang muncul di gambar adalah rekaan, bukan alamat atau identitas resmi. Teks alur di README menjadi acuan copy saat implementasi.
