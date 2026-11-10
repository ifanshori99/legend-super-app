# Edge hilang atau dicuri (legend-svy91)

Runbook ini untuk owner tenant dan tim ops. Dipakai saat sebuah edge (mini PC di outlet yang menjalankan server lokal) hilang, dicuri, atau tidak bisa dipastikan keberadaannya. Desain dan alasan ada di `docs/design/hris-edge-replication.md` section 7.

## Kapan dipakai

- Edge dibawa pergi dari outlet, hilang, atau dicuri.
- Edge tidak ditemukan lagi di lokasi dan tidak bisa dipastikan aman.
- Ada tanda edge diakses tanpa izin (akses fisik ke perangkat, atau log cloud menunjukkan edge credential dipakai dari lokasi lain).

Jika edge hanya rusak dan tidak ada yang membawanya pergi, ikuti pemulihan biasa, bukan runbook ini.

## Apa yang dipegang pencuri dan responsnya

Tabel ini mengikuti desain section 7.

| Yang ada di edge yang dicuri                                                              | Dampak                                                                                                                  | Respons                                                  |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Edge credential (disimpan di env biasa)                                                   | Bisa memanggil edge-sync seolah-olah outlet itu                                                                         | Cabut node (langkah 0-60 menit)                          |
| Kunci QR harian (sekitar 5 hari)                                                          | Token QR palsu untuk hari-hari tersebut                                                                                 | Rotasi seed QR outlet (langkah 0-60 menit)               |
| Nama, `employee_no`, jenis kerja, tanggal masuk dan keluar, peran, jadwal 8 hari ke depan | Data pribadi (UU PDP)                                                                                                   | Penilaian pelanggaran dalam 3x24 jam                     |
| Hash PIN staf dan `STAFF_PIN_PEPPER` (akar, di env)                                       | PIN pendek bisa ditebak offline. Pepper akar dipakai untuk menurunkan pepper semua tenant, jadi dampaknya lintas tenant | Reset PIN staf, rotasi versi pepper (langkah 0-60 menit) |
| Selfie tersegel (`.lss`)                                                                  | Gambar dan metadata (siapa, outlet, waktu) tidak bisa dibaca. Header hanya memuat tenant dan id objek                   | Tidak ada tindakan khusus                                |
| Metadata `edge_selfie_uploads` dan `attendance_logs` lokal (35 hari)                      | Siapa absen kapan                                                                                                       | Masuk penilaian pelanggaran                              |
| Hash password, NIK, NPWP, rekening, BPJS                                                  | Tidak ada di edge                                                                                                       | Tidak ada tindakan                                       |

Edge tidak pernah menyimpan kunci privat seal (`ATTENDANCE_SELFIE_SEAL_KEYS`, `ATTENDANCE_SELFIE_SEAL_ACTIVE_KID`). Kunci itu hanya ada di cloud.

## Langkah 0-60 menit

1. **Cabut node edge.** Panggil `POST /api/edge-nodes/:edgeNodeId/revoke` dengan body `outletId` dan `reason` (alasan wajib, 1 sampai 500 karakter, misalnya "edge dicuri"). Izin: `device.registry.revoke`. Pencabutan bersifat final dan menutup link node itu. Cari edge node lewat `GET /api/edge-nodes?outletId=`. Nama tombol di UI: TBD-verify (tidak ditemukan di `apps/web/src`).
2. **Cabut perangkat absensi di outlet** jika ada perangkat yang terdaftar di edge yang sama: `POST /attendance/devices/:deviceId/revoke` pada router HRIS attendance (path lengkap di bawah `/api/hris`: TBD-verify).
3. **Rotasi seed QR outlet.** Panggil `POST /api/hris/attendance/qr/rotate` (path mount: TBD-verify). Izin: `MANAGE` HRIS. Tombol di UI: TBD-verify. Setelah rotasi, token QR lama tidak diterima lagi.
4. **Reset PIN staf.** Tidak ada endpoint reset massal yang terverifikasi. Set PIN baru per staf lewat `PUT /api/staff-pins/:outletId/:userId` (butuh back-office). Set PIN juga menghapus penghitung salah dan kunci (`services/device-pin.service.ts`). Apakah ada tombol "force reset" massal: TBD-verify.
5. **Rotasi versi pepper.** Pepper dikelola lewat `STAFF_PIN_PEPPER` dan versi di `services/device-pin-pepper.ts` (`STAFF_PIN_PEPPER_VERSION`, saat ini 1). Mengganti `STAFF_PIN_PEPPER` membuat semua hash lama tidak valid, sehingga setiap staf harus set PIN baru. Rotasi versi perlu perubahan kode (lihat `legend-ideif`). Pepper per edge (diturunkan per tenant, tanpa pepper akar di edge) belum terverifikasi sebagai fitur yang sudah jalan: TBD-verify. Tulis di catatan insiden jika belum ada.
6. Catat waktu kejadian, siapa yang melapor, dan langkah yang sudah dijalankan.

## Sampai 24 jam

- Pastikan edge pengganti sudah disiapkan atau outlet memakai jalur cadangan (jalur B dengan PIN, lihat desain section 2).
- Cek daftar kejadian di log cloud untuk node itu sejak waktu terakhir terhubung. Cari akses dari credential lama.
- Kumpulkan daftar data yang ada di edge (lihat tabel di atas) untuk penilaian.

## Penilaian pelanggaran dalam 3x24 jam (UU PDP, R16)

Penilaian ini dilakukan oleh owner dan penanggung jawab data. Checklist:

- [ ] Daftar nama staf dan `employee_no` yang ada di edge, dan jumlah orangnya.
- [ ] Jenis data: jenis kerja, tanggal masuk dan keluar, peran, jadwal 8 hari ke depan.
- [ ] Riwayat absensi lokal (`attendance_logs`, 35 hari) dan metadata selfie (`edge_selfie_uploads`).
- [ ] Hash PIN staf: apakah PIN perlu direset untuk semua outlet yang memakai pepper yang sama.
- [ ] Selfie tersegel: tidak bisa dibaca tanpa kunci privat di cloud. Catat ini dalam penilaian.
- [ ] Keputusan: apakah ada kewajiban pemberitahuan. Keputusan ini diambil founder dan penasihat hukum, bukan tim teknis.

## Pemulihan edge pengganti

1. Daftarkan node baru lewat `POST /api/edge-nodes` (201, credential ditampilkan sekali). Ikuti urutan di `deploy/edge/README.md`.
2. Jangan pakai salinan disk atau cadangan edge yang dicuri. Node baru selalu mulai dari database kosong (lihat `docs/deployment.md` "Staff device PIN down-sync runbook").
3. Pasang `STAFF_PIN_PEPPER` di edge baru sesuai versi yang berlaku setelah langkah 5.
4. Cek `GET /api/edge/health` pada edge baru. Field `selfieVolume` hanya informasi dan tidak mengubah status.

## Verifikasi akhir

- [ ] Node lama tidak bisa dipakai: panggilan edge-sync dengan credential lama ditolak.
- [ ] Seed QR lama tidak diterima.
- [ ] Staf yang terdampak sudah set PIN baru.
- [ ] Edge pengganti sudah sinkron dengan cloud (`GET /api/edge/health` menunjukkan `cloudLink` dan `database` ok).
- [ ] Penilaian pelanggaran sudah tertulis dan disimpan.

## Yang TIDAK perlu dilakukan

- **Kunci seal tidak perlu diganti** kecuali ada tanda kunci privat cloud bocor. Edge tidak punya kunci privat, jadi pencurian edge tidak membocorkannya. Jika kunci diganti karena alasan lain, ikuti `docs/deployment.md` "Attendance selfie seal key".
- **Selfie tersegel tidak perlu dihapus** dari cloud atau dianggap bocor. Isinya tidak bisa dibaca pencuri.
- Tidak perlu mengganti password akun owner hanya karena edge dicuri, kecuali ada bukti akun cloud ikut terpapar.

## Terkait

- `deploy/edge/README.md` (host dan urutan setup edge)
- `docs/deployment.md` section "Edge host (outlet)"
- `docs/design/hris-edge-replication.md` section 2, 5, dan 7
