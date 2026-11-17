# Second opinion akses ronde 2 — perangkat bersama

Tanggal: 17 November 2026. Brief 1023, rantai 1006 + 1012 + 1017 + 1018 + 1021. Hasil: **1 P1 dan 2 P2**; tidak ada P0/P3 tambahan yang terbukti. P1 masih menghalangi gerbang rilis area akses.

## Cakupan dan ref

Pemeriksaan mengikuti diff yang diminta:

```sh
git diff origin/ghostex/984-f586w-shared-device-wip...origin/ghostex/4b06e171 -- . ':!**/meta/*snapshot.json'
```

Baseline dan merge-base: `8395006964021cc46c12b1fe3a7dc465a2f17753`. Ref bernama `origin/ghostex/4b06e171` saat diperiksa menunjuk **`0069c8c59889670d527ed5bc61343136d2c5948f`**, commit fitur KDS 1021. Seluruh nomor baris di bawah merujuk isi SHA tersebut, bukan checkout utama. Diff mencakup 65 berkas, 6.496 penambahan dan 164 penghapusan.

Ronde 1 dibaca dari `docs/qa/second-opinion-akses.md`; keputusan CTO dalam brief diperlakukan sebagai batas review. Pemeriksaan dibagi ke tiga subagent read-only, puncak tiga bersamaan, lalu temuan dicocokkan kembali dengan sumber. Tidak checkout, membuat worktree, mengubah kode, commit, atau push. Hanya laporan ini yang ditulis di folder utama.

## Temuan

- **P1 — Perangkat yang dicabut dapat tersambung kembali sebagai owner:** `apps/api/src/services/kds-realtime-auth.ts:164`; pemeriksaan registry dan token kasir hanya berjalan ketika `anySharedDeviceActive(marks)` masih true. **Skenario:** Owner memiliki izin KDS di outlet A dan B; kasir hanya A, memakai sesi owner pada satu perangkat shared A. Admin mencabut perangkat itu. Pencabutan tidak menutup sesi login (`apps/api/src/services/device.service.ts:476`), sedangkan seluruh shared marks kini dianggap tidak aktif. Resolver melewati `registeredDeviceIdOfHeaders` dan `resolveActingStaffToken`, lalu memakai `session.user.id` meskipun token perangkat/kasir lama masih dikirim. Socket lama cook→owner ditutup 1008 oleh pemeriksaan identitas (`apps/api/src/services/kds-realtime.ts:195`, `:217`), tetapi retry otomatis klien (`apps/web/src/features/ws04-kds/kds-realtime.ts:254`) diterima sebagai owner. Upgrade baru ke station B juga tidak lagi dibatasi outlet token kasir A apabila owner berizin B. **Perbaikan:** Tolak token perangkat yang dikirim tetapi tidak diterima registry, terlepas dari shared marks; resolve dan batasi identitas setiap token kasir yang dikirim, juga pada perangkat pribadi. **Usul test:** Real socket dengan owner A+B, kasir A, satu shared mark; cabut perangkat ketika socket terbuka, lalu pastikan koneksi lama tertutup dan reconnect dengan header maupun subprotocol lama tetap ditolak, termasuk ke station B. Sertakan kontrol perangkat pribadi tanpa token serta token kasir kedaluwarsa/dicabut pada perangkat unflagged; identitas tidak boleh beralih ke owner.
- **P2 — Penolakan perangkat kesembilan lewat WebSocket menyisakan cookie yang dapat lolos kemudian:** `apps/api/src/services/kds-realtime-auth.ts:153`; `markSessionSharedDevice` yang mengembalikan false hanya diikuti `return null` pada `:158`, tanpa penutupan sesi melalui `sharedDeviceMarkLimit` seperti jalur HTTP. **Skenario:** Sesi owner sudah memiliki delapan shared marks aktif. Lakukan upgrade langsung dari perangkat shared kesembilan dengan cookie tersebut dan token perangkat kesembilan, tanpa roundtrip HTTP/PIN sebelumnya. Upgrade ditolak, tetapi sesi tetap hidup dan perangkat kesembilan tidak tercatat. Admin lain kemudian menonaktifkan atau mencabut delapan perangkat lama, sementara perangkat kesembilan tetap shared/aktif. Cookie lama dari perangkat kesembilan kini lolos tanpa header sebagai owner pada socket maupun route back office karena semua marks tersimpan telah lapse. **Perbaikan:** Tutup sesi dengan jalur audit yang sama dengan HTTP sebelum menolak upgrade karena batas marks. **Usul test:** Isi delapan marks aktif, tolak upgrade langsung perangkat kesembilan, lapse delapan lama dari sesi admin lain, lalu buktikan cookie lama tetap ditolak pada websocket dan HTTP back office. Regresi ini memeriksa penutupan sesi yang tertinggal; keputusan menolak perangkat kesembilan tetap dipertahankan.
- **P2 — Tablet bersama dapat menghapus langganan alarm ponsel pribadi owner tanpa PIN:** `apps/api/src/routes/notification.routes.ts:155`; pengecualian `removePush` memakai `requireAuthAllowSharedDevice`, tetapi caller sesi/perangkat hanya diisi untuk `registerPush` pada `:135`. Penghapusan di `apps/api/src/services/notification-center.ts:555` hanya memfilter `user_id` dan ID langganan, tanpa ikatan ke sesi/perangkat peminta. **Skenario:** Cookie owner bertanda shared, tanpa token kasir, mengambil ID ponsel owner melalui GET `/api/identity/push-devices` yang juga diizinkan pada tablet (`apps/api/src/routes/identity-push-devices.routes.ts:47`), lalu DELETE `/api/notifications/push-subscriptions/<id-ponsel>` pada tenant ponsel itu. Owner berassignment aktif lolos port produksi (`apps/api/src/services/notification-push-ports.ts:30`, `:46`), dan langganan alarm ponselnya terhapus. Endpoint pencabutan `/api/identity/push-devices/:id` justru memakai guard ketat, sehingga jalur notifikasi ini melewati pembatas tersebut. Kontrak router tetap lolos karena berkas `notification` berstatus shell tanpa pemeriksaan target penghapusan. **Perbaikan:** Batasi pengecualian sign-out pada langganan milik sesi/perangkat saat ini; pencabutan perangkat lain memerlukan sesi pribadi. **Usul test:** Dua sesi owner dengan langganan ponsel P dan tablet T; DELETE P dari cookie shared tanpa PIN wajib ditolak dan P tetap ada, sedangkan DELETE T saat sign-out tetap berhasil. Ulangi dengan ID langganan di tenant lain yang juga dimiliki owner.

## Bukti verifikasi

Fungsi `resolveKdsStaffConnection` asli dari `git show 0069c8c59889670d527ed5bc61343136d2c5948f:apps/api/src/services/kds-realtime-auth.ts` dieksekusi melalui `heavy node --input-type=module`. Tipe TypeScript dibuang dengan `node:module.stripTypeScriptTypes`; dependency auth, registry, penanda perangkat dan permission diganti stub di memori. Tidak ada berkas harness, server, atau database yang dibuat.

| Kasus                     | Kondisi yang disediakan stub                                                                                                                   | Hasil eksekusi kode resolver asli                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Perangkat dicabut         | Cookie owner tetap valid; awalnya perangkat shared aktif dan PIN menjadi cook; sesudah revoke perangkat tidak aktif dan registry akan menolaknya | `beforeUser=cook`, `afterUser=owner`, `registryChecks=0`, `tokenChecks=0` sesudah revoke       |
| Batas delapan shared marks | Delapan marks lama aktif; perangkat kesembilan shared aktif dan pencatatan ditolak; lalu hanya perangkat kesembilan yang tetap aktif              | `ninthDenied=true`, `marksContainD9=false`, `headerlessReplayUser=owner`                       |

Kedua hasil membuktikan cabang resolver yang gagal, bukan keberhasilan eksploitasi end to end. Alur penutupan 1008, retry klien, pencabutan perangkat, serta notifikasi sampai SQL diperiksa dari sumber pada SHA yang sama. `git diff --check` atas rentang review juga dijalankan tanpa temuan whitespace.

## Hasil pemeriksaan lainnya

- Tidak ditemukan bypass tambahan yang terbukti pada SSR/server function yang ditelusuri: pembacaan sesi web tidak memberikan akses query/service langsung, dan permintaan data tetap melalui guard API. Upload dan ekspor yang ditelusuri tetap memakai `requireAuth`.
- Guard `/api/auth` berada sebelum router identitas dan Better Auth; penerbitan sesi berheader perangkat menstempel shared marks. Tidak ditemukan bypass tambahan yang terbukti di area itu atau regresi tambahan pada auth perangkat pribadi.
- Customer-display preview yang ditelusuri memeriksa tenant, outlet, status terminal, dan kecocokan terminal dengan kredensial. Tidak ditemukan kebocoran tambahan yang terbukti pada jalur tersebut.
- Carrier websocket yang diperiksa tidak memasukkan token ke URL dan hanya memilih `legend-kds.v1` untuk subprotocol respons. Header perangkat, kasir, dan subprotocol tercakup redaksi logger. Tidak ditemukan kebocoran token tambahan yang terbukti pada log/error yang ditelusuri.

## Batas bukti dan gerbang

Request HTTP, real websocket dengan database, PostgreSQL/RLS, test integrasi proyek, build, dan gate penuh **tidak dijalankan** pada review ini. Checkout utama berbeda dari SHA yang direview dan tidak dipindahkan. Bukti executable terbatas pada resolver asli dengan stub; temuan notifikasi dibuktikan melalui penelusuran router, port produksi, dan SQL.

`pnpm exec prettier --check docs/qa/second-opinion-akses-ronde2.md` dicoba, tetapi gagal sebelum memformat karena `node_modules/prettier/bin/prettier.cjs` tidak tersedia (`MODULE_NOT_FOUND`). Tidak memasang dependensi atau mengubah berkas lain untuk memperbaiki lingkungan review.

Rekomendasi: tahan gerbang rilis area akses sampai P1 diperbaiki dan regresi pencabutan perangkat/reconnect dibuktikan pada real socket. Tutup pula kedua P2 beserta test targetnya agar penolakan perangkat kesembilan dan pengecualian sign-out tidak menyisakan akses owner pada tablet.
