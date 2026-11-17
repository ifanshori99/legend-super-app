# 1006 perbaikan SO 997 akses (sq1ux, 42gqp, dn7uo)

Sumber temuan: /Users/ifanshori99/Projects/legend super app/legend/docs/qa/second-opinion-akses.md (P1 #1, P1 #2, P2). Base 839500696. API di apps/api. Tanpa migrasi.

## sq1ux (P1) sign-in perangkat bersama

- Sign-in Better Auth (app.ts:387 `/api/auth/*splat`) tidak lewat requireAuth, jadi stempel (`stampSharedDeviceFromToken`, auth.ts:27) belum jalan; sesi baru punya `shared_device_ids=[]` dan cookie-nya lolos di POS tanpa header.
- Desain: service `sharedDeviceIdsFromToken(raw): Promise<string[]>` (verifyDeviceToken + anySharedDeviceActive, tidak pernah throw, `[]` bila tak valid/tak aktif/tak shared). Di `databaseHooks.session.create.before` (lib/auth.ts ~553, ctx?.headers?.get(DEVICE_TOKEN_HEADER)) sertakan `sharedDeviceIds` di `data` (kedua cabang return, termasuk impersonasi bila relevan). Cek field `sharedDeviceIds` (auth.ts ~785) boleh ditulis dari hook. Web: `authClient` (apps/web/src/lib/auth-client.ts) mengirim `X-Device-Token` lewat `fetchOptions.onRequest`; tanpa itu hook tak pernah melihat token.
- Stempel di requireAuth tetap (perangkat yang ditandai sesudah login).

## 42gqp (P1) alias denah

- `outletFloorRouter` (floor.routes.ts ~202) pasang `resolveActingStaff` + `requireActingStaffOnSharedDevice` seperti `floorRouter` (~81).
- Guard dipasang di rute GET `/:outletId/floor` saja, bukan `.use` router: router ini berbagi prefix `/outlets` dengan router lain, dan guard tingkat router ikut jalan untuk request yang jatuh lewat tanpa `:outletId`. Web: `POS_PATH` (apps/web/src/lib/api/acting-staff.ts) ikut `outlets/:id/floor`, kalau tidak papan di perangkat bersama selalu 401.
- Periksa router alias/outlet lain dengan pola sama (handler POS/denah/meja yang dijaga di router lain tapi tidak di alias); tutup yang terbukti, sebut sisanya di laporan.

## dn7uo (P2) batas 8 penanda

- Keputusan: TOLAK (membatasi akses, tanpa migrasi). `markSessionSharedDevice` mengembalikan boolean: true bila sudah/sekarang terpasang, false bila daftar penuh 8 dan semuanya aktif (tidak ada yang bisa digusur; gusur yang aktif membuka serangan banjir yang diuji di shared-device-marks.test.ts ~463). Pemanggil (stempel requireAuth, guard acting-staff.ts ~127-141, hook sign-in) yang menerima false menolak permintaan perangkat itu dengan 403 (kode `SHARED_DEVICE_MARK_LIMIT`), tidak lanjut sebagai owner. Perangkat ke-9 tetap terlindungi karena permintaannya ditolak; sesi tak pernah bisa dipakai di perangkat bersama ke-9 tanpa tercatat.
- Tes lama shared-device-marks.test.ts ~364 ("9th NOT added, header-less refused") diubah ke perilaku baru.
- Tambahan setelah review architect: perangkat ke-9 yang ditolak MENUTUP sesinya (hapus baris `session`, `closeSessionAtMarkLimit` di shared-device.service.ts). Tanpa itu, begitu perangkat 1-8 dimatikan admin, cookie di perangkat ke-9 lolos tanpa header sebagai owner. Pengguna masuk lagi di perangkat ke-9; sesi baru distempel saat sign-in (sq1ux).
- Self-disable (device.routes.ts ~200-225) tidak berubah: perangkat ke-9 tidak pernah tercatat, jadi tak ada celah header-less.

## Berkas tes

- src/test/acting-staff-shared-device.test.ts, shared-device-marks.test.ts, acting-staff-w2-floor.test.ts, floor-api.test.ts, device-shared-mode.test.ts
