# Sub-brief 1094: akses perangkat bersama, sisa

Worktree: repo ini, cabang `ws/1094-akses-perangkat-bersama-sisa`, base a20420a6f. Tingkat K (akses + uang): bila ragu, pilih yang menolak.

Pola acuan: `apps/api/src/routes/open-bill.routes.ts` (resolveActingStaff + requireActingStaffOnSharedDevice + actorOf). Middleware: `apps/api/src/middleware/acting-staff.ts`. Keputusan CTO 18 Nov (1054): aksi uang di tablet bersama WAJIB PIN kasir; perangkat pribadi tidak berubah.

## Larangan sentuh
`apps/api/src/app.ts`, `apps/api/src/middleware/auth.ts`, `apps/api/src/test/device-shared-mode.test.ts` (kecuali kartu 4 / legend-iq0jz), `order-recovery-charge.routes.ts`. Hindari area refund, kas cek-kas, edge.

## Kartu
1. legend-13vhb: `apology-voucher.routes.ts` dan `delivery-orders.routes.ts` pasang `resolveActingStaff` + `requireActingStaffOnSharedDevice`, ganti `getAuth(req).user.id` ke `actorOf(req)`. Test uang tablet bersama: comp, collect-at-pos, waive, voucher maaf. Tanpa PIN kasir: 401/403. Dengan PIN: aktor = kasir.
2. legend-tlr6p: `service-request.routes.ts` (acknowledge/resolve/delete), `order-issues.routes.ts`, `expo.routes.ts` (helper actor ~baris 47), `menu.routes.ts` (handler availability status): `actorOf(req)` untuk aktor, izin, audit. `getAuth` tetap untuk MFA/support/self. Test: kasir outlet A tidak bisa collect charge outlet B.
3. legend-ypwsp: lintas tenant. Sesi bertanda perangkat bersama tenant A lalu dipakai ke tenant B harus ditolak atau tetap bertanda. Sudah tertutup: test pengunci. Belum: perbaiki (migrasi 0704-0705 hanya bila tak terhindar).
4. legend-iq0jz: port ulang allowlist layar tablet bersama (Q29: Reservasi + Tanya AI KDS buka, operasional + fasilitas tutup; default tolak) dari cabang lama `ghostex/8b2dc0b1` (e589b3476, REFERENSI SAJA, jangan merge) di atas desain guard 1027/1054 (desain base menang). Boleh sentuh `app.ts`, `middleware/auth.ts`, `device-shared-mode.test.ts`. Semua test `shared-device-*`/`acting-staff-*` + test 1043 hijau.

## Penamaan test
`acting-staff-w4-1094-*`, `shared-device-tenant-ypwsp`, test 1043: `shared-device-allowlist-1043`. Path `src/test/...` relatif ke `apps/api`.

## Peta Explore (dipakai implementer)
- Pola: open-bill.routes.ts:45-51 `staffGuard` = requireAuthAllowSharedDevice, requireTrustedOrigin, requireTenantContext, resolveActingStaff, requireActingStaffOnSharedDevice; aktor `actorOf(req)` (middleware/acting-staff.ts:187); izin lewat resolveOutletContext.
- apology-voucher.routes.ts: guard `base` :73, issue :93 (aktor penerbit), GET :111. delivery-orders.routes.ts: requireAuth :37, helper `userId` :54 dipakai :59-89 dan :136,:156,:179.
- service-request.routes.ts staffGuard sudah ada (:50); aktor di :128,:146,:189,:211 masih getAuth. order-issues.routes.ts guard lengkap; aktor :57 (+GET :73). expo.routes.ts helper actor() :47 getAuth (dipakai :82,:97). menu.routes.ts /availability guard :183-189; updateAvailability :833, setAvailabilityStatus :851.
- Daftar opt-in tablet bersama dikunci test `shared-device-router-decisions.test.ts`: HANYA implementer kartu 1 (A) yang mengedit berkas itu; lainnya lapor perubahan yang dibutuhkan.
- Kartu 3: sudah tertutup (`shared-device-marks.test.ts:307-330`), tanda per sesi lintas tenant. Tidak ada kerja kode; test-writer menambah test pengunci bila perlu.
- Kartu 4 titik pasang: setelah `refuseSharedDeviceSession`, di cabang `allowSharedDevice` di middleware/auth.ts, cek path/method vs allowlist, default tolak (403 SCREEN_CLOSED). Lama: lib/shared-device-allowlist.ts, middleware/shared-device-allowlist.ts, guard `/api/auth` app.ts (JANGAN duplikat `guardSharedDeviceAuthRoutes` dari shared-device-auth.ts base), tolak upgrade realtime (panic-relay-realtime.ts, notification-realtime.ts, server.ts), me.routes.ts `sharedDevice`, web shared-device-screens.ts + guard.ts + __root.tsx, test shared-device-allowlist.test.ts + web test. Reservasi dan Tanya AI KDS sudah opt-in di reservation.routes.ts/kds.routes.ts.

## Putaran 2 (temuan architect, keputusan: tolak bila ragu)
- delivery-orders TETAP tertutup di tablet bersama (403 SHARED_DEVICE_SCREEN_CLOSED, dicek sebelum PIN). Guard PIN + actorOf tetap sebagai lapisan cadangan. Test uang delivery bagian tablet bersama: harapkan 403 SCREEN_CLOSED (dengan dan tanpa PIN).
- Refund: hapus `refund` dari pola allowlist yang membukanya (lib/shared-device-allowlist.ts ~:587) dan sesuaikan test 1043. Refund di tablet = keputusan founder; default tolak.
- P2 outlet token: route tanpa `:outletId` (apology-voucher.routes.ts, service-request.routes.ts acknowledge/resolve/zone-waiter, menu.routes.ts `/availability/:id/status` + PATCH availability): bila `req.actingStaff` ada, outlet milik resource harus sama dengan `req.actingStaff.outletId`, bila beda 403 `OUTLET_MISMATCH` (pola pos-order-customer.routes.ts:54). Tanpa actingStaff (browser biasa): perilaku tidak berubah.
