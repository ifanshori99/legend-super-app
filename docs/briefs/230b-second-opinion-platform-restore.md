# Brief: second-opinion — pulihkan tenant diarsip / outlet ditutup dalam 30 hari (legend-umzos)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/platform-restore-archived`, cabang `ws/platform-restore-archived`, SHA `f3e0fb54`.
Rentang diff: `git diff d7a95d0c HEAD` (basis `integ/m1-batch31` `d7a95d0c`; abaikan drizzle `meta/*.json`).

## Berkas berisiko
- `packages/shared/src/platform/org.ts` (bagian "restore window (Q40)", peta transisi)
- `packages/shared/src/platform/errors.ts`
- `apps/api/src/services/platform-org.service.ts` (`setTenantStatus`, `restoreTenant`, `restoreOutlet`, `get*RestoreWindow`)
- `apps/api/src/services/org.service.ts` (`setOutletStatus`)
- `apps/api/src/routes/platform.routes.ts`
- `apps/api/src/db/schema/platform-org.ts`
- `apps/api/drizzle/0165_platform_restore_window.sql`

## Invariant (keputusan founder Q40, PRD F4, TEN-04)
- Hanya Super Admin (registry `platform_admins` + MFA sesi, sama dengan arsip tenant) yang dapat memulihkan.
- Pulih hanya dalam 30 hari sejak transisi, ke status sebelum arsip/tutup. Sesudah 30 hari final. Data lama tanpa waktu transisi: final.
- Alasan wajib; setiap pulih tercatat di audit dengan aktor dan alasan.
- Endpoint status umum tetap menolak keluar dari `archived`/`closed`.
- Pulih tidak boleh membuat nomor struk ganda; edge node lama tersambung kembali hanya karena kredensialnya memang tidak dicabut saat tutup — periksa apakah itu aman.
- Isolasi tenant: outlet hanya dipulihkan di tenant pemiliknya; RLS tetap dipaksa.
- Balapan: dua pulih bersamaan, pulih bersamaan dengan arsip ulang.

## Effort
xhigh (migrasi + akses).

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
