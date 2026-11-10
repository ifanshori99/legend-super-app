# Brief 138: second-opinion — konvensi FK migrasi ke tabel FORCE RLS dan lock_timeout migrator (legend-m007, legend-jluo)

> Catatan CTO 9 Nov 20:45: cabang dan worktree yang disebut di bawah sudah digabung ke `milestone/m1` lalu dihapus. Semua SHA di brief ini ada di m1. Baca dengan `git diff`/`git show` pada SHA itu dari folder utama `/Users/ifanshori99/Projects/legend super app/legend` (read-only, jangan checkout). Cek juga apakah kode yang sama sudah berubah sesudahnya di `milestone/m1` (`git log <tip>..milestone/m1 -- <file>`).

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/migration-fk-rls`, cabang `ws/migration-fk-rls`.
Rentang diff: `git diff 3143577d 44743e97` (basis `milestone/m1` 3143577d; commit 1c3ff291, bda0d166 untuk legend-m007, 44743e97 untuk legend-jluo).
Konteks yang sudah ada di m1 dan ikut dinilai: konvensi di `docs/plan/contracts.md` bagian "Migrations: foreign keys into FORCE RLS tables" (commit f7b6f4c8, 19640b63), `apps/api/src/test/migration-fk-force-rls.test.ts`, `apps/api/src/test/edge-received-events-migration.test.ts` ("applies the full migration folder as the non-superuser owner").

## Berkas berisiko
- `docs/plan/contracts.md` (contoh SQL pola 1 dan 2, catatan lock)
- `apps/api/src/test/migration-force-rls-guard.test.ts` (scan statis SQL + cek katalog)
- `apps/api/src/test/migration-fk-force-rls.test.ts` (kasus baru: child FORCE berisi data, child FORCE ke induk tanpa RLS)
- `apps/api/src/db/migration-session.ts`, `apps/api/src/migrate.ts`, `apps/api/src/predeploy-check.ts` (lock_timeout, statement_timeout, pesan error, exit 1)
- `apps/api/src/test/migration-lock-timeout.test.ts`
- `docs/deployment.md` bagian "Migration lock timeout", `.env.example`, `deploy/single-vm/runtime.env.example`
- Rujukan: `apps/api/drizzle/0065_edge_received_events.sql`, `0068_closed_tiger_shark.sql`, `0007_platform_org_rls.sql`, `0021_payment_rls.sql`, `docs/deployment.md` bagian "Create the migrator login"

## Invariant
- Migrasi 0065 dan sesudahnya lolos dijalankan pemilik tabel biasa (NOSUPERUSER, NOBYPASSRLS). Production memakai migrator NOSUPERUSER BYPASSRLS; 0000-0064 boleh bergantung pada BYPASSRLS dan tidak ditulis ulang.
- Setiap `NO FORCE ROW LEVEL SECURITY` dipulihkan dengan `FORCE` di berkas yang sama, sebelum transaksi migrasi commit (drizzle menjalankan semua migrasi tertunda dalam satu transaksi).
- Tidak ada FK `NOT VALID` di migrasi 0065+.
- Setelah semua migrasi, tiap tabel public dengan RLS aktif juga FORCE, kecuali `tenant_domains` dan `payment_link_tokens` (terdokumentasi). Tabel ber-`tenant_id` tetap dijaga `src/db/rls.test.ts`.
- Pola 2 mengangkat FORCE di induk dan di child bila child juga FORCE; validasi memeriksa seluruh baris lintas tenant, tanpa jalan pintas `app.tenant_id` dummy.
- Tidak ada `DISABLE ROW LEVEL SECURITY` di migrasi 0065+.
- Migrator memakai satu koneksi: `lock_timeout` (default 10s) dan `statement_timeout` (default 0, menimpa default role/database) berlaku untuk seluruh transaksi drizzle.
- 55P03, 57014, 40P01: semua migrasi tertunda di-rollback, pesan jelas tanpa connection string, exit 1, `deploy.sh` (`set -eu`) berhenti sebelum audit role dan restart layanan.
- Nilai timeout wajib ber-unit (ms, s, min) dan ≤ 2147483647 ms; nilai salah ditolak sebelum menyentuh database (juga di pre-deploy check).

## Effort
xhigh (migrasi).

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
