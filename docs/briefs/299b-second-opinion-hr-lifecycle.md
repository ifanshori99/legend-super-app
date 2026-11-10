# Brief 299b: second opinion untuk WS-10 lifecycle dan KPI (legend-ovxw)

## Peran

Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`.

- Agent Codex, model `gpt-6.1-sol`, effort xhigh (tingkat K: akses, migrasi, data pribadi).
- Read-only: jangan ubah kode, jangan commit, jangan push, jangan merge.
- Jangan baca `.env*` atau isi rahasia apa pun.
- Langkah pertama: pecah tugas, lalu spawn subagent paralel dalam satu giliran (jika dibutuhkan).

## Repo

- Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/hr-lifecycle-kpi`, cabang `ws/hr-lifecycle-kpi`.
- Diff review: `git diff ws/hr-scheduling...ws/hr-lifecycle-kpi` (basis 88cc626e).
- Desain: `docs/DECISIONS.md` entri teratas "2026-11-10: WS-10 lifecycle" dan `docs/briefs/299-hr-lifecycle-kpi.md`. Review terhadap diff, bukan terhadap niat di dokumen.
- Berkas utama:
  - `apps/api/src/services/hris-offboarding.service.ts` (`revokeOffboardingAccess`, `completeOffboarding`, `cancelOffboarding`)
  - `apps/api/src/services/access.service.ts` (`endUserRoleAssignmentsForOffboardingInTx`, di akhir berkas)
  - `apps/api/src/services/hris-scheduling-roster.service.ts` (`cancelShiftAssignmentInTx`)
  - `apps/api/src/services/hris-checklist.service.ts`, `hris-kpi.service.ts`, `hris-settlement.service.ts`, `hris-work-certificate.service.ts`, `hris-work-certificate-pdf.ts`
  - `apps/api/src/db/schema/hris-lifecycle.ts`, `hris-lifecycle.custom.sql`, `apps/api/drizzle/0206_hris_lifecycle_kpi.sql`
  - `packages/shared/src/hris/{checklists,lifecycle,performance,endpoints}.ts`
  - Test: `apps/api/src/test/hris-{offboarding-clearance,checklist-api,kpi-api,work-certificate-api}.test.ts`

## Fakta yang sudah dipetakan (verifikasi, jangan terima begitu saja)

- Exit clearance mengakhiri semua role assignment orang itu di tenant ini, mencabut sesi staf tenant ini, menghapus push subscription, membatalkan shift setelah hari kerja terakhir, lalu set status karyawan. Baris PIN dibiarkan; PIN ditolak karena keanggotaan sudah berakhir.
- Exit clearance hanya untuk HR lingkup tenant (HR outlet: 403 `CLEARANCE_NEEDS_TENANT_HR`). Leaver dengan peran lingkup tenant butuh pemanggil yang juga memegang `access.role.assign` (409 `OFFBOARDING_ADMIN_ROLE`).
- Pemanggilan kedua mengembalikan hasil pertama tanpa audit atau event baru. `now` dibaca setelah advisory lock.
- Owner ditolak 409 `OFFBOARDING_OWNER`. Assignment mendatang diakhiri dengan jendela kosong (`valid_until = valid_from`); `role_assignments_window_check` dilonggarkan ke `>=` di migrasi 0206.
- Sesi dicabut untuk tenant ini dan sesi tanpa `tenant_id` (belum diisi di produksi).
- Shift setelah hari terakhir dikunci, dicek ulang pemiliknya, lalu dibatalkan; swap tertunda dikunci dulu demi urutan lock.
- Revoke hanya setelah hari kerja terakhir (pada hari itu 409 `EXIT_NOT_DUE`).
- Surat keterangan kerja hanya untuk HR; mantan karyawan tidak punya akses (legend-arj.7).
- Nilai KPI sistem hanya dari `evaluateMetrics`; dimensi employee = user id; dihitung lintas tenant untuk satu karyawan itu (`app.outlet_ids` dilebarkan sementara lalu dipulihkan dalam transaksi).
- Ringkasan hak akhir tidak menghitung THR, BPJS, atau angka bersih; semuanya ada di `pendingPayrollEngine` (menunggu legend-j2l2).

## Pertanyaan review

1. Setelah clearance, apakah orang itu masih bisa masuk lewat jalur mana pun: sesi lain, sesi impersonasi, PIN di perangkat outlet, edge node offline, token API, undangan yang masih terbuka?
2. Idempoten di bawah konkurensi: dua revoke bersamaan, revoke bersamaan dengan `endRoleAssignment` biasa, revoke bersamaan dengan cancel. Urutan lock dan risiko deadlock.
3. Pelebaran hak: apakah ada jalur bagi HR tanpa `access.role.assign` untuk mencabut peran admin, atau bagi pelebaran `app.outlet_ids` di KPI untuk bocor ke pembacaan lain dalam transaksi yang sama?
4. Isolasi tenant dan outlet di semua service baru; 404 (bukan 403) untuk rekaman di luar jangkauan.
5. Migrasi 0206: RLS dipaksa di 7 tabel, FK komposit dengan tenant, log aksi checklist benar-benar append-only untuk `legend_app`.
6. Audit dan log: tidak ada data pribadi atau angka gaji di payload audit.
7. KPI: angka sistem cocok dengan sumber, lingkup outlet pemanggil diterapkan, dan nilai sistem tidak bisa ditimpa manual.
8. Surat keterangan kerja: penomoran `SK/YYYY/NNNN` unik di bawah konkurensi; hanya HR yang menjangkau karyawan itu.
9. Migrasi 0206 melonggarkan `role_assignments_window_check`: apakah ada pembaca yang menganggap `valid_until > valid_from` selalu benar?

## Laporan

Satu laporan.

- Temuan diurutkan dari yang paling berat (blocker, tinggi, sedang, rendah).
- Tiap temuan: file:baris, nomor pertanyaan, skenario gagal konkret, dan usulan fix.
- Tulis "Tidak ada blocker" bila memang tidak ada.
- Pisahkan: (a) yang sudah dibuktikan dari kode, (b) yang tidak terverifikasi.
- Boleh reproduksi dengan test sementara lewat `LEGEND_TEST_FILES="<file>" pnpm test` dari root worktree. Bersihkan sesudahnya dan jangan tinggalkan berkas baru.
