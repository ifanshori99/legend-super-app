# Sub-brief 1177: tablet bersama reservasi aktor + flake + perf i18n

Cabang: `ws/1177-tablet-reservasi-aktor` (base milestone/m1 d99aae067). Tanpa migrasi.

## Area A (satu implementer, berkas sama, berurutan 5f6is lalu jvaqa)
- legend-5f6is: `apps/api/src/routes/reservation.routes.ts` (~163, 180, 199, 220, 328) dan `assertPermission` di `reservation-booking.ts` (~741) memakai `getAuth(req).user.id` (pemilik sesi), harus `actorOf(req)` (kasir ber-PIN di tablet bersama).
  - Test: di tablet bersama audit/aktor = kasir; kasir tanpa `reservation.manage` ditolak walau pemilik sesi punya; perangkat biasa tidak berubah.
- legend-jvaqa: rute seat + PATCH tables reservasi dibuka di tablet bersama via `requireAuthAllowSharedDevice` + `requireActingStaffOnSharedDevice` (aktor = kasir).
  - Test: tanpa PIN kasir 403 seragam; dengan PIN sukses dan aktor = kasir.
- Pola acuan: cari `actorOf`, `requireAuthAllowSharedDevice`, `requireActingStaffOnSharedDevice` di `apps/api/src` (rute tablet bersama lain, test 1094/i0ipj).
- JANGAN sentuh: payment-webhook*, order-given.ts, reservation-core.ts, reservation-deposit*, facility-slots*, edge-*, access.service.ts, platform-approval.service.ts, pos-receipt*.

## Area B (legend-v1l1f)
Flake `hris-overtime-collective-db` QUOTA_EXCEEDED di suite penuh: tiap test pakai tenant/kuota kursi sendiri. Bukti: berkas itu + satu berkas hris lain bersamaan 3x hijau.

## Area C (legend-0rzwb)
Perf web i18n: pecah namespace core per key (label `apps/web/src/features/*/nav.ts`), core ~374 KB -> ~155 KB. Catat ukuran sebelum/sesudah. Text-contract (`node --test tests/text-contract.test.mjs`) hijau.

## Invarian
- Aktor di tablet bersama = kasir ber-PIN, tidak pernah pemilik sesi. Tidak ada eskalasi akses: kasir tanpa izin tetap ditolak.
- Jangan mengubah test `e2e/acceptance/`.
- Satu token heavy per thread.
