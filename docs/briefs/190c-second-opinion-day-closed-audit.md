# Brief: second-opinion — audit log buta untuk laci shift sendiri (legend-mxxev)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/day-closed-audit-blind`, cabang `ws/day-closed-audit-blind`, SHA `45b95ec2`.
Rentang diff: `git diff fa472534 45b95ec2` (basis `fa472534` = ujung ws/day-report-blind, legend-awg5p; satu commit di atasnya).

## Berkas berisiko
- `apps/api/src/services/audit-events.service.ts` (`drawerRef`, `hiddenDrawerFields`, wiring di `listAuditEvents`)
- `apps/api/src/test/audit-day-close-blind.test.ts`
- Konteks (tidak berubah): `pos-day.service.ts` closePosDay (audit `pos_daily_close`, event `day.closed`), `pos-shift.service.ts` + `pos-shift-support.ts` (audit `pos_shift`, `pos_shift_count`), `staff-override.service.ts` (audit `pos_override.recorded/requested`, `valueIdr` = |variance| untuk `cash_shift_close`), `core-audit-writer.ts` (safe fields), `edge/access-applier.ts`.

## Invariant
- POS-03 blind rule: kasir/supervisor tidak boleh tahu expected/variance laci shift-nya sendiri.
- Keputusan CTO 9 Nov (legend-awg5p): pembaca tanpa `pos.day.close` tidak membaca angka laci shift sendiri, dan tidak membaca `totalVarianceIdr` hari di mana ia punya shift. Pemegang `pos.day.close` (outlet_manager ke atas) melihat angka mentah. Shift kasir lain tetap terlihat oleh supervisor.
- Lewat `GET /api/audit/events` (`audit.log.view`), termasuk bila izin itu diberi ke supervisor lewat peran kustom atau override.
- Gagal tertutup: baris yang outlet/tanggal/shift-nya tidak bisa diselesaikan disembunyikan bagi pembaca tanpa `pos.day.close`.
- Event `day.closed` tidak diubah; konsumen (recipe-deduction) tetap dapat outletId/businessDate.
- Isolasi tenant di setiap query.

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
