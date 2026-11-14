# Kelola reservasi tamu · legend-g12il

Bahan gerbang founder untuk `/reservasi/kelola#<token>`. Buka [review.html](review.html), lalu pilih state lewat “Jelajahi 16 state”. Pada mobile pemilih dilipat agar pratinjau diutamakan. Setiap HTML mandiri menyertakan font lokal sebagai data URI sehingga dapat dibuka tanpa server atau internet. Tidak ada panggilan API, token nyata, atau transaksi uang.

## Arah dan sumber

Mengikuti arah QR yang sudah ditetapkan dalam `design/mockups/README-qr.md`, dengan `final-a-mobile.html/css` dan `qr-d6d1-booking-mobile.html/css` sebagai acuan visual. Standar: `~/.agents/team/ui-standard.md`; referensi proyek: `design/REFERENCES.md`. Kontrak dibaca dari `packages/shared/src/reservation/self-service.ts`, `apps/api/src/services/reservation-public.ts`, dan `apps/api/src/services/reservation-reschedule.ts` pada backend **e73f0649e**, cabang `ws/reservation-reschedule`. Brief produk: `docs/briefs/676-reservation-reschedule.md`.

Ini permukaan tugas yang mengikuti arah yang sudah dipilih; tidak membuka dua arah merek baru. HTML/CSS dan tangkapan browser dipakai sesuai brief. Tidak ada aset gambar generatif; ikon garis toko adalah SVG ilustratif milik mockup, dan font mengikuti acuan QR beserta lisensinya.

## Daftar layar dan kondisi

Setiap baris memiliki HTML yang dapat dibuka, PNG mobile 390, dan PNG desktop 1280. Contoh: `detail.html`, `detail-mobile.png`, `detail-desktop.png`.

| Key              | Tujuan tamu dan kondisi                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| `detail`         | Memeriksa outlet, jadwal, jumlah tamu, DP dibayar, dan batas refund penuh |
| `reschedule`     | Memilih tanggal/jam baru dan menulis catatan opsional                     |
| `validation`     | Memperbaiki tanggal yang sudah lewat sebelum mengirim                     |
| `submitting`     | Melihat pengiriman berlangsung; tombol tidak dapat dikirim ganda          |
| `pending`        | Mengetahui permintaan menunggu outlet; jadwal awal tetap aktif            |
| `approved`       | Melihat jadwal baru yang disetujui dan DP yang tetap tercatat             |
| `rejected`       | Melihat penolakan tanpa alasan buatan; jadwal awal tetap aktif            |
| `late`           | Memahami batas perubahan jadwal dan potongan DP bila memilih batal        |
| `cancel`         | Mengonfirmasi batal dengan pratinjau refund penuh                         |
| `cancel-late`    | Mengonfirmasi batal dengan pratinjau potongan DP                          |
| `cancelled`      | Melihat pembatalan selesai; pengembalian uang belum selesai               |
| `cancelled-late` | Melihat pembatalan dengan rincian refund dan potongan                     |
| `invalid`        | Memulihkan tautan salah/kedaluwarsa/dicabut tanpa membuka detail tamu     |
| `loading`        | Menunggu rincian reservasi dengan skeleton statis                         |
| `error`          | Memulihkan gangguan koneksi dan memeriksa status sebelum mencoba ulang    |
| `rate-limit`     | Memahami pembatasan percobaan sementara dan langkah berikutnya            |

## Tiga keputusan desain

1. **Jadwal aktif dan permintaan dipisahkan.** Ringkasan mempertahankan jadwal awal selama pending, sementara jadwal yang diminta diberi bagian sendiri. Alternatif mengganti tanggal langsung berisiko membuat tamu datang pada waktu yang belum disetujui. Dasar kuat: kontrak pending serta brief. Biaya: ada pengulangan waktu yang disengaja agar status dua jadwal jelas.
2. **Rincian DP dibaca sebelum keputusan batal.** Konfirmasi menampilkan DP dibayar, potongan, dan pengembalian; hasil batal tidak menjanjikan uang langsung masuk. Alternatif hanya menulis “penalti berlaku” menyembunyikan konsekuensi. Dasar kuat: DTO pratinjau dan kebijakan snapshot. Fixture menjaga `DP dibayar = potongan + pengembalian`.
3. **Satu kolom yang tenang, satu aksi utama.** Krem/rust dan Plus Jakarta Sans mempertahankan kesinambungan dengan pesan/halaman QR. Form dan rincian uang solid; status memakai teks; fokus terlihat; tombol utama 48 px. Desktop memberi ruang baca, mobile memakai alur vertikal. Dasar visual terbatas pada acuan QR proyek, bukan riset pengguna eksternal. Biaya: halaman formulir panjang dan perlu digulir.

## Asumsi untuk founder dan kebutuhan kontrak

- **Hasil keputusan perlu kontrak tambahan.** GET tamu saat ini hanya mengembalikan permintaan pending. State disetujui/ditolak adalah usulan sesuai brief, belum dapat dibedakan dari DTO yang ada. Alasan penolakan tidak ditampilkan karena belum tersedia.
- **Batas ubah jadwal perlu diselaraskan.** `RESERVATION_RESCHEDULE_LATE` pada e73f0649e ditegakkan saat staf menyetujui. State late belum berarti endpoint permintaan tamu menolaknya sejak awal. UI implementasi harus mengikuti hasil server dan mencegah janji perubahan setelah batas.
- **Hasil diperiksa lewat tautan.** Mockup tidak menjanjikan pesan otomatis ketika outlet mengambil keputusan; penambahan notifikasi hasil perlu bukti dukungan backend.
- **Bantuan melalui pesan yang sudah dimiliki.** DTO tidak memberikan nomor kontak outlet. Instruksi “balas pesan konfirmasi” mengasumsikan kanal pesan tersebut menerima balasan; sumber kontak publik perlu dipastikan sebelum implementasi. Tidak ada nomor karangan atau tautan WhatsApp mati.
- **Nominal, identitas, dan jam hanya contoh.** DP Rp50.000, refund penuh sampai 17 November 2026 pukul 19.00 WIB, lalu refund Rp25.000 dan potongan Rp25.000 mengikuti contoh fixture; bukan ketentuan semua outlet. Implementasi membaca `cancellation.freeUntil`, `preview`, dan kebijakan saat booking. Zona waktu outlet contoh adalah WIB.
- **Form adalah fixture review.** Pemilih tanggal/jam dapat dijelajahi, tetapi alur kirim memakai contoh 19 November pukul 19.30. Validasi memiliki state tersendiri, bukan integrasi formulir production. Tombol pengiriman berpindah ke pending setelah satu detik. State submitting langsung dari pemilih tetap statis untuk ditinjau.
- **Keamanan implementasi.** Tamu tanpa login; token hanya di fragment dan header khusus API, tidak di query/path. Semua 404 tautan memakai state yang sama. Integrasi nanti memerlukan Idempotency-Key, penguncian submit, dan Retry-After server. Ini catatan kontrak, bukan fitur keamanan yang telah diimplementasikan oleh mockup.

## Verifikasi dan cara mengulang

`generate.py` menggabungkan sumber menjadi 16 HTML mandiri dan halaman review. `capture.mjs` memakai paket Playwright yang sudah terpasang, satu browser, dan tidak menjalankan server aplikasi. Jika worktree tidak memiliki dependencies, arahkan `LEGEND_TOOLING_ROOT` ke root checkout yang sudah siap.

```sh
python3 design/mockups/reservation-guest/generate.py
pnpm exec prettier --write --ignore-path /dev/null 'design/mockups/reservation-guest/*.{js,mjs,css,html,md,json}'
heavy node design/mockups/reservation-guest/capture.mjs
heavy ghostex visual check design/mockups/reservation-guest/review.html --out design/mockups/reservation-guest/review.png
heavy ghostex visual check design/mockups/reservation-guest/review.html --width 390 --out design/mockups/reservation-guest/review-mobile.png
```

Prettier proyek mengabaikan `design/**` secara bawaan; pemeriksaan khusus memakai `--ignore-path /dev/null`. Lint JS memakai konfigurasi proyek dengan global browser eksplisit. Paket aplikasi, tabel, dan kontrak production tidak diubah, sehingga typecheck/build/gate aplikasi tidak diperlukan untuk perubahan mockup ini.

Pemeriksaan `ghostex visual check review.html --out review.png` dan varian `--width 390 --out review-mobile.png` lulus tanpa peringatan: “Fits: nothing reaches past the screen and the kit had nothing to fit.” Hasil tersedia pada `review-390.png`, `review-1280.png`, dan `review-mobile.png`.

Bukti browser disimpan di [capture-report.json](capture-report.json): 16 state × 3 lebar (320, 390, 1280), 32 PNG, tidak ada error JavaScript atau overflow, seluruh tombol aktif minimal 44 px, satu heading utama per state, tidak ada target state yang hilang. Pemeriksaan alur: hasil disetujui → detail → batal; hasil disetujui → ajukan lagi → pending; fokus heading sesudah perpindahan; late → konfirmasi → batal dengan potongan. Kelima tampilan uang membuktikan konservasi nominal fixture. Ini tidak menggantikan test perhitungan backend.

Review sumber konteks terpisah menemukan masalah hilangnya jadwal baru, fokus heading, dan ukuran tombol submitting. Semua diperbaiki lalu diverifikasi ulang. Total enam subagent Codex (dua eksplorasi, tiga pembuat state, satu reviewer), puncak tiga aktif bersamaan. Pengukuran biaya dari `session-usage.py` tidak tersedia karena skrip tidak menemukan transkrip Codex; `parallel-report` hanya menampilkan sesi Claude, sehingga tidak dipakai untuk mengklaim biaya atau rata-rata Codex. Tidak menjalankan bd. Catatan kerja berada di folder ini sesuai batas brief; tidak mengubah `docs/PROGRESS.md`.

## Delivery gate mockup

| Area          | Hasil dan bukti                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Product       | PASS untuk cakupan mockup; aturan dari brief/DTO, gap ditandai; bukti kuat untuk kontrak, terbatas untuk kebiasaan pengguna                      |
| UX            | PASS; pending tidak memindahkan jadwal, konfirmasi mendahului pembatalan                                                                         |
| UI            | PASS; task UI dengan hierarki status → rincian → tindakan                                                                                        |
| Design system | PASS; satu keluarga font, aksen rust, satu keluarga netral hangat, semantik hijau/amber dikecualikan dari hitungan aksen                         |
| Accessibility | PARTIAL; semantik, label, fokus, status berteks, target sentuh diperiksa; audit axe dan screen reader belum dijalankan                           |
| Responsive    | PASS untuk 320/390/1280 dari browser; zoom 200% belum diaudit                                                                                    |
| Edge cases    | PASS untuk 16 state dalam brief dan kondisi tambahan; fixture bukan integrasi server                                                             |
| Code quality  | PASS setelah syntax, ESLint, dan Prettier khusus folder                                                                                          |
| Visual QA     | PASS; PNG mobile/desktop diekspor; tampilan detail, form, late, batal, dan invalid diperiksa langsung                                            |
| Anti-slop     | PASS; satu aksen, satu keluarga netral, radius 8/12/20/24 dan pill, satu ukuran judul utama per layar, satu gaya ikon, nol emoji UI, nol gradien |
| Final         | Siap review founder; belum UI production atau gerbang rilis                                                                                      |

Belum diuji: panggilan API, pembacaan token nyata, pengiriman pesan, refund nyata, axe, Lighthouse, screen reader, serta browser selain Chrome. Tidak ada transaksi yang diproses.
