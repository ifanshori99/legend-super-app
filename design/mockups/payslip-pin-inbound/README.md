# Lupa PIN slip gaji — WhatsApp masuk

Mockup #425, untuk review founder melalui CTO. Seluruh layar memiliki lebar **390 px**, mengikuti UI PIN yang sudah dibangun. Tidak ada perubahan kode aplikasi.

## Alur

1. Karyawan membuka **Lupa PIN?**, lalu memilih **Lewat WhatsApp** atau membaca cara meminta bantuan HR/supervisor.
2. Web menampilkan kode pemulihan, nomor terdaftar yang disamarkan, masa berlaku, dan tombol **Buka WhatsApp**.
3. Tombol membuka percakapan ke nomor layanan dengan pesan berisi kode yang sudah terisi. Karyawan tetap harus menekan **Kirim** sendiri dari nomor WhatsApp yang terdaftar.
4. Karyawan kembali ke halaman web yang sama. Web memeriksa apakah pesan yang benar sudah masuk dari nomor yang sesuai. Membuka WhatsApp atau menyalin kode tidak berarti verifikasi berhasil.
5. Setelah verifikasi benar-benar berhasil, web menampilkan popup **Nomor berhasil diverifikasi**. Tombol **Buat PIN baru** membuka form PIN yang sudah ada.
6. Karyawan membuat PIN 6 angka dan mengulanginya. Penyimpanan PIN serta layar PIN tersimpan mengikuti alur yang sudah dibangun.

Tidak ada kode dari WhatsApp yang diketik ke web. Tidak ada balasan WhatsApp. Kode pemulihan dan PIN pribadi adalah dua hal yang terpisah.

## Daftar layar

| PNG | Tujuan / kondisi |
| --- | --- |
| [Lupa PIN](lupa-pin-mobile.png) | Memilih WhatsApp atau bantuan HR/supervisor. |
| [Menunggu WhatsApp](menunggu-whatsapp-mobile.png) | Kode, tombol pembuka WhatsApp, instruksi kirim dan kembali, countdown, serta jalur perangkat lain. |
| [Kode disalin](kode-disalin-mobile.png) | Feedback salin kode; status tetap menunggu pesan. |
| [Terverifikasi](terverifikasi-mobile.png) | Popup sukses di web, kemudian aksi membuat PIN baru. |
| [Kode kedaluwarsa](kode-kedaluwarsa-mobile.png) | Kode lama berhenti berlaku; buat kode baru. |
| [Nomor tidak cocok](nomor-tidak-cocok-mobile.png) | Perbaiki akun pengirim atau minta bantuan HR/supervisor. |
| [Terlalu banyak percobaan](terlalu-banyak-percobaan-mobile.png) | Countdown pembatasan dan jalur bantuan; tidak ada tombol WhatsApp aktif. |
| [Nomor belum terdaftar](nomor-belum-terdaftar-mobile.png) | Arahkan ke HR/supervisor untuk pembaruan nomor atau reset PIN. |
| [Bantuan HR](bantuan-hr-mobile.png) | Dua langkah bantuan manual, tanpa klaim permintaan sudah dikirim. |
| [Buat PIN baru](buat-pin-baru-mobile.png) | Form PIN 6 angka yang sudah ada, terpisah dari verifikasi WhatsApp. |

## Teks layar

Shell pada semua layar: **Cafe Legend**; kembali **Slip gaji**; label **PRIVASI GAJI**; judul **Slip gaji**; keterangan **Akses informasi gaji Anda secara pribadi.** Navigasi bawah: **Karyawan · Absen · Riwayat · Slip Gaji · Lainnya**.

### 1. Lupa PIN

- Judul: **Lupa PIN?**
- Pengantar: Pilih cara untuk membuat PIN baru.
- Aksi utama: **Lewat WhatsApp**.
- Bantuan aksi: Kirim pesan dari nomor yang terdaftar.
- Pilihan lain: **Minta bantuan HR atau supervisor**.
- Penjelasan: Tidak bisa pakai nomor terdaftar? Minta reset PIN ke HR atau supervisor di outlet.
- Aksi kedua: **Lihat cara minta bantuan**.
- Informasi: **PIN tetap pribadi** — HR bisa mereset PIN, tetapi tidak bisa melihat atau menentukan PIN Anda.

### 2. Menunggu pesan WhatsApp

- Judul: **Kirim lewat WhatsApp**.
- Nomor pengirim: Gunakan nomor terdaftar: **+62 812-••••-4821**.
- Label kode: **Pesan yang akan dikirim**.
- Pesan contoh: **PIN K7M9-2Q4P**.
- Timer contoh: **Berlaku 04:59 lagi**.
- Aksi utama: **Buka WhatsApp**.
- Instruksi: Pesan sudah terisi. Tekan Kirim tanpa mengubahnya, lalu kembali ke halaman ini.
- Status: **Menunggu pesan Anda…**
- Penjelasan: Verifikasi muncul di sini, tanpa balasan WhatsApp.
- Alternatif: **WhatsApp di perangkat lain?**
- Tujuan: Kirim kode ke nomor WhatsApp Cafe Legend: **+62 812-0000-4250**.
- Aksi salin: **Salin kode** dan **Salin nomor tujuan**.
- Jalur bantuan: **Minta bantuan HR atau supervisor**.

### 3. Kode disalin

Sama seperti layar menunggu; tombol berubah sementara menjadi **Kode disalin**, dengan ikon centang. Toast: **Kode disalin. Tempel dan kirim lewat WhatsApp.** Aksi **Salin nomor tujuan** tetap tersedia. Dalam produk, setelah feedback label tombol kembali menjadi **Salin kode**. Menyalin nomor menampilkan feedback **Nomor tujuan disalin**; status tetap menunggu sampai pesan diterima. Sumber desain statis mempertahankan feedback untuk review dan, khusus nomor ilustrasi, menampilkan **Nomor contoh disalin. Jangan kirim pesan ke nomor ini.**

### 4. Popup sukses terverifikasi

- Ikon centang dan judul: **Nomor berhasil diverifikasi**.
- Keterangan: Sekarang buat PIN slip gaji yang baru.
- Satu aksi utama: **Buat PIN baru**.

Halaman menunggu diredupkan di belakang dialog. Popup muncul saat browser aktif kembali dan hasil verifikasi dari server sudah sukses, termasuk bila pesan masuk saat pengguna berada di WhatsApp. Tidak ada auto-redirect yang membuat hasil sukses terlewat.

### 5. Kode kedaluwarsa

- Judul: **Kode sudah kedaluwarsa**.
- Penjelasan: Pesan dengan kode ini tidak bisa dipakai lagi. Buat kode baru, lalu kirim lewat WhatsApp.
- Kode lama: **Kode tidak berlaku — PIN K7M9-2Q4P — 00:00**.
- Aksi utama: **Buat kode baru**.
- Aksi bantuan: **Minta bantuan HR atau supervisor**.

Tidak ada tombol untuk membuka WhatsApp memakai kode yang kedaluwarsa. Membuat kode baru kembali ke layar menunggu; timer dan pesan diambil dari tantangan baru.

### 6. Nomor pengirim tidak cocok

- Judul: **Nomor WhatsApp tidak cocok**.
- Penjelasan: Pesan dikirim dari nomor yang berbeda. Gunakan nomor yang terdaftar: **+62 812-••••-4821**.
- Instruksi: Pilih akun WhatsApp dengan nomor tersebut sebelum mengirim pesan.
- Aksi utama: **Coba dari nomor terdaftar**.
- Bantuan: **Nomor sudah berubah?** — Minta bantuan HR atau supervisor di outlet untuk memperbarui nomor atau mereset PIN.
- Aksi bantuan: **Lihat cara minta bantuan**.

Nomor pengirim yang tidak cocok tidak ditampilkan. Usulan desain: aksi utama meminta tantangan baru lalu kembali ke layar menunggu, supaya tidak bergantung pada apakah kontrak mempertahankan kode setelah mismatch. Jangan langsung membuka WhatsApp memakai kode lama. Perilaku final tantangan mengikuti kontrak #424.

### 7. Terlalu banyak percobaan

- Judul: **Terlalu banyak percobaan**.
- Penjelasan: Pemulihan lewat WhatsApp dibatasi sementara. Tunggu sebelum mencoba lagi.
- Timer contoh dengan ikon jam: **Coba lagi dalam 09:59**.
- Bantuan: Sambil menunggu, Anda bisa minta reset PIN ke HR atau supervisor di outlet.
- Aksi utama: **Lihat cara minta bantuan**.
- Aksi kedua: **Kembali ke slip gaji**.

Waktu tunggu berasal dari server. Saat pembatasan benar-benar selesai, layar menawarkan **Coba lagi** untuk membuat tantangan baru. Tidak menetapkan jumlah percobaan atau durasi pembatasan baru lewat mockup.

### 8. Nomor WhatsApp belum terdaftar

- Judul: **Nomor WhatsApp belum terdaftar**.
- Penjelasan: Pemulihan lewat WhatsApp belum bisa dipakai. Minta HR atau supervisor di outlet memperbarui nomor atau mereset PIN Anda.
- Aksi utama: **Lihat cara minta bantuan**.
- Aksi kedua: **Kembali ke slip gaji**.
- Informasi: **PIN tetap pribadi** — HR bisa mereset PIN, tetapi tidak bisa melihat atau menentukan PIN Anda.

Tidak ada kolom untuk mengganti nomor sendiri dan tidak ada tombol WhatsApp aktif.

### 9. Bantuan HR atau supervisor

- Judul: **Minta bantuan HR atau supervisor**.
- Pengantar: Hubungi HR atau supervisor di outlet dan minta reset PIN slip gaji.
- Langkah 1: **Minta reset PIN** — Sampaikan bahwa Anda lupa PIN slip gaji.
- Langkah 2: **Buka slip gaji lagi** — Setelah HR meresetnya, buat PIN baru sendiri.
- Informasi: HR tidak bisa melihat atau menentukan PIN Anda.
- Aksi utama: **Kembali ke slip gaji**.

Ini panduan menghubungi orang di outlet, bukan tombol pengiriman permintaan. Tidak mengarang nama, nomor kontak, atau otomatisasi HR.

### 10. Buat PIN baru

- Judul: **Buat PIN slip gaji**.
- Pengantar: Buat PIN pribadi untuk membuka slip gaji Anda.
- Label: **PIN baru** — enam kotak angka kosong.
- Petunjuk: Gunakan 6 angka yang mudah Anda ingat.
- Label konfirmasi: **Ulangi PIN baru** — enam kotak angka kosong.
- Aksi utama: **Simpan PIN**.
- Informasi: **Informasi** — PIN hanya dibuat dan diketahui oleh Anda. HR dapat mereset PIN, tetapi tidak dapat melihat atau menentukan PIN Anda.

Form ini memakai layar PIN yang sudah dibangun; enam kotak di layar ini hanya untuk PIN pribadi. Bukan kolom kode WhatsApp.

## Keputusan desain

1. **Pertahankan shell layar PIN yang ada.** Latar putih, satu font Plus Jakarta Sans, teal `#0f5e68`, kartu berbingkai tipis radius 12 px, tombol utama pill 56 px, serta navigasi bawah yang sama menjaga kontinuitas. Ini perubahan cara verifikasi, bukan eksplorasi gaya atau desktop baru.
2. **Pisahkan kirim, verifikasi, dan membuat PIN.** Satu kode sebagai teks yang bisa disalin menggantikan pola input OTP. Instruksi menekankan tindakan Kirim dan kembali ke web; feedback salin tidak menyerupai sukses verifikasi. Popup sukses baru memberi jalan ke form PIN.
3. **Setiap kegagalan memberi jalan pulih yang jelas.** Kedaluwarsa membuat kode baru; mismatch mengarahkan pengirim yang tepat; pembatasan menunggu waktu server; nomor belum terdaftar dan nomor berubah menuju bantuan HR/supervisor. Jalur perangkat lain menyertakan kode dan nomor tujuan yang dapat disalin.

## Sumber, asumsi, dan keputusan yang belum menjadi kontrak

- Referensi utama yang dibaca satu per satu: `lupa-pin-390.png`, `lupa-pin-belum-tersedia-390.png`, `kode-whatsapp-390.png`, `buat-pin-390.png`, dan `pin-tersimpan-390.png` di `.worktrees/payslip-pin-ui/design/screenshots/payslip-pin/`. `DESIGN.md`, `design/REFERENCES.md`, standar tim, brief #412, #424, dan #425 menjadi konteks pendukung. Bukti visual berasal dari repo, tanpa klaim audit produk luar.
- **Nomor tujuan `+62 812-0000-4250` adalah ilustrasi mockup, bukan nomor layanan.** Nomor layanan sebenarnya belum tersedia dalam bahan. Implementasi wajib menggantinya dengan konfigurasi tujuan WhatsApp yang sah dan konsisten antara label, tombol salin, dan pembuka WhatsApp. Sumber mockup tidak memiliki tautan wa.me aktif ke nomor contoh.
- **Nomor pengirim tersamar, pesan `PIN K7M9-2Q4P`, dan countdown adalah data contoh.** Jangan memperlakukan format kode sebagai kontrak atau kode operasional. Jangan memasukkan PIN pribadi ke pesan WhatsApp.
- **TTL 5 menit mengikuti referensi lama sebagai asumsi visual saja.** Kontrak verifikasi masuk #424 menentukan TTL, format pesan, lifecycle tantangan, polling/SSE, dan batas percobaan final. Countdown pembatasan 09:59 adalah snapshot nilai `retry-after`, bukan usulan aturan sepuluh menit.
- Tombol WhatsApp pada mockup hanya menjelaskan aksi yang akan dilakukan produk. Tidak mengirim pesan atau memverifikasi nomor sungguhan. Keberhasilan backend, kirim WhatsApp, dan reset HR belum diuji melalui mockup.
- Saat koneksi terputus, produk harus tetap di halaman ini dan menampilkan **Koneksi terputus. Sambungkan internet untuk memeriksa pesan.** dengan **Coba periksa lagi**. Kembali ke tab memeriksa ulang status serta expiry server; timer lokal bukan sumber keputusan. State offline tidak diberi PNG tersendiri dalam cakupan brief ini.
- Desain hanya mengklaim lebar 390 px tema terang. Desktop, tema gelap, audit browser aplikasi, Lighthouse, dan e2e bukan cakupan hasil ini.

## Sumber desain dan regenerasi

- `index.html`: sumber desain statis, bukan kode aplikasi atau integrasi API.
- `render.cjs`: ekspor dan pemeriksaan PNG melalui Playwright, memakai Chrome lokal.
- `plus-jakarta-sans-latin.woff2`: font lokal dari mockup proyek sebelumnya.
- `BRIEF.md`: rencana desain dan spesifikasi kerja. Bila ada revisi, README dan PNG akhir menjadi handoff yang berlaku.
- Draf visual dibuat dengan tool imagegen bawaan memakai `lupa-pin-390.png` sebagai referensi gaya, lalu direkonstruksi sebagai sumber desain HTML untuk memastikan lebar 390 px dan teks Indonesia persis. Prompt: screenshot satu layar Lupa PIN, shell Cafe Legend, font Jakarta, tombol teal, pilihan WhatsApp/HR dan copy yang sama dengan layar 1. Tidak memakai CLI/API imagegen atau mengubah kode produk.

Jalankan dari root worktree:

```sh
heavy node design/mockups/payslip-pin-inbound/render.cjs
```

Hasil pemeriksaan akhir dan ukuran masing-masing layar dicatat setelah ekspor pada `verification.json`. Pemeriksaan ini memverifikasi artefak desain; bukan bukti integrasi WhatsApp.

## Catatan pengerjaan

- Lima subagent Codex membantu eksplorasi visual/alur, sumber mockup, renderer, dan review; puncak empat subagent aktif bersamaan.
- Peran designer membatasi perubahan pada folder mockup; catatan kerja disimpan di sini, bukan mengubah `docs/PROGRESS.md`.
- Skrip tim `session-usage.py` tidak menemukan transkrip sesi Codex ini; biaya/token dan rata-rata paralel sesi tidak tersedia. `parallel-report` yang tersedia hanya menghitung sesi Claude, sehingga angkanya tidak dipakai sebagai metrik sesi ini.
