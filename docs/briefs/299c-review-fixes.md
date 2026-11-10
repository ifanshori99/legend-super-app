# Brief 299c: perbaikan temuan review architect (legend-ovxw)

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/hr-lifecycle-kpi`, cabang `ws/hr-lifecycle-kpi` (commit 25116122). Jangan commit, push, atau merge. Jangan baca `.env*`. Hanya edit berkas milikmu (lihat "Pemilik"). Typecheck lewat `heavy`. Test: `bash -c 'cd <worktree> && LEGEND_TEST_FILES="src/test/<file>" pnpm test'`.

Baris di bawah merujuk `apps/api/src/services/hris-offboarding.service.ts` kecuali disebut lain.

## Keputusan

D1. Exit clearance (POST revoke-access) adalah tindakan seluruh tenant. Pemanggil wajib memegang `hr.employee.manage` lingkup tenant (`context.outletScope.kind === "tenant"` dari `hrisLearningContext`). HR lingkup outlet: 403 `CLEARANCE_NEEDS_TENANT_HR`, pesan "Pencabutan akses hanya bisa dilakukan HR pusat." (cek setelah record terbukti terjangkau, jadi record di luar jangkauan tetap 404). Karena konteks sudah tenant, `eventContext` di `endUserRoleAssignmentsForOffboardingInTx` dihapus dan kembali memakai `context`.

D2. Bila leaver punya assignment aktif atau mendatang yang lingkupnya tenant, pemanggil juga wajib memegang `access.role.assign` lingkup tenant. Tanpa itu: 409 `OFFBOARDING_ADMIN_ROLE`, "Karyawan ini punya peran tingkat perusahaan. Minta admin akses mencabutnya." Route menghitung `canAssignRoles` dari snapshot akses (cari pola yang ada, mis. `requireTenantPermission` atau snapshot di `req`) lalu meneruskannya ke service.

D3. Assignment mendatang (valid_from > now) tidak lagi memblok. Helper mengakhirinya dengan `valid_until = valid_from` (jendela kosong, tidak pernah aktif karena `valid_until` eksklusif), dengan event dan audit yang sama. Constraint `role_assignments_window_check` di `apps/api/src/db/schema/platform-access.ts` dilonggarkan dari `>` ke `>=`. Error `FUTURE_ASSIGNMENT` dihapus. `endRoleAssignment` tidak disentuh.
Migrasi: tetap SATU migrasi 0206. Ubah schema, jalankan `pnpm db:generate` (menghasilkan berkas 0207 baru), pindahkan statement ALTER-nya ke akhir bagian generated `apps/api/drizzle/0206_hris_lifecycle_kpi.sql` (sebelum custom SQL yang ditempel), ganti `meta/0206_snapshot.json` dengan snapshot baru tapi pertahankan `id` dan `prevId` 0206 lama, hapus berkas 0207 dan entri journal-nya. `db:generate` kedua harus "No schema changes". Migrasi RLS test harus tetap lulus.

D4. Sesi: cabut sesi non-customer, non-impersonasi milik user itu dengan `tenant_id = tenant` ATAU `tenant_id IS NULL` (lihat `middleware/identity-surface.ts:3`: tenant_id belum diisi). Akibat: user harus login ulang untuk tenant lain. Catat di komentar.

D5. `now` dibaca SETELAH advisory lock (pola legend-qr1uv), termasuk yang dipakai `loadHrisAccess`.

D6. Shift: dengan konteks tenant (D1) semua outlet terlihat. Kunci baris shift `FOR UPDATE`, cek ulang `employeeId` masih leaver setelah lock, lewati yang sudah pindah tangan. Kunci employee dengan `FOR NO KEY UPDATE`, bukan `FOR UPDATE`.

D7. Revoke hanya SETELAH hari kerja terakhir: `homeOutletToday <= lastWorkingDate` → 409 `EXIT_NOT_DUE` (sesuai DECISIONS).

D8. Surat keterangan kerja: karyawan yang keluar tidak lagi punya akses, jadi surat diserahkan lewat HR/payroll. Jalur `self` dihapus dari route dan service certificate. Test certificate memakai endpoint revoke sungguhan, tidak set status dengan SQL. Self-service mantan karyawan menjadi kartu baru (CTO yang membuat).

D9. KPI: nilai sistem untuk satu karyawan dihitung lintas seluruh tenant (konteks tenant untuk `evaluateMetrics`, hanya untuk employee itu), tidak tergantung outlet pemanggil. Pemanggil tetap harus menjangkau karyawan itu (404 bila tidak).

## Pemilik

- implementer-clearance: `hris-offboarding.service.ts`, `access.service.ts` (hanya helper offboarding), `routes/hris-offboarding.routes.ts`, `db/schema/platform-access.ts`, `drizzle/0206*`, `drizzle/meta/*`. Butir D1-D7.
- implementer-certificate: `hris-work-certificate*.ts`, `routes/hris-work-certificate.routes.ts`, `test/hris-work-certificate-api.test.ts`. Butir D8.
- implementer-kpi: `hris-kpi.service.ts`, `routes/hris-kpi.routes.ts`, `test/hris-kpi-api.test.ts`. Butir D9.
- test-writer: `test/hris-offboarding-clearance.test.ts` saja. Test gagal-dulu untuk D1-D7 (sesi tenant_id NULL dicabut; HR outlet 403; assignment tenant tanpa access.role.assign 409; assignment mendatang diakhiri jadi jendela kosong; shift di outlet lain dibatalkan; revoke tepat di hari terakhir 409). Test lama yang memakai HR outlet untuk revoke diganti ke HR tenant.
