# Brief 146: second-opinion — kas keluar tidak membocorkan isi laci (legend-67dt)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-drawer-guess`, cabang `ws/pos-drawer-guess`.
Rentang diff: `git diff a4e12810 7b145cc9` (`a4e12810` = merge `milestone/m1` ke cabang ini; isi cabang saja). Abaikan `apps/api/drizzle/meta/*`. Sekitar 240 baris non-test, satu run cukup.

## Perubahan (ringkas)
Kas keluar/setoran yang lebih besar dari saldo laci yang diharapkan tidak lagi ditolak (dulu 409 + batas 2 penolakan, M1). Sekarang dicatat seperti biasa (201, bentuk respons sama), diberi `cash_movements.needs_approval = true`, dikeluarkan dari angka laci, diaudit `pos_shift.cash_movement_held`, terlihat oleh supervisor (`needsApproval` di daftar kas, `heldCashOutIdr` di jejak hitungan), dan tutup shift menjadi `SHIFT_COUNT_STALE` bila jumlah yang ditahan berubah setelah hitungan.

## Berkas berisiko
- `apps/api/src/services/pos-shift.service.ts` (`recordCashMovement`, `submitPosShiftCount`, tutup shift, tutup paksa, daftar kas, laporan shift)
- `apps/api/src/services/pos-shift-support.ts` (`computeShiftAggregates`, `heldCashOutIdrOf`, `movementDto`, `countDto`, `AUDIT_SAFE_FIELDS`)
- `apps/api/src/db/schema/pos-shift.ts`
- `apps/api/drizzle/0113_little_random.sql` (nomor bentrok dengan `integ/m1-batch4`; merge train akan regenerasi)
- `packages/shared/src/pos/schemas.ts` (`posCashMovementSchema.needsApproval` opsional, `posShiftCountSchema.heldCashOutIdr`)

## Invariant
- Respons apa pun yang bisa dibaca kasir pemilik shift (status, bentuk, pesan, replay idempotensi, daftar kas, laporan, event `cash_movement.recorded`, struk hitungan dan `noteRequired`) tidak bergantung pada saldo laci yang diharapkan.
- Hitungan buta tetap buta: kasir tidak pernah melihat expected, variance, atau jumlah yang ditahan.
- Saldo yang diharapkan tidak pernah negatif; baris yang ditahan tidak masuk angka laci dan tidak boleh diposting ke pembukuan.
- Setiap tutup shift (kasir dan paksa) memakai persetujuan supervisor yang terikat ke hitungan terakhir; perubahan kas (biasa atau ditahan) setelah hitungan membuat tutup shift basi.
- Semua angka uang tetap safe integer (total kas keluar + setoran per shift dibatasi).
- Isolasi tenant dan outlet di setiap query dan tabel; `cash_movements` dan `pos_shift_counts` tetap riwayat yang tidak bisa diubah.

## Effort
xhigh (uang).

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.

---

# Run 2: refund dan void tunai tanpa membocorkan isi laci (legend-utqr)

## Rentang
`git diff 7b145cc9 c995dbe7` di worktree yang sama. Abaikan `apps/api/drizzle/meta/*`. Effort xhigh (uang dan migrasi).

## Perubahan (ringkas)
Refund dan void tunai di atas saldo laci tidak lagi ditolak 409 (penolakan itu terjadi setelah approval dipakai, jadi approval bisa diulang untuk menebak laci). Sekarang dicatat seperti biasa, ditandai `needs_approval`, dikeluarkan dari angka laci, dijumlahkan ke `heldCashOutIdr` supervisor, diaudit `pos_order.cash_refund_held` / `pos_order.cash_void_held`. Selisih buku = counted − expected + held dipakai untuk `noteRequired`, aturan catatan tutup shift, check DB, dan `differenceIdr` event `cashier_shift.closed`. Kolom baru `pos_shifts.held_cash_out_idr` diisi saat tutup dan dicek trigger terhadap hitungan.

## Berkas berisiko
- `apps/api/src/services/pos-order-corrections.ts` (void, refund: `needsApproval`, audit held)
- `apps/api/src/services/pos-cash-guard.ts` (`lockCashierShiftForCash` tanpa cek laci, `cashOutExceedsDrawer`)
- `apps/api/src/services/pos-shift-support.ts` (`computeShiftAggregates`, `heldCashOutIdrOf`, `countReceiptDto.noteRequired`)
- `apps/api/src/services/pos-shift.service.ts` (batas overflow `recordCashMovement`, `closeShift` args, `writeClose` held + `differenceIdr`)
- `packages/shared/src/pos/calculations.ts`, `events.ts`, `schemas.ts` (aturan catatan, refine event, refine U9 dihapus dari DTO)
- `apps/api/drizzle/0114_brave_golden_guardian.sql`, `0115_daily_stone_men.sql` (kolom, check, trigger `app.pos_shifts_guard`)

## Invariant tambahan
- Respons, event, dan audit yang terlihat kasir untuk refund/void sama, ditahan atau tidak; tidak ada penolakan yang bergantung pada laci setelah `consumeApproval`.
- Kas refund/void ditahan tidak dibukukan dua kali: `order.refunded` sudah mengkredit kas, tutup shift membukukan counted − (expected − held).
- `noteRequired`, `closeShift`, `pos_shifts_closed_check`, refine event memakai rumus yang sama; nilai approval tetap |counted − expected|.
- `pos_shifts.held_cash_out_idr` = held hitungan yang dipakai (trigger), 0 selama shift terbuka.

## Temuan review Claude (sudah ditangani atau di-bead)
- Diperbaiki: batas overflow memakai held refund (oracle), refund ditahan dibukukan dua kali, `noteRequired` membocorkan status held, check DB menolak hitungan jujur, trigger tidak mengecek held.
- Di-bead (di luar scope): `legend-nib1` (approval HP: ambang matriks membocorkan selisih dan status held), `legend-ifnb` (rekap tutup hari tidak memakai held).

---

# Run 3: rekap tutup hari dan approval tutup shift lewat HP (legend-ifnb, legend-nib1)

## Rentang
`git diff c995dbe7 049501f9` di worktree yang sama. Effort xhigh (uang, otorisasi).

## Perubahan (ringkas)
- Rekap tutup hari (`pos-day.service.ts`): selisih kas perangkat = `variance_idr + held_cash_out_idr` per shift tertutup (selisih buku, sama dengan `differenceIdr` `cashier_shift.closed`).
- Approval tutup shift lewat HP (`staff-override.service.ts`): `openApprovalRequest` dengan `amountIdr: null` untuk `cash_shift_close` (semua tier berlaku, tier tertinggi menentukan). Selisih hanya di `payload.valueIdr` (disembunyikan dari peminta).
- Penutupan (`pos-shift.service.ts` `assertApprovalTier`): requirement dengan nominal null; chain harus ber-`amountIdr` null, `payload.valueIdr` angka dan sama dengan selisih; PIN tetap butuh tier tertinggi satu level.

## Berkas berisiko
- `apps/api/src/services/staff-override.service.ts` (`createPosOverride`, jalur `supervisor_phone`)
- `apps/api/src/services/pos-shift.service.ts` (`assertApprovalTier`, `verifyCloseApproval`)
- `apps/api/src/services/pos-day.service.ts` (rekap perangkat)
- `apps/api/src/services/platform-approval.service.ts` (tidak diubah; cek bahwa nominal null aman di open, view peminta, decide, event, notifikasi)

## Invariant tambahan
- Semua yang bisa dibaca kasir dalam alur approval tutup shift (respons permintaan HP, replay, view approval peminta termasuk `requiredLevels`/`level`, 403 PIN, event approval) tidak bergantung pada selisih atau status held.
- Otoritas: setiap tutup shift butuh tier tertinggi matriks `cash_shift_close`; chain lama dengan nominal ditolak; `payload.valueIdr` hanya ditulis server.
- Rekap tutup hari dan `day.closed` sama dengan jumlah selisih buku shift.

## Temuan review Claude
- Diperbaiki: `Number(null)` = 0 pada pembanding payload (sekarang wajib angka).
- Keputusan bisnis (bukan bug): semua tutup shift butuh tier tertinggi; tier tertinggi 2 level membuat PIN tidak pernah cukup.
- Di-bead: `legend-6om3` (UI inbox), `legend-o0w6` (`pos_override.recorded` membawa selisih ke cloud-sync).

---

# Run 4: selisih tutup shift di event pos_override.recorded (legend-o0w6)

## Rentang
`git diff 049501f9 42e94ce7` di worktree yang sama. Kecil (2 berkas source + test). Effort high.

## Perubahan (ringkas)
- `packages/shared/src/access/override.ts`: payload `posOverrideRecordedEvent` `valueIdr` nullable, refine: `cash_shift_close` wajib null.
- `apps/api/src/services/staff-override.service.ts` `recordApprovedOverride`: event `valueIdr` null untuk `cash_shift_close`; audit tidak berubah.

## Berkas berisiko
- `apps/api/src/worker/transport.ts` (routing `cloud-sync`), `apps/api/src/edge/link-server.ts`, `apps/api/src/edge/db-link-store.ts` (ingest envelope generik), `apps/api/src/services/device-pin-support.ts` (`appendDevicePinEvent`).

## Invariant tambahan
- Tidak ada event, audit yang bisa dibaca kasir, atau feed perangkat yang membawa selisih hitungan buta.
- Konsumen sah tidak rusak; event lama (angka) tetap lolos ingest edge→cloud.

## Temuan review Claude
- Diperbaiki: asersi tes antrean edge yang selalu lulus dihapus; tes envelope lama ditambah.
- Di-bead: `legend-eadm` (edge→cloud `EdgeEventUnclassifiedError` untuk `pos_override.*`/`staff_pin.*`, sudah ada sebelum diff ini; data lama masih menyimpan angka di tabel DB).
