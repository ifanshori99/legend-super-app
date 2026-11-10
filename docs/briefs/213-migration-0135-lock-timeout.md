# Brief: engineer — 0135 memulihkan lock_timeout migrator, bukan default (legend-76azz)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/migration-0135-lock-timeout` dari ujung `milestone/m1` terbaru, worktree `.worktrees/migration-0135-lock-timeout`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-76azz` (P1, tingkat K: migrasi). `apps/api/drizzle/0135_edc_pan_scrub.sql:80` memakai `SET LOCAL lock_timeout TO DEFAULT`, yang memulihkan default role/database, bukan batas migrator (legend-jluo). Bila default 0 dan 0136 tertahan lock `pos_shifts`, deploy menunggu tanpa batas dan trafik POS ikut antre.
Perbaikan: simpan `current_setting('lock_timeout')` lalu pulihkan dengan `set_config(..., true)`, mengikuti pola `0143_edc_pan_scrub_separators.sql` (baris 91, 93, 164). 0135 belum ada di `main` (belum pernah rilis), jadi ubah di tempat. DB dev yang sudah menjalankannya tidak terpengaruh. Tambah test konvensi yang menolak `lock_timeout TO DEFAULT` (dan `RESET lock_timeout`) di `apps/api/drizzle/*.sql`, di dekat test konvensi migrasi yang ada (`migration-fk-force-rls.test.ts`). Cek juga semua file migrasi lain untuk pola yang sama dan perbaiki yang belum rilis; yang sudah ada di `main` jangan diubah, laporkan saja.

## Kartu
`ghostex board associate legend-76azz`, `bd update legend-76azz --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: `apps/api/drizzle/0135_edc_pan_scrub.sql` (dan migrasi belum rilis lain dengan pola sama), test konvensi migrasi, `docs/plan/contracts.md` bagian konvensi migrasi. Jangan: migrasi baru, `drizzle/meta`, kode aplikasi.

## Bukti selesai
Test konvensi gagal dulu di basis (menemukan 0135), lulus sesudah perbaikan. Test yang menjalankan seluruh folder migrasi sebagai non-superuser (`edge-received-events-migration.test.ts` "applies the full migration folder as the non-superuser owner") tetap lulus. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan. eslint, prettier. Jangan jalankan `pnpm check` penuh. Review: reviewer + architect (subagent) paralel.

## Laporan
Sekali: hasil, file berubah, SHA, daftar migrasi lain yang memakai pola sama (rilis atau belum), risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
