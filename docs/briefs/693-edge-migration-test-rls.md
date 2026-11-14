# Brief: engineer (Codex) — akar gagal edge-received-events-migration.test.ts

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep, Read offset/limit), lalu ikuti. Jangan jalankan `bd`.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri dari `origin/ws/finance-exceptions` (598cd9cb1): `git worktree add -b fix/edge-migration-rls .worktrees/edge-migration-rls origin/ws/finance-exceptions`.

## Tujuan
`apps/api/src/test/edge-received-events-migration.test.ts` gagal 3 dari 11 di cabang `ws/payroll-payout-so-fixes` (fad22fed5): SQLSTATE 42501 di `app.require_tenant_id()`, lalu 42P01, dan RLS tidak forced. Dugaan: FK migrasi 0534 `payroll_disbursement_items_gl_posting_fk` (migrasi dijalankan sebagai owner non-superuser). `docs/PROGRESS.md` sekitar baris 545 mencatat gagal serupa sebelumnya.

1. Reproduksi di `milestone/m1`, di `598cd9cb1`, dan di `fad22fed5` (`LEGEND_TEST_FILES=src/test/edge-received-events-migration.test.ts heavy pnpm test`, dari root worktree; ganti HEAD dengan `git checkout` di worktree-mu). Catat hasil tiap titik.
2. Bila gagal juga di m1: pre-existing, cari akar. Bila mulai gagal di cabang: bisect commit/migrasi penyebab.
3. Perbaiki di migrasi/test yang benar tanpa menulis ulang migrasi yang sudah diterapkan di milestone/m1 (migrasi cabang yang belum merge boleh diperbaiki). Jangan longgarkan RLS.

## Batas
Hanya migrasi cabang terkait dan test. Migrasi baru bila perlu: `0577` saja, `node ~/.agents/team/check-journal.mjs origin/milestone/m1`.

## Laporan
Hasil di 3 titik, akar masalah, perbaikan (commit, cabang yang harus menerimanya), sisa risiko. Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `fix/edge-migration-rls` tanpa force.
