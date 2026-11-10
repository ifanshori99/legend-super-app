# Brief: second-opinion — laporan harian buta untuk shift sendiri (legend-awg5p)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/day-report-blind`, cabang `ws/day-report-blind`, SHA `fa472534`.
Rentang diff: `git diff 12c91f6b fa472534` (basis m1 `12c91f6b`, satu commit).

## Berkas berisiko
- `apps/api/src/services/pos-day.service.ts` (`blindOwnDrawer`, `getEndOfDayRecap`, `assertApprover`)
- `packages/shared/src/pos/schemas.ts` (`endOfDayBlindRecapSchema`, `endOfDayRecapViewSchema`)
- `packages/shared/src/pos/endpoints.ts` (respons `getEndOfDayRecap`)
- `apps/web/src/features/ws04-pos-kasir/api.ts`, `components/day-close/day-close-screen.tsx`
- `apps/api/src/test/pos-day-blind-own-shift.test.ts`

## Invariant
- POS-03 blind rule: kasir/supervisor tidak boleh tahu angka laci shift-nya sendiri (expected, variance, kas per metode) sebelum menghitung, dan tidak boleh membaca variance shift sendiri sesudahnya.
- Keputusan CTO 9 Nov: laporan harian mengosongkan angka laci milik shift pemanggil sendiri hari itu, sebelum maupun sesudah tutup, kecuali pemegang `pos.day.close` (outlet_manager ke atas). Supervisor tanpa shift hari itu: recap penuh.
- Tidak boleh bocor lewat pengurangan (total penjualan − refund − void vs baris metode, total outlet vs perangkat lain).
- Isolasi tenant dan outlet di setiap query.

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
