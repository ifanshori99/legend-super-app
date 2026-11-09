# Brief: engineer (Opus) — pemilik dan sumber objek storage (legend-pszrm)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/storage-object-owner` dari `ws/support-storage-access` (b800ae30; berisi `services/core-storage-access.ts` dari legend-tiie; antre merge train). Worktree `.worktrees/storage-object-owner`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

Nomor migrasi dipesan: `0177`, `when` 1794256000000.

## Tujuan
`legend-pszrm` (tingkat K, akses dan data pribadi). Keputusan CTO: objek storage mencatat pemilik dan sumbernya, dan `authorize` memeriksa per `objectId`.
- Kolom baru di `core_storage_objects`: `owner_user_id` (pengunggah atau subjek, mis. karyawan pada selfie absensi dan receipt reimburse) dan `source_kind` + `source_id` (fitur dan dokumen yang memakai objek: purchase invoice, expense, reimbursement, attendance, goods receipt, dll.). Data lama: biarkan null dan perlakukan ketat (hanya izin pengelola fitur yang sesuai), tulis di laporan.
- `core-storage-access.ts`: reviewer hanya membaca objek yang `source_kind`-nya cocok dengan izinnya (`purchasing.invoice.match` tidak membaca receipt reimburse, dst.), dalam cakupan outlet; pemilik selalu bisa membaca objeknya sendiri (selfie absensi, receipt reimburse).
- Alur yang membuat/menautkan objek (upload receipt, selfie absensi, foto goods receipt bila ada di basis) mengisi kolom baru.
- Router storage tetap belum dipasang (menunggu legend-7nv1 dan provider S3).

## Kartu
Awal: `ghostex board associate legend-pszrm`, `bd update legend-pszrm --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Scope
Boleh: schema storage + migrasi 0177, `services/core-storage*.ts`, service yang membuat objek storage (bagian pengisian kolom saja), validator/tipe di `packages/shared` bila perlu, test. Jangan: auth/Better Auth, support session, payroll/refund logic, UI.

## Bukti selesai
- `pnpm db:generate` lalu periksa SQL; generate kedua kosong. Test migrasi RLS (`migration-force-rls-guard`, `migration-fk-force-rls`).
- Test gagal-dulu: reviewer pembelian ditolak membaca receipt reimburse; approver reimburse membaca receipt reimburse di outletnya; karyawan membaca selfie dan receipt miliknya, ditolak milik orang lain; objek tenant lain ditolak; objek lama (null) hanya untuk pengelola.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes.
- Typecheck paket yang berubah lewat `heavy` sekali di akhir; eslint + prettier berkas berubah. Jangan `pnpm check` penuh.
- Review (Q48, tingkat K): satu subagent `architect`, lensa penyerang + `~/.agents/team/review-checklist.md`. Subagent paralel sesuai "Paralel dulu".
- Tulis brief Codex `docs/briefs/261b-second-opinion-storage-owner.md`, jangan dijalankan.

## Laporan
Sekali di akhir: hasil, SHA, migrasi (`when`, prevId), bukti, file berubah, risiko, jumlah subagent dan puncak bersamaan.
