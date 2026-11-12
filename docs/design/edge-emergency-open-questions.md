# Keputusan terbuka: tombol darurat edge

Status: keputusan CTO dan usulan yang masih terbuka ditandai pada masing-masing bagian. FAC-08 mensyaratkan notifikasi ke staf bertugas dalam paling lama lima detik, termasuk ketika internet outlet mati. Alur V menyebut attendant dan supervisor, serta pencatatan respons dan tindak lanjut.

## 1. Identitas PIN lokal untuk alarm dan respons

**Konteks.** Edge menerima replika PIN dan roster, tetapi tidak menerima akun password. Verifikasi PIN perangkat tanpa sesi sudah ada; hasilnya bukan sesi. Proof `attendance_clock` sekali pakai hanya untuk absensi, sedangkan token POS bergantung pada sesi Better Auth. Jalur WebSocket dan respons insiden perlu identitas yang sama-sama dapat diverifikasi secara lokal.

**Opsi.** (A) Terbitkan kredensial khusus darurat setelah verifikasi PIN dan perangkat terdaftar, lalu pakai untuk menerima alarm dan mencatat respons. (B) Gunakan sesi Better Auth yang sudah ada dan batasi dukungan offline pada staf yang sudah memiliki sesi lokal. (C) Gunakan satu terminal outlet bersama yang menerima alarm tanpa identitas staf, dengan identitas diverifikasi saat respons.

**Rekomendasi.** A, setelah CTO secara eksplisit memperluas scope autentikasi dan architect mereview desain. Gunakan verifikasi PIN dengan throttle yang sudah ada; ikat kredensial ke tenant, outlet, perangkat, staf, versi PIN, dan masa berlaku. Validasi kembali perangkat, status staf, izin, dan masa berlaku ketika koneksi dibuat dan saat respons; jangan menaruh PIN atau kredensial di URL atau log. Browser WebSocket memerlukan mekanisme pengiriman kredensial yang sesuai, misalnya cookie terbatas dengan Origin tepercaya dan HTTPS lokal. Endpoint respons harus menulis respons dan event sinkronisasi dalam satu transaksi.

**Pencabutan.** Tentukan kapan kredensial berakhir dan cara menutup koneksi setelah PIN diganti, perangkat dicabut, staf dinonaktifkan, atau izin berubah. Pilih antara sesi singkat yang memerlukan PIN ulang dan sesi lebih panjang dengan pemeriksaan ulang setiap pengiriman. Rekomendasi: sesi terbatas dengan pemeriksaan ulang dan invalidasi berdasarkan versi PIN serta status perangkat. Saat internet mati, edge hanya mengetahui pencabutan yang sudah mencapai replika lokal; batas keterlambatan ini harus dinyatakan dan diuji. Jangan memakai proof absensi sebagai sesi darurat.

## 2. Pemulihan incident setelah perubahan cloud saat offline

**Konteks.** Tiket dapat terbit offline; handler sinkronisasi tiket ke tabel cloud belum ditemukan. Bilik, fasilitas, atau izin responder juga dapat berubah sebelum edge tersambung lagi. Penolakan event yang langsung diakui sebagai konflik tidak otomatis memperbarui laporan insiden.

**Opsi.** (A) Tunda incident dalam antrean pemulihan sampai tiket dan referensi lain tersedia, kemudian terapkan ulang secara idempoten dan berurutan. (B) Simpan incident sebagai catatan keselamatan dengan referensi dan lokasi historis yang tersedia, tandai ketidakcocokan untuk rekonsiliasi, lalu hubungkan tiket ketika tersedia. (C) Tolak event dan serahkan koreksi manual ke operator.

**Rekomendasi.** B dengan antrean rekonsiliasi yang tahan restart dan terlihat oleh operator; A dapat dipakai untuk melengkapi referensi bila dependensinya sudah tersedia. Simpan pemicu, respons, asal node, dan waktu lokal tanpa menimpa data lain; cek tenant dan outlet pada setiap langkah. Tentukan bukti dan kebijakan izin historis sebelum menerima respons dari edge: izin cloud saat sinkronisasi tidak membuktikan izin saat respons dibuat. Jangan menyamakan pencatatan konflik dengan incident yang sudah masuk laporan. Uji tiket yang belum ada di cloud, fasilitas/bilik yang diubah atau dihapus, pencabutan izin setelah respons, replay, dan urutan event yang hilang.

## 3. Label lokasi historis

**Konteks.** Saat bilik atau area dihapus dan kode atau namanya dipakai ulang, snapshot edge tidak boleh mengganti label incident lama menjadi label acak atau label bilik baru. Incident terbuka tetap harus menunjukkan lokasi yang benar kepada staf.

**Opsi.** (A) Simpan label bilik dan area sebagai snapshot pada setiap incident. (B) Pertahankan versi konfigurasi atau tombstone yang dapat direferensikan incident. (C) Larang penggunaan ulang label selama incident terkait masih ada.

**Rekomendasi.** A sebagai data historis minimum, dengan identitas bilik tetap disimpan; gunakan B bila dibutuhkan riwayat konfigurasi yang lebih lengkap. Tentukan migrasi dan batas perubahan skema sebelum implementasi. Uji pertukaran dua kode/nama, penghapusan diikuti penggunaan ulang, incident terbuka, rollback snapshot gagal, dan pembacaan pada outlet lain.

## 4. Masa berlaku clock-in dan data kedaluwarsa

**Keputusan CTO.** Daftar staf bertugas adalah gabungan staf dengan shift aktif dan staf yang sudah clock-in di edge. Clock-out tidak meniadakan kelayakan dari shift yang masih aktif. Jika tidak ada penerima saat alarm dikirim, edge menyimpan incident dan mencoba mengirim ulang.

**Konteks terbuka.** Clock-in terakhir tanpa batas waktu dapat mempertahankan staf sebagai bertugas selamanya. Snapshot edge berisi interval shift yang diterbitkan, sedangkan perubahan roster dan absensi cloud tidak selalu tersedia saat outlet offline. Shift terjadwal tidak membuktikan kehadiran aktual.

**Opsi.** (A) Batasi masa berlaku clock-in dengan durasi maksimum yang ditetapkan. (B) Batasi menurut akhir jendela kerja atau hari operasional yang ditetapkan. Untuk data kedaluwarsa, pilih apakah edge tetap memakai salinan terakhir sambil menunjukkan statusnya atau menaikkan eskalasi tambahan setelah batas yang ditetapkan.

**Rekomendasi.** Tetapkan batas masa berlaku clock-in dan cara menangani data kedaluwarsa sebelum mengklaim daftar penerima selalu mutakhir. Pertahankan gabungan yang diputuskan CTO dan retry saat belum ada penerima; pembatasan izin tenant dan outlet tetap wajib. Uji clock-in lama, clock-out ketika shift masih aktif, shift lintas tengah malam, roster kedaluwarsa, absensi cloud yang belum tersalin, serta penerima yang tersambung setelah retry.

## 5. Bukti FAC-08 dalam lima detik

**Konteks.** Waktu HTTP 201 dan `ws.send()` yang hanya memasukkan pesan ke buffer bukan bukti staf menerima alarm. Pengiriman ke satu socket juga tidak membuktikan bahwa attendant dan supervisor yang bertugas sama-sama menerima notifikasi.

**Opsi.** (A) Ukur pesan diterima dan diakui klien setiap penerima yang memenuhi kriteria. (B) Ukur hanya pengiriman dari server, lalu uji tampilan dan penerimaan sebagai pemeriksaan terpisah. (C) Hitung cukup satu penerima untuk semua kelompok.

**Rekomendasi.** A: tetapkan titik awal pada penerimaan pemicu perangkat di edge dan titik akhir pada acknowledgement klien yang diverifikasi; pisahkan target penerimaan alarm dari waktu manusia merespons incident. Simpan status dan retry per penerima atau kelompok yang telah ditetapkan, termasuk penerima yang tersambung kembali, tanpa menduplikasi incident. Jalankan uji integrasi dengan perangkat dan identitas lokal nyata, internet cloud diputus, attendant dan supervisor aktif, tenant/outlet lain, kegagalan dan reconnect socket, restart, dan pengukuran hingga lima detik. Sesuai keputusan CTO, edge terus mencoba saat belum ada penerima; eskalasi tambahan masih perlu diputuskan. Sistem tidak boleh mengklaim target terpenuhi tanpa bukti penerimaan.
