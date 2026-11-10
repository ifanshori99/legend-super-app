# Brief second-opinion Codex: purge retensi audit dengan identitas maintenance (bead legend-usyi)

Tingkat K (audit + akses data). Effort xhigh. Hanya review dan analisis, jangan ubah kode.

## Konteks

Cabang `ws/audit-retention-purge`. Keputusan desain: `docs/DECISIONS.md` entri
2026-11-10 (legend-usyi). Brief desain: `docs/briefs/280-audit-purge-design.md`.
Migrasi: `apps/api/drizzle/0187_audit_retention_maintenance.sql`. Job:
`apps/api/src/worker/audit-retention.job.ts`. Role: `apps/api/src/db/provision-roles.ts`,
`apps/api/src/db/role.ts`. Guard asli: `apps/api/drizzle/0008_wealthy_killraven.sql`
(`app.guard_audit_log`, trigger append-only).

Ringkas: login `legend_maint_<hex>` hanya bisa EXECUTE dua fungsi SECURITY DEFINER
milik pemilik tabel `audit_logs`; fungsi menghapus baris `audit_2y` berumur >= 2 tahun per tenant
dalam batch (`SKIP LOCKED`) dan menulis satu baris audit ringkas per batch.

## Pertanyaan

1. Adakah jalur bagi login maintenance, `legend_app`, atau login worker untuk
   menghapus/membaca baris audit di luar yang diizinkan (search_path, owner
   fungsi, PUBLIC grant, ALTER DEFAULT PRIVILEGES, trigger, `SET ROLE`)?
2. Apakah SECURITY DEFINER milik pemilik BYPASSRLS bisa melintasi tenant? Cek
   predikat tenant di kedua fungsi dan `set_config`.
3. Apakah ringkasan audit bisa hilang, ganda, atau bocor isi baris terhapus
   (transaksi, `SKIP LOCKED`, dua worker, crash di tengah)?
4. Apakah id uuid berurut/ULID yang dibangun di SQL cocok dengan `uuidToUlid` TS
   dan constraint `audit_logs_consistency`? Tabrakan id?
5. Apakah `verifyMaintenanceConnection` dan provisioning bisa dilewati
   (membership terwarisi, atribut role, kepemilikan)?
6. Risiko backlog pertama (WAL, bloat, waktu kunci) dan kegagalan sebagian.

## Cara menjalankan test

`bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/audit-retention.test.ts src/test/core-audit.test.ts" pnpm test'`
Jangan menjalankan `pnpm check` penuh.
