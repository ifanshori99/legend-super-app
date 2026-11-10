# Brief: second-opinion — laporan, metrik, dan audit viewer (ws11-reports, brief 93)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti. Read-only: jangan edit atau commit.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/prep-ws11-reports`, cabang `prep3/ws11-reports` HEAD `008191aa` (isi `ws/ws11-reports` c32c97b1, rantai tanpa ws02-edge). Cabang ini BELUM digabung ke `milestone/m1`; tidak ada migration.
Rentang diff: `git diff 13425b65 008191aa` (merge-base dengan m1; 124 file; abaikan snapshot besar dan fixture). Jangan pakai `merge-base main`. Brief engineer asal: `docs/briefs/93-ws11-reports.md`.

## Berkas berisiko
- `apps/api/src/services/metrics-query.service.ts`, `metrics-gl-sources.ts`
- `apps/api/src/routes/metrics.routes.ts`
- `apps/api/src/services/audit-events.service.ts`, `apps/api/src/routes/audit-events.routes.ts`
- Unduhan dokumen pemegang saham (shareholder document download)
- `packages/shared/src/dashboard/*`, `packages/shared/src/metrics/*`

## Fokus (auth, uang, data pribadi)
- Otorisasi tiap endpoint metrik, audit, dan unduhan dokumen: peran yang benar, tenant dan outlet dipaksa di server; pemegang saham hanya melihat data yang memang haknya.
- Query metrik di atas jurnal GL: angka integer IDR, cakupan outlet (tidak ada fallback ke semua outlet untuk pengguna satu outlet), sub-rentang tanggal, dan lintas bulan benar; tidak ada kebocoran lintas tenant lewat parameter query.
- Audit viewer: hitungan stok buta (blind count) tidak membocorkan selisih ke peran yang tidak berhak (fix `legend-zbzr`, `legend-j5x`); payload audit tidak memuat data pribadi atau rahasia mentah.
- Unduhan dokumen: tautan atau id tidak bisa ditebak lintas tenant (IDOR), header dan nama berkas aman, tercatat di audit.
- Jadwal laporan dan penerima: alamat email penerima tidak masuk log dan tervalidasi.
- Paginasi dan batas query: tidak ada dump tak terbatas.
- Test membuktikan klaim.

## Effort
high.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal konkret, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
