# legend-tct8: config bundle section codecs per domain (TEN-09)

Peran: engineer (baca berkas peran dan "Paralel dulu" di TEAM.md). Tingkat S: satu reviewer sonnet.
Basis: `git worktree add .worktrees/tct8-config-codecs -b ws/tct8-config-codecs milestone/m1` (29ddcbf7). Push cabang kerja ke origin tiap commit. Jangan push main, jangan --force.

## Kerja
Ikuti `bd show legend-tct8`. Belum ada codec toTemplate/fromTemplate. File utama platform/config.ts. Rancang pola codec satu kali, kerjakan 2-3 domain pertama, sisanya kartu per domain.
1. Cek dulu apa yang sudah ada di m1; jangan tulis ulang. Kartu terlalu besar: kerjakan irisan pertama yang utuh, buat kartu bd untuk sisanya.
2. Test gagal-dulu tiap butir.
3. Typecheck dan test terarah lewat `heavy`. Typecheck gagal lebih dari 2 kali berturut: berhenti dan lapor. Review, temuan nyata dibetulkan.
4. Commit, push, `bd comment legend-tct8`, update `docs/PROGRESS.md`.

Migrasi bila perlu: nomor sementara 0237, `when` 1794342000000, FK inline di CREATE TABLE (tanpa angkat NO FORCE), migrator non-superuser. Edit pakai tool Edit, bukan sed. Jangan pkill proses lain. Stempel waktu pakai `date`.

## Laporan
Sekali di akhir: SHA, test gagal-dulu, temuan review, kartu sisa.
