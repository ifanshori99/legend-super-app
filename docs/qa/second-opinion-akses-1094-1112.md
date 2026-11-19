# Second opinion akses perangkat bersama — 1094 / brief 1112

Tanggal: 19 November 2026. Hasil: **1 P1 dan 2 P2**; tidak ada temuan P0 atau P3.

## Rentang dan cara pemeriksaan

- `git fetch origin` selesai sebelum rentang dibekukan.
- Base `origin/milestone/m1`: `4418628e0dd002d2fb5af07a6bc15f74390af162`.
- Head `origin/ws/1094-akses-perangkat-bersama-sisa`: `4f5e3cc08386a7fe837c0c18b35b98513cc1785e`.
- Diff diperiksa dengan pengecualian `':!**/meta/*snapshot.json'`. Semua nomor baris di bawah merujuk head tersebut, bukan checkout utama.
- Tiga subagent paralel memeriksa allowlist/realtime, identitas staf/batas outlet, dan jalur operasional/refund. Temuan digabung, ditelusuri ulang pada objek Git, dan kandidat refund divalidasi silang.
- Pemeriksaan kode bersifat read-only melalui `git diff`/`git show`, tanpa checkout atau worktree. Berkas ini adalah satu-satunya berkas yang ditulis untuk tugas ini. Kasus yang telah diterima CTO dalam brief tidak dihitung sebagai temuan.
- Test HTTP, PostgreSQL, WebSocket, build, dan suite regresi tidak dijalankan. Skenario di bawah dibuktikan melalui penelusuran kode; usul test belum dieksekusi.
- Format laporan diperiksa dengan `pnpm dlx prettier@3.9.6 --check docs/qa/second-opinion-akses-1094-1112.md` dan lulus. Versi mengikuti `package.json`; binary lokal untuk `pnpm exec prettier` tidak tersedia.

## P1 — Pembuatan isu pesanan masih membuka pencatatan refund manual

**Lokasi:** `apps/api/src/routes/order-issues.routes.ts:49`, terutama penerusan body pada baris 54–64; allowlist `apps/api/src/lib/shared-device-allowlist.ts:79`.

**Masalah:** Penutupan `manual_refund` hanya diterapkan pada jalur resolve. Jalur `POST /api/outlets/:outletId/orders/:orderId/issues` tetap diizinkan di tablet bersama dan menerima body dengan `resolution: "manual_refund"`. Tidak ada pemeriksaan `SHARED_DEVICE_SCREEN_CLOSED` sebelum service menjalankan operasi tersebut.

**Skenario gagal:** Tablet bersama mengirim token staf aktif yang memiliki `kds.remake_comp.record` untuk outlet yang sama. Gunakan item POS lunas, belum void, tanpa tiket atau kompensasi aktif, serta override refund sah untuk staf, item, dan nominal tepat. Override dapat memakai `supervisor_phone` yang telah disetujui supervisor lain: `/api/pos-overrides` tetap diizinkan, dan pemeriksaan metode ponsel tidak mensyaratkan device binding (`apps/api/src/services/device-pin-support.ts:257`). Approval harus masih berlaku dan belum dipakai. Kirim body laporan valid dengan resolusi refund manual ke endpoint pembuatan isu tersebut.

**Bukti dan dampak:** `apps/api/src/services/order-issues.service.ts:561` menerima resolusi ini, mengonsumsi approval pada baris 602–611, lalu menyimpan `resolution: "manual_refund"` dan `status: "resolved"` pada baris 639–648. Tablet dapat mencatat refund manual selesai dan menghabiskan approval walaupun kebijakan menutup refund di tablet. Jalur ini **tidak membuktikan transfer provider atau penerbitan jurnal refund**. Override PIN yang dibuat pada tablet sendiri bukan contoh yang valid karena consumer mengirim `deviceId: null`; skenario ponsel di atas menghindari hambatan tersebut tanpa memalsukan approval.

**Perbaikan:** Tolak resolusi `manual_refund` dari perangkat/sesi bersama pada endpoint pembuatan isu, memakai aturan yang sama dengan endpoint resolve. Jalankan penolakan sebelum konsumsi approval dan penulisan isu; pertahankan laporan isu biasa.

**Usul test:** Tablet bersama + token sah + override ponsel disetujui + body refund valid harus menghasilkan `403 SHARED_DEVICE_SCREEN_CLOSED`, tanpa penambahan `order_issues` atau `pos_order_approval_uses`. Kontrol laporan non-refund di tablet tetap berhasil; refund manual dari perangkat pribadi dengan izin dan approval yang sama tetap mengikuti alur normal.

## P2 — GET availability tidak membatasi outlet sesuai token kasir

**Lokasi:** `apps/api/src/routes/menu.routes.ts:867`.

**Masalah:** Handler `GET /api/menu/availability` memakai `actorOf(req)`, tetapi meneruskan query dan seluruh jangkauan izin aktor tanpa mempersempitnya ke `req.actingStaff.outletId`. URL ini tidak mempunyai parameter `:outletId`, sehingga resolver token tidak dapat membandingkan outlet tujuan. Pemeriksaan outlet record yang baru ditambahkan hanya digunakan pada mutasi availability.

**Skenario gagal:** Staf memiliki izin `menu.item.view` di outlet A dan B, lalu memperoleh token kasir untuk tablet outlet A. Dengan token itu, panggil `GET /api/menu/availability?outletId=B`. `requireMenuPermission` mempertahankan jangkauan A+B (`apps/api/src/middleware/permissions.ts:177`), kemudian service mengizinkan B sesuai izin staf, meskipun token hanya sah untuk A. Tanpa filter outlet, daftar juga dapat mencakup B.

**Bukti dan dampak:** `apps/api/src/services/menu-pricing.service.ts:922` menentukan scope dari context/query, memeriksa izin normal pada baris 923–941, lalu membaca record scope itu pada baris 961–968. Sebelum membaca, baris 946–950 juga memanggil `restoreExpiredSoldOut` untuk scope tersebut. Tablet A dapat membaca availability B dan memicu pemulihan availability kedaluwarsa beserta event B. Ini bypass batas outlet token dalam tenant yang sama; bukan bukti bypass izin staf atau akses lintas tenant.

**Perbaikan:** Untuk request bertoken, tolak `query.outletId` yang berbeda dengan outlet token dan persempit context/query ke outlet token, termasuk ketika parameter outlet tidak dikirim. Pertahankan jangkauan izin normal pada perangkat pribadi tanpa token.

**Usul test:** Staf berizin A+B dengan token A meminta B harus memperoleh `403 ACTING_STAFF_OUTLET_MISMATCH`; request tanpa filter hanya mengembalikan A. Siapkan record `sold_out` kedaluwarsa di B dan pastikan request bertoken A tidak mengubahnya atau menambah event B. Kontrol perangkat pribadi tanpa token tetap dapat membaca outlet sesuai izinnya.

## P2 — Socket panic lama lolos setelah shared mode diaktifkan

**Lokasi:** `apps/api/src/edge/panic-relay-realtime.ts:146`.

**Masalah:** Pemeriksaan shared-device baru hanya berjalan saat upgrade WebSocket. Perubahan perangkat dari pribadi ke bersama tidak menutup socket yang sudah terautentikasi, dan pemeriksaan ulang sesi receiver tidak memeriksa `sharedMode`.

**Skenario gagal:** POS dengan `sharedMode: false` membuka receiver WebSocket memakai sesi receiver sah. Admin kemudian mengaktifkan `sharedMode: true` pada perangkat yang sama. Biarkan sesi receiver tetap berlaku dan kirim alert panic berikutnya. Socket lama tetap menerima frame walaupun koneksi baru perangkat itu ditolak oleh aturan penutupan fasilitas Q29.

**Bukti dan dampak:** `apps/api/src/services/device.service.ts:617` memperbarui flag, tetapi cleanup baris 641–648 hanya berjalan saat mode dimatikan. `apps/api/src/services/panic-receiver-session.ts:244` membaca status, pencabutan, jenis, dan generasi token perangkat tanpa flag shared mode; `recheckReceiverSession` mengembalikan sukses pada baris 380 selama syarat lain tetap sah. Timer socket memakai recheck tersebut (`apps/api/src/edge/panic-relay-realtime.ts:258`), begitu pula pengecekan sebelum `sub.send(frame)` (`apps/api/src/services/panic-relay.service.ts:522`, `:580`). Akibatnya, stream fasilitas tetap terbuka di tablet bersama selama sesi receiver masih sah. Temuan ini tidak mengasumsikan kebocoran data tamu.

**Perbaikan:** Periksa shared mode perangkat pada recheck sesi receiver yang dipakai sebelum setiap pengiriman; tutup socket ketika perangkat menjadi bersama. Penutupan aktif saat flag diubah dapat melengkapi pemeriksaan tersebut.

**Usul test:** Buka socket ketika perangkat pribadi, aktifkan shared mode, jalankan recheck dan fan-out alert baru. Socket harus ditutup dan tidak menerima frame alert/resend berikutnya. Pertahankan kontrol perangkat pribadi, penolakan shared-device pada upgrade baru, serta expiry/pencabutan sesi normal.

## Pemeriksaan lain

- Tidak ditemukan bypass URL/metode konkret pada DENY corrections/refund dan corrections/void melalui case, trailing slash, encoding, prefix, atau HEAD/OPTIONS dalam pemeriksaan statis ini.
- Tidak ditemukan temuan baru yang konkret pada pemalsuan actor/token, voucher maaf, delivery-orders, service-request, expo, serta batas pembatalan reservasi/DP yang diperiksa. Delivery-orders tetap tertutup oleh default allowlist, sehingga kandidat pembatalan delivery tidak dilaporkan sebagai bypass.
- Hasil ini tidak menyatakan test regresi lulus. Tiga skenario temuan memerlukan test terarah saat perbaikan dibuat.
