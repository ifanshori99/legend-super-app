# Brief: engineer — skema payroll + RLS + API konfigurasi, kasbon, reimburse, service charge (legend-gfcr)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/payroll-schema-api` dari `milestone/m1` terbaru (42ee5c28 atau lebih baru). Worktree `.worktrees/payroll-schema-api`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-gfcr` (P2, tingkat K: uang, migrasi, data pribadi). Baca `bd show legend-gfcr` (deskripsi, catatan second opinion zjwa) dan `bd comments legend-gfcr`. Kontrak sudah ada: `packages/shared/src/hris/payroll/endpoints.ts` dan hitungan murni di `packages/shared/src/hris/payroll/`. Yang sudah ada di DB: `payroll-pph21-policy.ts` (0085), 0155.
- Langkah 1: petakan tabel di deskripsi kartu terhadap yang sudah ada (2 `Explore` paralel), lalu bangun yang belum: tabel dengan `tenant_id` + `app.enforce_tenant_rls`, nominal karyawan terenkripsi (HR-03, ikuti pola enkripsi yang sudah dipakai proyek), `statutory_rates` versi dan immutable sesudah publish.
- Langkah 2: route `defineEndpoint` untuk konfigurasi, komponen gaji, kasbon, kategori dan pengajuan reimburse, pool service charge, di luar siklus run (`legend-07eg`) dan mesin hitung (`legend-j2l2`, dipecah ke kartu lain: jangan dikerjakan).
- Ikuti catatan zjwa di kartu (contoh: `updatePayComponent` merge lalu parse ulang skema di server).
- PRD: `docs/PRD.md` §30 (sekitar baris 925-932) dan bagian H, R20, PAYR-02.

## Kartu
`legend-gfcr`. Di awal: `bd update legend-gfcr --status in_progress`. Saat melapor: `bd update legend-gfcr --status review` dan `bd comment legend-gfcr "<ringkasan>"`. Pekerjaan sisa: kartu baru `-l payroll`.

## Scope
Boleh: `apps/api/src/db/schema/payroll*.ts` dan `hris*.ts` baru, `apps/api/drizzle/` (satu migrasi), service/route payroll, kontrak shared payroll bila perlu, test. Jangan: mesin hitung dan siklus run payroll, PPh 21 (sudah ada), refund, akses Owner/platform, Better Auth, edge, UI.
Migrasi: 0167, `when` 1794246000000. Satu berkas migrasi saja.

## Bukti selesai
- Test isolasi tenant (RLS) tiap tabel baru, enkripsi nominal (tidak terbaca mentah di DB), immutabilitas tarif yang sudah dipublish, validasi dan izin tiap route.
- `LEGEND_TEST_FILES` daftar eksplisit (path `src/test/...`) lewat `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="..." pnpm test'`, sertakan `src/test/edge-received-events-migration.test.ts` dan `src/test/migration-fk-force-rls.test.ts`; `db:generate` harus kosong.
- tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh.
- Review K: subagent reviewer Opus + architect paralel. Brief Codex `docs/briefs/237b-second-opinion-payroll-schema.md` (tidak di-commit).

## Laporan
Sekali: tabel dan route yang dibangun vs sudah ada, bukti, file berubah, SHA, nomor migrasi, kartu sisa, risiko tersisa, jumlah subagent dan puncak bersamaan. Jangan menunggu proses global atau loop sleep. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
