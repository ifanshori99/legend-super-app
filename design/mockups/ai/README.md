# Pengaturan AI tenant

Mockup untuk review `legend-nnufz`, mengikuti keputusan `legend-z83k` / Q88 dan kemampuan model `legend-39d.8`. Sumber: [ai-settings.html](ai-settings.html). Ini artefak desain statis; seluruh kode perangkat, model, kapasitas, nominal, dan status adalah **contoh**, tanpa panggilan layanan AI atau transaksi.

## Layar dan kondisi

Tujuan pemilik: menghubungkan akun ChatGPT dengan persetujuan risiko, menyiapkan model cadangan, dan membatasi pemakaian anggaran AI tenant. Admin tenant dapat mengelola model kustom dan anggaran; koneksi ChatGPT hanya milik pemilik.

| State URL          | Kondisi                                                               | Desktop 1280                             | Mobile 390                              |
| ------------------ | --------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------- |
| `?state=empty`     | Belum terhubung, persetujuan belum dicentang, anggaran Rp 0           | [PNG](ai-settings-empty-desktop.png)     | [PNG](ai-settings-empty-mobile.png)     |
| `?state=device`    | Kode perangkat contoh dan tautan login, menunggu persetujuan          | [PNG](ai-settings-device-desktop.png)    | [PNG](ai-settings-device-mobile.png)    |
| `?state=connected` | ChatGPT terhubung, aksi cabut dengan konfirmasi                       | [PNG](ai-settings-connected-desktop.png) | [PNG](ai-settings-connected-mobile.png) |
| `?state=failed`    | Koneksi gagal, pemulihan dengan mencoba kembali                       | [PNG](ai-settings-failed-desktop.png)    | [PNG](ai-settings-failed-mobile.png)    |
| `?state=expired`   | Kode kedaluwarsa, buat kode baru setelah persetujuan                  | [PNG](ai-settings-expired-desktop.png)   | [PNG](ai-settings-expired-mobile.png)   |
| `?state=detected`  | Model cadangan teruji dalam simulasi, kemampuan dan pengubahan manual | [PNG](ai-settings-detected-desktop.png)  | [PNG](ai-settings-detected-mobile.png)  |
| `?state=disabled`  | Platform mematikan AI, banner dan semua kontrol pengaturan nonaktif   | [PNG](ai-settings-disabled-desktop.png)  | [PNG](ai-settings-disabled-mobile.png)  |

Tambahkan `&role=admin` untuk meninjau pembatasan koneksi ChatGPT dari akun admin. Tanpa parameter, halaman membuka state kosong sebagai pemilik. Uji pada mockup hanya memindahkan tampilan lokal; hasilnya bukan bukti koneksi penyedia berhasil.

## Tiga keputusan desain

1. **Hubungan utama dan cadangan terlihat bersama.** ChatGPT lebih dahulu; model kustom berikutnya. Ringkasan mengunci urutan ChatGPT → model kustom otomatis. Alternatif tab menyembunyikan kesiapan cadangan; dua pilihan setara mengaburkan prioritas yang sudah ditentukan brief.
2. **Persetujuan risiko berada tepat sebelum aksi.** Checkbox belum dicentang, tombol hubungkan belum aktif, tautan perangkat hanya muncul pada tahap menunggu. Pemilik mendapat tombol cabut dengan konfirmasi; admin melihat alasan pembatasannya. API key lama tidak diisi kembali ke form.
3. **Informasi teknis muncul setelah diperlukan.** Base URL, API key, dan nama model cukup untuk mulai; konteks, batas output, tools, serta reasoning diterangkan dengan bahasa sederhana pada hasil uji. Pengubahan manual tetap tersedia untuk admin. Anggaran Rp 0 dan banner platform menjelaskan alasan AI mati.

## Arah visual dan bukti

Mengikuti `DESIGN.md`, `~/.agents/team/ui-standard.md`, serta satu pola backoffice yang dibaca dari checkout utama: `design/mockups/backoffice/integrasi-5tewu.html` dan halaman hub pengaturan. Folder contoh belum berada pada commit dasar worktree ini. Bukti visual struktur terbatas pada contoh tersebut; aturan peran, risiko, cadangan, anggaran, dan kill switch berasal langsung dari brief/keputusan produk.

Warna aksi petrol, netral hangat, Plus Jakarta Sans dari aset lokal disematkan sebagai data font dalam HTML, permukaan solid. Font mengikuti lisensi [OFL proyek](../assets/FONT-LICENSE.txt). Desktop memakai sidebar dan panel ringkasan; mobile satu kolom dengan label tetap terlihat dan kontrol sentuh. Tidak ada foto, gambar generatif, tarif penyedia, klaim gratis, atau invoice contoh. Angka penggunaan disebut perkiraan, bukan biaya aktual penyedia.

## Menghasilkan ulang

Dari root worktree, jalankan:

```sh
heavy node design/mockups/ai/render.mjs
heavy node design/mockups/ai/verify.mjs
```

`render.mjs` membuat HTML sementara tiap state, menjalankan `ghostex visual check <html> --width 1280 --out <png>` dan `--width 390`, lalu menghapus HTML sementara. Perintah dan keluaran tersimpan di [render-results.json](render-results.json). PNG mencakup halaman lengkap agar form di bawah lipatan tetap dapat diperiksa.

`verify.mjs` memakai Playwright 1.63.0 yang sudah terpasang pada checkout ini atau checkout utama saudara `../legend`; tidak membuat symlink `node_modules` atau menjalankan aplikasi. Bila lokasi berbeda, atur `LEGEND_PLAYWRIGHT_MODULE` ke modul Playwright terpasang. Hasil pemeriksaan disimpan di [verification.json](verification.json).

## Hasil pemeriksaan historis — 13 November 2026

- Ghostex: **14/14** state × lebar menyatakan `Fits`, tanpa peringatan keluar layar. Perintah menggunakan viewport desktop 1280 dan mobile 390; Ghostex mengekspor mobile pada kepadatan 2× sehingga berkas PNG selebar **780 piksel**. Desktop diekspor 1280 piksel. Seluruh halaman, termasuk area di bawah lipatan, ikut diekspor.
- Chromium: **25 pemeriksaan** lulus: 21 kombinasi state/lebar 1280, 390, 320; persetujuan pemilik sebelum login; larangan login/cabut untuk admin; dialog pencabutan dapat dibatalkan; fokus keyboard terlihat. Semua key tersimpan tidak diisi kembali; kill switch menonaktifkan kontrol pengaturan. Tidak ada error runtime atau permintaan jaringan eksternal.
- Inspeksi visual: designer membuka tujuh PNG desktop; reviewer konteks segar membuka tujuh PNG mobile. Temuan tautan ganda, tampilan disabled, border input, validasi blur, dan teks status sudah diperbaiki. Reviewer tidak menemukan blocker pada ekspor akhir.
- Kontras pasangan utama dihitung dari sRGB: teks utama/putih **17,21:1**, teks bantu/putih **6,74:1**, CTA putih/petrol **7,44:1**, border input/putih **3,66:1**, teks status sukses **6,35:1**, peringatan **8,04:1**, error **8,50:1**. Ini pemeriksaan pasangan sumber, bukan audit aksesibilitas lengkap.
- `node --check` untuk script render, script audit, dan JavaScript inline lulus; `git diff --check` bersih. Build/test aplikasi tidak relevan karena hanya artefak desain statis yang berubah.

| Gate RYUX     | Hasil dan batas                                                                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product       | PASS pada lingkup mockup: brief langsung, keputusan Q88, kontrak anggaran. Belum diuji pengguna.                                                                                                                                                                                                              |
| UX            | PASS rancangan: utama/cadangan terlihat, risiko sebelum aksi, alasan disabled dan pemulihan jelas.                                                                                                                                                                                                            |
| UI            | PASS pada kanvas: task UI, arah backoffice yang sudah ada, tanpa eksplorasi merek baru.                                                                                                                                                                                                                       |
| Design system | PASS: satu aksen petrol, satu keluarga netral hangat, warna status terpisah; radius 4 untuk meter, 6 untuk label tinjau/status, 8 untuk kontrol, 12 untuk kartu/dialog, lingkaran nomor/status. Satu ukuran judul utama tiap viewport, satu keluarga font, penanda status teks konsisten, 0 emoji, 0 gradien. |
| Accessibility | NOT VERIFIED secara lengkap: pasangan kontras dan fokus keyboard diperiksa; axe dan pembaca layar belum dijalankan.                                                                                                                                                                                           |
| Responsive    | PASS pada 1280, 390, 320: tanpa overflow horizontal; semua state ditinjau secara geometri. Zoom 200% belum diuji.                                                                                                                                                                                             |
| Edge cases    | PASS pada tujuh state yang diminta; izin admin diperiksa melalui parameter role.                                                                                                                                                                                                                              |
| Code quality  | N/A untuk produk; sumber mockup lolos sintaks dan audit browser.                                                                                                                                                                                                                                              |
| Visual QA     | PASS: 14 ekspor Ghostex dan seluruh PNG dibuka oleh designer/reviewer.                                                                                                                                                                                                                                        |
| Anti-slop     | PASS lingkup mockup: data contoh ditandai, tanpa harga/layanan atau klaim baru.                                                                                                                                                                                                                               |
| Final         | NOT VERIFIED sebagai produk; artefak desain siap untuk review melalui CTO.                                                                                                                                                                                                                                    |

Pekerjaan dibagi ke empat subagent Codex: dua penelusuran, satu penulis HTML, satu reviewer. Laporan biaya dan rata-rata paralel dari alat tim belum tersedia untuk sesi Codex ini (`session-usage`: transkrip tidak ditemukan; `parallel-report`: tidak ada sesi). Tidak mengubah `docs/PROGRESS.md` karena batas peran designer hanya `design/mockups/`.

## Batas bukti

Ini rancangan untuk review founder melalui CTO. Tidak ada perubahan aplikasi, migrasi, login OAuth asli, penagihan, atau koneksi model sungguhan. Audit produksi seperti Lighthouse, axe aplikasi, dan pengujian pembaca layar tetap milik tahap implementasi. Status kartu Beads ditangani CTO sesuai aturan peran Codex.

## Audit lanjutan — 14 November 2026

Lanjutan ini membandingkan brief `docs/briefs/589-designer-ai-admin.md` dengan cabang `design/ai-settings`, standar UI tim yang berlaku, dan bukti implementasi. **Tidak ada state inti brief yang hilang:** tujuh kondisi sudah mempunyai HTML dan pasangan PNG. Pekerjaan lanjutan mempertahankan arah visual tersebut, memperbaiki ketidaksesuaian, dan menambah keadaan operasional yang sebelumnya belum tergambar. Hasil pemeriksaan 13 November di atas adalah catatan historis; hasil tersebut bukan bukti pemeriksaan ulang perubahan 14 November.

### Cakupan state lama

| State lama  | Kebutuhan brief 589                                                     | Hasil audit awal 14 November                                                                                         |
| ----------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `empty`     | Belum terhubung, persetujuan risiko belum dicentang, anggaran awal Rp 0 | Lengkap; dua tombol berwarna utama bersaing sehingga hierarki aksi perlu dirapikan.                                  |
| `device`    | Kode perangkat, tautan login, dan status menunggu                       | Lengkap; kode dan tautan tetap merupakan contoh lokal.                                                               |
| `connected` | ChatGPT terhubung, pemilik dapat mencabut koneksi                       | Lengkap; izin admin dan konfirmasi cabut tersedia dalam simulasi.                                                    |
| `failed`    | Koneksi gagal disertai jalan pemulihan                                  | Lengkap; pemilik dapat mencoba kembali setelah persetujuan.                                                          |
| `expired`   | Kode kedaluwarsa disertai pembuatan kode baru                           | Lengkap; berbeda dari sesi aplikasi yang berakhir.                                                                   |
| `detected`  | Hasil uji model kustom, empat kemampuan, dan pengubahan manual          | Lengkap; bagian teknis terbuka sejak awal dan perlu dilipat agar informasi muncul bertahap.                          |
| `disabled`  | Platform mematikan AI, banner jelas, semua kontrol pengaturan nonaktif  | Lengkap sesuai brief; berbeda dengan perilaku implementasi pada bukti screenshot, lihat pertanyaan founder di bawah. |

Semua state lama tetap memakai nama aset `ai-settings-<state>-desktop.png` dan `ai-settings-<state>-mobile.png`. Ketujuh state lama diekspor ulang karena perbaikan bersama pada shell, token, hierarki aksi, dan pengungkapan informasi. Seluruhnya berstatus revisi, bukan aset yang dibiarkan tanpa perubahan atau state produk baru.

### Rencana perbaikan mengikuti DESIGN v3

Pertahankan palet petrol/netral hangat dan struktur utama/cadangan serta anggaran yang sudah ada. Selaraskan shell dengan DESIGN v3: radius shell luar 18 px, kartu dalam 12 px, padding shell 8 px, serta tema gelap sesuai pilihan desain proyek. Pusatkan warna pada `oklch()`, tegaskan satu aksi utama, dan lipat pengaturan kemampuan teknis pada tampilan awal. Tambahkan tiga keadaan operasional standar (`loading`, `offline`, `session`), gabungkan semuanya dalam halaman review, lalu ekspor ulang tujuh state lama dan tiga state baru pada 1280/390. Tahap akhir adalah pemeriksaan visual, responsif, dan interaksi simulasi dengan bukti hasil sesudah perubahan terakhir. Perbaikan ini menyelaraskan rancangan yang sudah ada dengan aturan terkini tanpa membuka eksplorasi merek baru.

### State pelengkap baru

| State baru | Tujuan pengguna                                                                           | Perbedaan dari state lama                                                                              |
| ---------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `loading`  | Memahami bahwa status dan pengaturan sedang dimuat; menunggu tanpa melakukan perubahan    | Belum tersedia dalam tujuh mockup lama; mencegah tampilan awal dianggap sudah kosong atau siap diubah. |
| `offline`  | Memahami pengaturan belum dapat dijangkau dan mencoba memuat ulang                        | Berbeda dari `failed`, yang berarti proses koneksi ChatGPT gagal.                                      |
| `session`  | Memahami sesi masuk aplikasi telah berakhir dan masuk kembali sebelum mengubah pengaturan | Berbeda dari `expired`, yang hanya berarti kode login perangkat ChatGPT kedaluwarsa.                   |

Ketiga state pelengkap disiapkan pada desktop 1280 dan mobile 390. Ini keadaan antarmuka untuk ditinjau, tanpa klaim pengujian autentikasi, jaringan, atau layanan AI sebenarnya.

### Kekurangan awal dan keputusan perbaikan

1. Bagian `Ubah kemampuan model` memakai `<details open>` pada sumber lama, sehingga pengaturan teknis tampil sejak awal. Standar UI tim meminta informasi dibuka bertahap. Kondisi awal dilipat; admin masih dapat membukanya ketika diperlukan.
2. Pada state kosong, `Hubungkan ChatGPT` dan `Uji koneksi` sama-sama memakai gaya aksi utama. Standar tim meminta satu aksi utama per layar. Hierarki dipertegas dengan satu aksi utama yang mengikuti tahap pengguna; aksi model cadangan dan simpan tetap tersedia dengan tampilan lebih tenang.
3. Token dan warna tambahan pada sumber lama masih memakai nilai hex. Standar tim meminta token `oklch()`. Warna perlu dipusatkan pada token tersebut sambil mempertahankan arah petrol, netral hangat, dan status dengan teks; tidak memperkenalkan arah merek baru.
4. Belum ada satu halaman yang memuat semua state untuk gerbang founder. [review.html](review.html) menjadi pintu tinjau bersama untuk state lama dan pelengkap; gambar halaman review disimpan sebagai `review.png` dan `review-mobile.png`. Bukti pemeriksaan akhir lanjutan dicatat terpisah setelah benar-benar dijalankan.

### Bukti implementasi yang dibandingkan

Commit `3c4a5c73a0b3e66d94e59ccb9e8426ea486f8785` pada 13 November 2026 berjudul `feat(ai-settings): wire screen to shared AI contract, ChatGPT-only platform lock, PATCH overrides`. Commit itu memuat **18 PNG** di `docs/screenshots/ai-settings/`: `default`, `detected`, `device`, `failed`, `ai-off`, `ai-off-detected`, `slow`, `error`, dan `offline`, masing-masing pada 1280 dan 390. Aset tersebut ditemukan lewat `git log --all -- docs/screenshots/ai-settings`; tidak tersedia pada dasar cabang desain ini.

Screenshot `default-1280.png`, `ai-off-detected-1280.png`, dan `detected-390.png` dibuka saat audit. Struktur utama/cadangan dan anggaran konsisten dengan mockup lama. Namun screenshot menampilkan label **Contoh data**; sambungan kontrak API dalam commit tidak membuktikan login OAuth atau koneksi model nyata berhasil. Screenshot `default` memperlihatkan contoh Rp 4.100.000 dari Rp 5.000.000 (82%), sehingga bukan acuan nilai awal untuk state `empty`, yang tetap Rp 0 sesuai brief. Semua nominal pada mockup adalah contoh pembatasan dan perkiraan pemakaian, **bukan tarif, tagihan, atau biaya nyata penyedia**.

### Asumsi untuk dikonfirmasi founder melalui CTO

- **Cakupan sakelar platform:** brief 589 meminta AI dimatikan secara global beserta seluruh kontrol, sedangkan screenshot `ai-off-detected-1280.png` pada commit `3c4a5c73a` dan komentar `apps/web/src/features/ws12-ai-settings/components/ai-settings-page.tsx` mengunci ChatGPT saja; model kustom serta anggaran tetap dapat diatur. Mockup `disabled` mempertahankan ketentuan brief sampai ada keputusan. Founder perlu memilih apakah kunci berlaku ke seluruh AI atau hanya ChatGPT.
- **Pemulihan sesi:** state `session` menganggap sesi aplikasi yang berakhir harus dipulihkan melalui masuk kembali, kemudian pengguna kembali ke Pengaturan AI. Ini usulan alur desain; belum menjadi bukti perilaku aplikasi.

## Hasil akhir lanjutan — 14 November 2026

Pintu review: [review.html](review.html), [gambar desktop](review.png), dan [gambar mobile](review-mobile.png). Tujuh state lama diselaraskan, tiga state baru ditambahkan; seluruhnya mempunyai PNG lengkap desktop 1280/mobile 390. Tambahan dua PNG `ai-settings-detected-dark-{desktop,mobile}.png` memperlihatkan tema gelap. Ekspor Ghostex mobile memakai kepadatan 2×, sehingga PNG mobile selebar 780 piksel.

Page review memakai 20 pratinjau JPEG yang ditangkap langsung dari isi pengaturan, tanpa header dan kontrol tinjau yang berulang. PNG lengkap pada tabel tetap dipertahankan. Pratinjau bisa digulir; tautan membuka state mockup interaktif. Tiga keputusan desain dilipat pada page review. Tinggi page pada browser: 6.757 px (1280), 7.452 px (390), dan 7.780 px (320), sehingga seluruh sepuluh state masuk batas ekspor Ghostex. Gambar memakai decode sinkron: pengujian menemukan decode asinkron dapat menghasilkan frame kosong pada ekspor Ghostex meskipun berkas sudah termuat.

- Ghostex: **20/20 ekspor state Fits**, ditambah **2/2 ekspor page review Fits**. Bukti: [render-results.json](render-results.json) dan [review-results.json](review-results.json).
- Chromium: **71 pemeriksaan lulus**, termasuk 60 kombinasi state × lebar 1280/390/320 × tema terang/gelap, persetujuan pemilik, pembatasan admin, konfirmasi pencabutan, pemulihan offline/sesi, serta 20 gambar dan 10 jangkar page review. Tidak ada error runtime atau permintaan jaringan eksternal. Bukti: [verification.json](verification.json).
- Kontras computed CSS: teks utama/bantu pada tiga permukaan, garis input, dan CTA lulus kedua tema. Rasio terendah: teks bantu 6,24:1; garis input 3,39:1; CTA 7,44:1. Pasangan status dari token desain juga dihitung; terendah 4,77:1.
- Inspeksi visual: seluruh 20 PNG state diperiksa; label pemilih state mobile yang terpotong diperbaiki dan diperiksa ulang. Page review desktop/mobile diperiksa sampai state sesi habis dan footer. Reviewer konteks segar tidak menemukan penghalang tersisa.
- Sintaks Node, ESLint terarah pada script, Prettier pada README/page review/script, dan `git diff --check` lulus. Paket aplikasi tidak berubah; build/typecheck/test aplikasi tidak dijalankan. Instalasi root mempunyai tautan bin paket yang rusak, sehingga alat format/lint dipanggil langsung dari paket yang sudah ada di `.pnpm`; tidak memasang dependensi atau mengubah konfigurasi.

| Gate RYUX lanjutan | Hasil dan batas                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Product            | PASS lingkup mockup; bukti kuat dari brief. Konflik cakupan sakelar platform tetap menunggu keputusan melalui CTO.     |
| UX                 | PASS; satu CTA kontekstual, persetujuan risiko, pemulihan dan pembatasan peran diperiksa.                              |
| UI                 | PASS; task UI mengikuti arah petrol/netral hangat dan lapisan DESIGN v3.                                               |
| Design system      | PASS; satu aksen, satu keluarga netral/font, radius shell 18/kartu 12/kontrol 10/pill penuh; tanpa gradien atau emoji. |
| Accessibility      | NOT VERIFIED lengkap; kontras, fokus dan dialog diperiksa. Axe, pembaca layar, dan zoom 200% belum dijalankan.         |
| Responsive         | PASS pada 1280/390/320 di dua tema; page review tanpa overflow dan seluruh state masuk ekspor.                         |
| Edge cases         | PASS pada sepuluh state rancangan; bukan bukti perilaku jaringan/autentikasi nyata.                                    |
| Code quality       | PASS untuk sintaks dan script desain; N/A untuk kode produk.                                                           |
| Visual QA          | PASS untuk mockup dan ekspor page review yang diperiksa.                                                               |
| Anti-slop          | PASS; data contoh berlabel, tidak menambah tarif atau klaim koneksi berhasil.                                          |
| Final              | PASS sebagai artefak siap gerbang founder; persetujuan founder belum diberikan.                                        |

Menghasilkan ulang dari root worktree, berurutan melalui satu jalur `heavy`:

```sh
heavy node design/mockups/ai/render.mjs
heavy node design/mockups/ai/verify.mjs
heavy ghostex visual check design/mockups/ai/review.html --width 1280 --out design/mockups/ai/review.png
heavy ghostex visual check design/mockups/ai/review.html --width 390 --out design/mockups/ai/review-mobile.png
```

Lanjutan memakai empat subagent Codex, puncak tiga berjalan bersamaan: audit state, audit standar/page review, audit screenshot/README, dan reviewer konteks segar. Biaya/rata-rata paralel sesi Codex tidak tersedia: `session-usage` tidak menemukan transkrip dan `parallel-report` hanya memuat sesi Claude. Tidak menjalankan `bd` atau mengubah `docs/PROGRESS.md`, mengikuti batas brief. Hook Git yang hanya menjalankan Beads dilewati per perintah commit/push dengan `-c core.hooksPath=/dev/null`; konfigurasi repo tidak diubah.
