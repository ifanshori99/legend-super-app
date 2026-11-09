# 280c: temuan review architect (legend-usyi), worktree .worktrees/audit-retention-purge

Perbaiki 4 temuan; tes gagal-dulu tiap temuan; jalankan LEGEND_TEST_FILES dari root worktree.
1. `apps/api/src/worker-main.ts` (~358-372) dan `worker/audit-retention.job.ts` (~251-266): setelah `runtime.start()` di dalam `try` yang ada, jalankan `const c = await maintenancePool.connect(); c.release();` sebelum `registerAuditRetentionJob`, supaya login salah/placeholder/owner/bukan anggota gagal saat start (lewat pembersihan yang ada). Bungkus handler job dengan try/catch yang log error lalu lempar ulang. Jalankan juga `verifyMaintenanceConnection` pada koneksi itu bila belum otomatis.
2. `audit-retention.job.ts` (~299-301): hasil run jangan dibuang; log `{tenants, deleted, failedTenants, truncated}`; lempar error bila `failedTenants > 0` (pg-boss menandai gagal; retry aman). Sesuaikan tes mock.
3. `apps/api/src/db/role.ts` (~349-355): tambah kondisi tidak aman `session_user !~ '^legend_maint_[a-f0-9]{16}$'` di verifyMaintenanceConnection; tes di `src/db/role.test.ts`.
4. `deploy/single-vm/runtime.env.example` (~20-25): komentari baris `MAINTENANCE_DATABASE_URL=` seperti `.env.example`; pastikan `deploy/single-vm/check-compose-env.mjs` dan tesnya (`tests/db-role-provisioning.test.mjs`) masih lulus.
Jangan ubah file lain. Lapor ringkas: file, jumlah file/tes lulus.
