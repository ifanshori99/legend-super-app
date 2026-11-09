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
- Event dan audit `role_assignment.ended` dikirim dengan konteks lingkup tenant walau pemanggil HR hanya punya lingkup outlet (wewenang dicek lewat outlet asal karyawan).
- Pemanggilan kedua mengembalikan hasil pertama tanpa audit atau event baru.
- Owner ditolak 409 `OFFBOARDING_OWNER`; assignment yang baru berlaku nanti ditolak 409 `FUTURE_ASSIGNMENT`.
- Nilai KPI sistem hanya dari `evaluateMetrics`; dimensi employee = user id.
- Ringkasan hak akhir tidak menghitung THR, BPJS, atau angka bersih; semuanya ada di `pendingPayrollEngine` (menunggu legend-j2l2).

## Pertanyaan review

1. Setelah clearance, apakah orang itu masih bisa masuk lewat jalur mana pun: sesi lain, sesi impersonasi, PIN di perangkat outlet, edge node offline, token API, undangan yang masih terbuka?
2. Idempoten di bawah konkurensi: dua revoke bersamaan, revoke bersamaan dengan `endRoleAssignment` biasa, revoke bersamaan dengan cancel. Urutan lock dan risiko deadlock.
3. Pelebaran hak: apakah HR lingkup outlet bisa mencabut akses admin lingkup tenant atau orang di outlet lain lewat offboarding? Apakah itu wajar untuk F24, atau perlu pembatasan?
4. Isolasi tenant dan outlet di semua service baru; 404 (bukan 403) untuk rekaman di luar jangkauan.
5. Migrasi 0206: RLS dipaksa di 7 tabel, FK komposit dengan tenant, log aksi checklist benar-benar append-only untuk `legend_app`.
6. Audit dan log: tidak ada data pribadi atau angka gaji di payload audit.
7. KPI: angka sistem cocok dengan sumber, lingkup outlet pemanggil diterapkan, dan nilai sistem tidak bisa ditimpa manual.
8. Surat keterangan kerja: penomoran `SK/YYYY/NNNN` unik di bawah konkurensi; hanya terbit setelah offboarding selesai.

## Laporan

Satu laporan.

- Temuan diurutkan dari yang paling berat (blocker, tinggi, sedang, rendah).
- Tiap temuan: file:baris, nomor pertanyaan, skenario gagal konkret, dan usulan fix.
- Tulis "Tidak ada blocker" bila memang tidak ada.
- Pisahkan: (a) yang sudah dibuktikan dari kode, (b) yang tidak terverifikasi.
- Boleh reproduksi dengan test sementara lewat `LEGEND_TEST_FILES="<file>" pnpm test` dari root worktree. Bersihkan sesudahnya dan jangan tinggalkan berkas baru.
