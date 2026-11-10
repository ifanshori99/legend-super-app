# Brief: second-opinion — role migrator production dan cek outbox pra-deploy (deploy-prep, brief 88)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti. Read-only: jangan edit atau commit.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/prep-deploy-prep`, cabang `ws/deploy-prep` lewat `prep/deploy-prep` 97f008cc. Tip fitur `3e2f516e` (production migrator role dan pre-deploy outbox check; `legend-jtnd`, `legend-k1np`).
Digabung ke `milestone/m1` sebagai merge `f77e18d8` (tanpa migration). Parent merge: `b49202b5` (m1) dan `97f008cc`.
Rentang diff isi cabang di atas m1: `git diff b49202b5 f77e18d8` (15 file). Jangan pakai `merge-base main`. Brief engineer asal: `docs/briefs/88-deploy-prep-migrator-outbox.md`.

## Berkas berisiko
- `apps/api/src/db/migrator-role.ts`, `provision-roles.ts`, `predeploy-check.ts`
- `apps/api/src/provision-roles.ts`, `apps/api/src/predeploy-check.ts`
- `deploy/single-vm/deploy.sh`, `provision-roles.sh`, `test-deploy.sh`, `runtime.env.example`
- `docs/deployment.md`

## Fokus (auth, rahasia, migration)
- Role migrator production: bukan superuser, NOBYPASSRLS, hak minimal; role app tidak bisa DDL; tidak ada GRANT berlebih atau default privilege yang bocor ke role lain.
- Kata sandi role: tidak dicetak ke log, argv, atau riwayat shell; `runtime.env.example` tidak berisi nilai asli; provisioning idempoten dan aman dijalankan ulang.
- SQL provisioning: identifier dan literal di-quote benar, tanpa injeksi lewat nama role atau env.
- Cek outbox pra-deploy: deploy berhenti bila outbox belum kosong atau ada event gagal; gagal terbuka vs gagal tertutup (harus tertutup); tidak menghapus atau menjalankan ulang event.
- `deploy.sh`: urutan migrasi, rollback, `set -euo pipefail`, tidak ada langkah yang melewati cek.
- Test (`migrator-role.test.ts`, `db-role-provisioning.test.mjs`, `test-deploy.sh`) benar-benar membuktikan klaim.

## Effort
high.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal konkret, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
