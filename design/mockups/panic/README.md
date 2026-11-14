# Mockup alert panik staf

Mockup untuk gerbang founder `legend-alovk`, sesuai brief `681-designer-panic-banner.md`. Pengguna adalah staf fasilitas yang sedang bertugas. Tujuan utamanya: segera memahami lokasi darurat, lalu menyatakan bahwa ia menuju lokasi melalui “Saya tangani”. Ini artefak review desain, belum terhubung ke perangkat, WebSocket, atau API.

Ruang lingkup seluruh berkas adalah `design/mockups/panic/`. Page gabungan: `review.html`. Ukuran review: desktop 1280 px dan mobile 390 px. Data “Outlet Bandung”, “Fasilitas karaoke”, “Ruang 07”, dan “20.41.08 WIB” merupakan contoh ilustratif, bukan data operasional.

## Arah visual untuk gerbang

**Arah A — rekomendasi:** permukaan putih, nama ruang paling dominan, status darurat merah tegas. Lokasi menjadi titik baca pertama, sementara kata “Darurat” dan ikon mempertahankan urgensi tanpa memenuhi seluruh bidang dengan merah. Cocok untuk membandingkan lokasi beberapa alert dan membaca keterangan koneksi.

**Arah B — alternatif:** permukaan merah dengan teks terang dan seruan darurat paling dominan. Bidang penuh memberi sinyal interupsi kuat, dengan konsekuensi lokasi tidak menjadi titik baca pertama dan lebih banyak konten berada pada permukaan alarm. Kedua arah adalah pilihan gerbang desain; belum ada arah yang disetujui founder. Enam state menggunakan satu struktur agar perbedaan arah dapat dibandingkan tanpa mengubah makna tindakan.

## Enam state dan integrasi

| State                       | Fragmen             | Tujuan staf dan aturan tampilan                                                                                                                                                                        |
| --------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Alert masuk                 | `incoming.html`     | Menampilkan lokasi/ruang, waktu diterima, status belum ditanggapi, dan satu aksi utama “Saya tangani”.                                                                                                 |
| Sudah ditanggapi orang lain | `acknowledged.html` | Menjelaskan bahwa seseorang sudah menuju lokasi. Tanggapan tidak berarti insiden selesai. Identitas penanggap hanya boleh ditampilkan bila tersedia dari kontrak yang berwenang.                       |
| Menyambung ulang            | `reconnecting.html` | Menampilkan koneksi terganggu dan percobaan sambung otomatis. Status alert terakhir harus dibedakan dari pembaruan langsung; jangan menjanjikan ACK terkirim sebelum API berhasil.                     |
| Tidak terjangkau            | `unreachable.html`  | Mengarahkan staf kembali ke layar PIN untuk memeriksa sesi. Jangan menyatakan sesi pasti kedaluwarsa hanya dari kegagalan koneksi.                                                                     |
| Perangkat dicabut           | `revoked.html`      | Menjelaskan penerimaan alert berhenti pada perangkat ini dan memberi arahan memeriksa perangkat aktif bersama penanggung jawab. Jangan menyamakan pencabutan dengan gangguan jaringan biasa.           |
| Beberapa alert beruntun     | `multiple.html`     | Mempertahankan tiap lokasi sebagai alert berbeda, memperlihatkan jumlah antrean dan urutannya, serta memberi tindakan yang jelas untuk alert terpilih. FIFO merupakan usulan yang menunggu konfirmasi. |

Page review menggabungkan fragmen di atas dengan gaya bersama dan pemilih state. Semua kontrol pada page merupakan simulasi. Desktop mempertahankan lokasi dan tindakan dalam bidang baca yang ringkas. Mobile menyusun konten vertikal, membesarkan target aksi utama, dan menghindari scroll horizontal. Status memakai teks dan ikon selain warna. Tidak ada kedipan atau gerak dekoratif; implementasi harus tetap statis ketika `prefers-reduced-motion: reduce` aktif.

## Kontrak yang sudah diamati

Sumber: cabang `ws/panic-alert`, `apps/web/src/features/facility-staff/panic-realtime.ts` dan `packages/shared/src/facility/emergency.ts`; brief backend `docs/briefs/674-panic-alert.md` di root kerja utama. Berkas brief tersebut belum tersedia pada base worktree desain.

- Frame server `type: "panic"` membawa `alertId`, `outletId`, `unitId` yang boleh `null`, `receivedAt`, serta `kind: "press" | "test"`. Frame ini tidak membawa nama outlet, fasilitas, ruang, atau penanggap. Jenis `test` harus diberi penanda “UJI”.
- `onAlert` dipanggil sekali per `alertId` yang sudah ditampilkan. Balasan transport `received` dikirim untuk setiap frame valid, termasuk pengiriman ulang. Balasan ini hanya menandakan alert sudah ditampilkan, bukan staf bersedia menangani.
- `ack(alertId)` memanggil `POST /api/emergency/alerts/:id/ack` dengan body kosong. Promise yang berhasil menjadi dasar feedback “Saya tangani”; kegagalan API tidak boleh berubah menjadi sukses lokal. ACK berarti staf menuju lokasi, bukan menutup insiden.
- Klien memberi status `connecting`, `open`, `reconnecting`, `unreachable`, `revoked`, dan `stopped`. Sesudah empat penutupan beruntun sebelum socket pernah terbuka, status menjadi `unreachable`; klien masih mencoba tersambung. Keadaan ini sendiri tidak membuktikan sesi atau perangkat dicabut.
- Close code `4401` menghentikan koneksi dan memanggil `onRevoked`. Alasan pencabutan tidak tersedia di callback tersebut; copy tidak boleh mengarang penyebabnya.
- `GET /api/emergency/fallback` mempunyai kontrak daftar `alertId`, `unitCode` yang boleh `null`, dan `receivedAt`. Kontrak fallback ini tidak menyediakan nama penanggap atau metadata fasilitas lengkap.

### Batas kontrak untuk implementasi berikutnya

Nama ruang/outlet pada mockup membutuhkan sumber metadata yang dapat dipercaya. Harus ada tampilan lokasi yang tidak diketahui ketika `unitId` atau `unitCode` kosong. State “ditanggapi orang lain” belum dapat dibentuk dari frame WS saat ini saja: perlu sumber status ACK yang berwenang, termasuk cara menangani ACK bersamaan. Daftar beberapa alert dapat dibentuk dari alert unik yang diterima, tetapi aturan urut, pemulihan daftar setelah muat ulang, serta indikator “masih terbuka” perlu ditetapkan. Mockup tidak membuktikan ketiga kemampuan tersebut tersedia.

## Tiga keputusan desain

### 1. Lokasi sebagai hierarki utama

- **Pilihan:** nama ruang paling besar pada permukaan putih (A), atau seruan darurat paling besar pada permukaan merah (B).
- **Bukti:** brief secara eksplisit meminta lokasi/ruang, waktu, dan tindakan pada layar penuh; standar UI meminta hierarki jelas dan status tidak bergantung warna. Sumber teramati: brief 681 dan `~/.agents/team/ui-standard.md`. Bukti pembanding produk: tidak tersedia.
- **Trade-off:** A memudahkan pencarian lokasi; B memberi interupsi visual lebih kuat.
- **Keputusan desain:** rekomendasikan A, pertahankan B sebagai alternatif gerbang sampai founder memilih.

### 2. Pisahkan terlihat, ditanggapi, dan selesai

- **Pilihan:** feedback tunggal “selesai”, atau status eksplisit untuk penerimaan transport, ACK staf, dan penutupan insiden.
- **Bukti:** klien memiliki balasan `received` dan method `ack` terpisah; kontrak penutupan memakai endpoint `resolve` terpisah. Sumber teramati: kontrak klien dan shared pada `ws/panic-alert`.
- **Trade-off:** status eksplisit membutuhkan copy sedikit lebih panjang, tetapi mengurangi kesan bantuan sudah selesai setelah tombol ditekan.
- **Keputusan desain:** tombol “Saya tangani” menyatakan menuju lokasi; status orang lain tidak menyatakan keadaan aman atau insiden ditutup.

### 3. Gangguan koneksi tidak menghapus kebutuhan bertindak

- **Pilihan:** kembali ke layar kosong ketika koneksi hilang, atau menampilkan kondisi koneksi dan langkah pemulihan yang spesifik.
- **Bukti:** brief mewajibkan reconnecting, unreachable menuju PIN, dan revoked; klien membedakan ketiganya. Sumber teramati: brief 681 dan `panic-realtime.ts`.
- **Trade-off:** mempertahankan informasi alert terakhir membutuhkan label status yang jelas agar data lama tidak disangka pembaruan langsung.
- **Keputusan desain:** bedakan mencoba ulang, perlu pemeriksaan lewat PIN, dan perangkat berhenti menerima alert; tidak menjanjikan pengiriman atau ACK saat koneksi belum pasti.

## Asumsi untuk konfirmasi founder melalui CTO

- **Urutan antrean:** usulan FIFO berdasarkan waktu diterima; alert baru menambah antrean dan tidak mengganti alert yang sedang dibaca. Konfirmasi apakah ini urutan penanganan yang diinginkan.
- **Metadata lokasi:** nama ruang menjadi informasi terbesar, disertai fasilitas dan outlet. Konfirmasi istilah lokasi yang staf kenali di lapangan; engineering perlu memastikan sumber label tersebut tersedia.
- **Arahan perangkat aktif:** ketika perangkat dicabut, usulan copy mengarahkan staf memeriksa perangkat aktif bersama penanggung jawab, tanpa menjanjikan perangkat pengganti atau pendaftaran ulang otomatis. Konfirmasi siapa penanggung jawab yang tepat untuk disebut.
- **Arah visual:** A direkomendasikan; B disediakan untuk perbandingan. Pilihan founder masih terbuka.

## Status pemeriksaan

Bukti dan batas lengkap: [VERIFICATION.md](VERIFICATION.md). Page review serta enam state telah dirender pada 1280 dan 390; review juga diperiksa pada 320, tanpa overflow. Audit browser mencakup 21 kombinasi layar/lebar; sesudah temuan nama aksesibel diperbaiki, tiga kombinasi antrean diperiksa ulang dan lulus. Simulasi ACK, hitungan antrean, PIN, native details, fokus keyboard, reduced motion, dan posisi CTA mobile diperiksa. Integrasi API/WS, perangkat nyata, suara, getaran, dan uji dengan staf belum diuji.

Gambar tiap state memakai nama `<state>-desktop.png` dan `<state>-mobile.png`. Dua arah utama: `arah-a-alert-{desktop,mobile}.png` dan `arah-b-alert-{desktop,mobile}.png`. Preview offline mandiri: `state-<state>.html`.

Untuk memperbarui artefak: jalankan `python3 design/mockups/panic/build_review.py`, lalu formatter dengan `--ignore-path /dev/null` karena folder desain diabaikan konfigurasi repo. Capture serial: `heavy python3 design/mockups/panic/render.py`. Audit browser: `PANIC_AUDIT_NODE_MODULES=<direktori node_modules lokal> heavy node design/mockups/panic/audit-browser.cjs`; versi alat dicatat dalam hasil JSON.

Enam subagent Codex membuat state paralel; puncak enam berjalan bersamaan. Parent menggabungkan dan mengambil keputusan. Tidak menjalankan bd. Catatan kerja disimpan di folder ini sesuai batas brief, tanpa mengubah dokumen proyek di luar scope.
