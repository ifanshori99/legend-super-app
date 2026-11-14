# Kerja: kontrak tamu reservasi (legend-z5ygw)

Worktree: `.worktrees/reservation-guest-contract`, cabang `ws/reservation-guest-contract`, dasar `ws/reservation-followups` 905891fa7 (staf approve/decline reschedule hidup di sana).

## Kontrak (disepakati, jangan ubah nama)
`guestReservationViewSchema` (`packages/shared/src/reservation/self-service.ts`, strictObject) mendapat:
- `timeZone: timeZoneSchema` (impor dari `../core/index.ts`; sumber `outlets.timezone`, kolom sudah ada). Dipakai UI untuk `reservedFor`, `requestedFor`, `freeUntil`.
- `rescheduleDecision: z.strictObject({ outcome: z.enum(["approved","declined"]), decidedAt: isoDateTimeSchema, requestedFor: isoDateTimeSchema, partySize: int|null }).nullable()` = permintaan terakhir yang sudah diputuskan untuk reservasi itu (resolvedAt terbaru), null bila belum ada. Terpisah dari `rescheduleRequest` (tetap hanya yang pending).
- Alasan penolakan dan jadwal lama BELUM ada kolomnya (alasan hanya di audit, jadwal lama hanya di envelope event): butuh migrasi dua kolom nullable di `reservation_reschedule_requests` (`previous_reserved_for`, `decision_reason`). DITUNDA menunggu nomor dari CTO; jangan dibuat sekarang.

## Guard terlambat saat tamu meminta
`requestGuestReschedule` (`apps/api/src/services/reservation-public.ts` ~819) memanggil `assertFreeCancellationWindowOpen(tx, context, row, now)` (`reservation-reschedule.ts:129`, kode `RESERVATION_RESCHEDULE_LATE`, 409) setelah cek validitas dan sebelum insert. Tidak ada request tersimpan saat ditolak; kunci idempotensi tidak boleh tertinggal sebagai klaim sukses (ikuti pola `rescheduleInvalid()` yang ada). Booking tanpa DP tidak kena guard (perilaku fungsi itu).

## Potongan (file tidak bertumpuk)
- A shared: `packages/shared/src/reservation/self-service.ts`, `tests/reservation-self-service-contract.test.mjs`.
- B api: `apps/api/src/services/reservation-public.ts` (`buildGuestView` ~522: pilih `outlets.timezone`, baca request resolved terakhir; `requestGuestReschedule`).
- T test: `apps/api/src/test/reservation-guest-contract.test.ts` baru. Pola setup: `reservation-public.test.ts`, `reservation-reschedule-staff.test.ts` (createApp, establishTenantContext, createReservation, setPaymentGateway, header `RESERVATION_LINK_TOKEN_HEADER`). Test: timeZone `Asia/Makassar` dan `Asia/Jayapura` di view, default `Asia/Jakarta`; `rescheduleDecision` null/approved/declined; guard terlambat saat tamu minta (DP lunas, dalam jendela gratis: 409 `RESERVATION_RESCHEDULE_LATE`, 0 baris request, booking tak berubah) dan di luar jendela tetap lolos.
- Test lama yang memeriksa view tamu (`reservation-public.test.ts` ~532, ~715) disesuaikan field baru oleh B.

Dilarang: mengubah layar web tamu, menyentuh `e2e/`, membuat migrasi.
