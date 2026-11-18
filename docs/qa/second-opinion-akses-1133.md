# Second opinion akses ronde 2 — 1133

Tanggal: 19 November 2026. **Tidak ditemukan temuan baru P0–P3 yang konkret dalam pemeriksaan statis ini.** Tiga temuan ronde pertama tertutup pada jalur kode yang diperiksa; hasil ini bukan pernyataan bahwa test regresi telah lulus.

## Rentang dan metode

- `git fetch origin` selesai sebelum referensi dibekukan.
- Base ronde pertama: `4f5e3cc08386a7fe837c0c18b35b98513cc1785e`.
- Head `origin/ws/1128-door-check-outlet-token`: `1fa7fddea0dcef89c1347462ef7b7bf351fbede2`.
- Base konteks penuh `origin/milestone/m1`: `e2a63062e0630f8078291038198e49fe79e1aacc`.
- Delta diperiksa dengan `git diff 4f5e3cc08..1fa7fddea`; konteks memakai `git diff e2a63062e...1fa7fddea`, keduanya mengecualikan `':!**/meta/*snapshot.json'`.
- Tiga subagent Codex berjalan paralel: perbaikan 1113; akses order-recovery 1120; door-check 1128 dan bypass URL/metode. Hasil digabung dan perubahan inti ditelusuri ulang pada objek Git.
- Nomor baris kode merujuk head di atas. Checkout utama tetap di `ux/customer-order-benchmark`; tidak membuat worktree, checkout, commit, push, atau perubahan kode. Berkas laporan ini satu-satunya berkas yang ditulis untuk tugas ini. Pengelolaan kartu tetap pada CTO.
- Kasus yang diterima CTO dalam brief 1133 tidak dihitung ulang sebagai temuan. UI dan snapshot migrasi tidak diperiksa.

## Penutupan temuan ronde pertama — 1113

| Temuan lama                                        | Bukti pada head yang diperiksa                                                                                                                                                         | Kesimpulan statis                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| P1 pembuatan isu dapat mencatat refund manual      | `apps/api/src/routes/order-issues.routes.ts:63` menolak resolusi non-null ketika ada acting staff atau penanda sesi perangkat bersama, sebelum pemanggilan service                     | Jalur refund manual, voucher, dan swap tertutup; laporan tanpa resolusi tetap tersedia    |
| P2 availability melampaui outlet token             | `apps/api/src/routes/menu.routes.ts:873` menolak query outlet lain, lalu memaksa query ke outlet token sebelum service                                                                 | Pembacaan dan expiry sweep dibatasi ke outlet token, termasuk request tanpa filter outlet |
| P2 socket panic bertahan setelah shared mode aktif | `apps/api/src/services/panic-receiver-session.ts:273` menolak perangkat shared pada recheck; `apps/api/src/services/device.service.ts:656` mencabut sesi receiver saat flag diaktifkan | Socket lama dicabut; pemeriksaan sebelum pengiriman berikutnya juga membaca shared mode   |

Test terkait telah dibaca, tidak dijalankan: `acting-staff-w4-1113-order-issues.test.ts`, `acting-staff-w4-1113-availability.test.ts`, dan `acting-staff-w4-1113-panic-socket.test.ts` di `apps/api/src/test/`. Isinya mencakup penolakan resolusi uang, laporan biasa, batas outlet beserta sweep, socket lama, perubahan flag melalui SQL, dan penolakan upgrade baru.

## Batas outlet dan penutupan jalur uang — 1120

- Tujuh route memiliki pemeriksaan outlet target: laporan item dan resolve di `apps/api/src/routes/order-recovery.routes.ts:58`; waive, expire, refund, dan manual-refund melalui `apps/api/src/routes/order-recovery-charge.routes.ts:52`; collect-at-pos memasang helper tersendiri pada baris 241.
- `apps/api/src/middleware/acting-staff-outlet.ts:22`, `:41`, dan `:57` membaca outlet charge/item/issue dengan filter tenant dari server. `apps/api/src/middleware/acting-staff.ts:191` menolak hasil null atau outlet berbeda sebelum permission guard dan service. Token outlet A tidak memperoleh jalur ke target B atau tenant lain melalui helper ini.
- Actor handler berasal dari `actorOf(req)`, bukan user ID pada body. Resolver token dan pemeriksaan outlet mendahului izin aktor; body strict tetap berlaku. Tidak ditemukan skenario pemalsuan actor konkret pada jalur yang diperiksa.
- `POST /api/apology-vouchers` serta waive/expire terdapat dalam DENY pada `apps/api/src/lib/shared-device-allowlist.ts:44` dan `:49`; DENY diperiksa sebelum wildcard pada baris 188. Refund/manual-refund charge tidak masuk allowlist. Approve/reject refund memakai `requireAuth` biasa sehingga sesi tablet bersama tertolak.
- Endpoint guest order-recovery memakai kredensial sesi tamu terpisah; token kasir saja tidak memberi akses ke endpoint tersebut.

Test `apps/api/src/test/acting-staff-1120-order-recovery-outlet.test.ts` memuat matriks tujuh route untuk target outlet lain dan target tidak dikenal, termasuk varian perangkat tidak shared yang menuntut `ACTING_STAFF_OUTLET_MISMATCH`. Test `acting-staff-1120-apology-shared-device.test.ts` memeriksa penolakan dengan/tanpa token dan dengan/tanpa issue, tanpa voucher baru atau penyelesaian issue. Keduanya hanya dibaca. Sebagian kontrol login pribadi dalam matriks hanya memastikan galat bukan `OUTLET_MISMATCH`; keberhasilan bisnis lengkap login pribadi tidak dibuktikan oleh assertion tersebut.

## Door-check dan enumerasi — 1128

- `apps/api/src/routes/facility-pos-ticket.routes.ts:200` meneruskan outlet acting staff ke service. `apps/api/src/services/facility-door-check.ts:148` mencari kredensial dalam tenant, mengunci tiket, lalu memeriksa ulang digest sebelum perbandingan outlet pada baris 199. Perbandingan berjalan sebelum perubahan status tiket.
- Tiket/QR tidak dikenal dan PIN yang tidak cocok tetap menghasilkan `DOOR_CREDENTIAL_INVALID`. Kredensial asli yang cocok untuk outlet lain menghasilkan `ACTING_STAFF_OUTLET_MISMATCH`, sesuai pengecualian yang diterima CTO; perbedaan tersebut tidak dihitung sebagai temuan enumerasi baru.
- `apps/api/src/services/facility-door-check.ts:92` memesan slot percobaan sebelum pemeriksaan. Cabang catch pada baris 115 mempertahankan slot untuk PIN salah serta PIN cocok yang ditolak karena outlet berbeda, sehingga penolakan outlet tidak menghindari `DOOR_PIN_LOCKED`.
- `/api/facility/tickets/door-check` tidak masuk allowlist perangkat bersama. Varian shared mode ditolak sebelum handler/service. Tidak ditemukan alias door-check pada router yang diperiksa.
- Test `apps/api/src/test/acting-staff-1128-facility-ticket-outlet.test.ts` dibaca sebagai bukti cakupan skenario, bukan bukti eksekusi lulus.

## Pemeriksaan bypass dan batas kebijakan

- Tidak ditemukan jalur refund/paid void baru yang konkret melalui alias route, metode lain, prefix, satu trailing slash, case, encoding, HEAD/OPTIONS, atau wildcard POS dalam penelusuran statis ini. Normalisasi menghapus query dan satu trailing slash; encoded slash/dot/backslash serta dot segment ditolak. Handler refund literal tidak memperoleh alias hanya dengan encoding huruf pada segmen statis. Perilaku router HTTP tersebut belum diuji langsung.
- `cash_out`/`cash_drop` tetap tersedia lewat wildcard POS. Ini operasi Shift Kasir yang disebut eksplisit dalam `docs/PRD.md:641`, bukan alias refund. `apps/api/src/routes/pos-shift.routes.ts:245` memakai acting staff, `actorOf`, dan `shift.cash.operate`; `apps/api/src/services/pos-shift.service.ts:550` mengulang izin dan mensyaratkan pemilik shift. Outflow melebihi kas fisik ditahan pada baris 629; movement/event/audit dicatat pada baris 646. Approval transaksi tertahan memiliki izin dan pemeriksaan kas sendiri. Tidak ditemukan dasar kebijakan yang menutup seluruh operasi kas shift di tablet bersama.
- Kandidat void biasa yang mengembalikan poin tidak dihitung sebagai bypass refund pesanan selesai: `apps/api/src/services/pos-order.service.ts:1671` memeriksa expected status dan `assertMutable` sebelum cabang points-only. `apps/api/src/services/pos-order-support.ts:583` menolak `completed`/`voided`; state machine `packages/shared/src/pos/schemas.ts:239` juga tidak memberi transisi keluar dari completed. Pengembalian poin pada pembatalan tagihan nonfinal merupakan keputusan eksplisit `docs/briefs/1048-so-fixes.md:18`. Test kontrol `apps/api/src/test/pos-936-so-refund.test.ts:1346` menyelesaikan pesanan dahulu, lalu memeriksa void ditolak dan poin tetap terpakai; test hanya dibaca.
- Tidak ditemukan skenario kebocoran data pribadi atau akses lintas tenant baru yang konkret pada jalur dalam scope ini. Kesimpulan tidak mencakup seluruh aplikasi.

## Verifikasi dan keterbatasan

- Audit dilakukan melalui `git show`/`git diff` pada head beku, pembacaan test, serta pemeriksaan silang tiga subagent. Tidak menjalankan setup, layanan, migrasi, atau instalasi dependency proyek untuk tugas read-only ini.
- Test HTTP, Express router, PostgreSQL, WebSocket, build, typecheck, dan suite regresi **tidak dijalankan**. Dependency checkout utama tidak tersedia; `require.resolve('express', { paths: ['./apps/api'] })` gagal `MODULE_NOT_FOUND`. Checkout juga berbeda dari target audit.
- Job pemeriksaan tambahan `heavy node --input-type=module` dibatalkan ketika masih antre, sebelum assertion berjalan; exit 143. Repro tambahan subagent juga dibatalkan sebelum berjalan. Tidak ada job audit yang ditinggalkan berjalan.
- Usul test tambahan, bukan temuan P0–P3: shared mode + token kasir sah + QR/PIN sah harus tetap `403 SHARED_DEVICE_SCREEN_CLOSED` tanpa perubahan tiket/audit; PIN salah pada tiket outlet lain maupun tenant lain harus mempertahankan galat kredensial seragam.
- `pnpm exec prettier --check docs/qa/second-opinion-akses-1133.md` dan `pnpm exec eslint docs/qa/second-opinion-akses-1133.md` tidak dapat berjalan karena binary lokal tidak tersedia (`MODULE_NOT_FOUND`). ESLint belum terverifikasi.
- Format laporan diperbaiki dengan `pnpm dlx prettier@3.9.6 --write docs/qa/second-opinion-akses-1133.md`, lalu pemeriksaan `pnpm dlx prettier@3.9.6 --check docs/qa/second-opinion-akses-1133.md` lulus. Versi mengikuti `package.json`. Dependency proyek tidak dipasang.
