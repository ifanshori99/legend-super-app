# Brief: reviewer / second-opinion — review legend-zoqc (provisioning role DB first boot)

## Peran

reviewer: baca `~/.agents/team/roles/reviewer.md`. second-opinion: baca `~/.agents/team/roles/second-opinion.md`. Lalu `~/.agents/team/TEAM.md`. Read-only: jangan mengubah kode, jangan commit.

## Repo

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/db-role-provisioning`, cabang `ws/db-role-provisioning`. Diff yang direview: `git diff main...ws/db-role-provisioning`.

## Tujuan

Cari cacat nyata di job first-boot yang membuat role database terbatas untuk aplikasi dan queue/worker. Acuan: `docs/PRD.md` §3 F3 dan TEN-02, brief engineer `docs/briefs/10-engineer-db-role-provisioning.md` di cabang itu.

## Fokus

- Role aplikasi/worker: tidak BYPASSRLS, bukan owner tabel, tidak bisa DDL, tidak bisa membuat role/DB, tidak mewarisi hak admin lewat membership atau default privileges.
- Kredensial admin tidak pernah sampai ke service aplikasi (compose, env, image, log).
- Idempoten: dijalankan ulang aman; drift grant (misal grant dari grantor lain) dinormalisasi atau gagal ke arah aman, dan dokumentasi sesuai perilaku.
- Password tidak tercetak di log/error/argv (ps). Quoting identifier/literal aman dari injeksi.
- Urutan dengan migrasi: tabel baru setelah job tetap ter-grant (default privileges) atau dokumentasi jelas.
- Test integrasi benar-benar membuktikan klaim di atas (bukan hanya jalan hijau).

## Laporan

Temuan diurutkan dari paling berat: file:baris, masalah, skenario gagal konkret, usulan fix. Tulis "tidak ada blocker" bila memang tidak ada. Jangan memuji.
