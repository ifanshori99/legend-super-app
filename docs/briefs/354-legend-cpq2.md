# legend-cpq2: QR guest read models

Peran: engineer (baca berkas peran dan "Paralel dulu" di TEAM.md). Tingkat S: satu reviewer sonnet.
Basis: `git worktree add .worktrees/cpq2-qr-read-models -b ws/cpq2-qr-read-models milestone/m1` (29ddcbf7). Push cabang kerja ke origin tiap commit. Jangan push main, jangan --force.

## Kerja
Ikuti `bd show legend-cpq2`. Suggestions dan payment status sudah ada (routes/qr-order.routes.ts:254, :211). Sisa dipecah ke legend-4qls, legend-n1mp, legend-541h: kerjakan ketiganya di cabang ini bila tidak saling menunggu, lalu tutup cpq2.
1. Cek dulu apa yang sudah ada di m1; jangan tulis ulang. Kartu terlalu besar: kerjakan irisan pertama yang utuh, buat kartu bd untuk sisanya.
2. Test gagal-dulu tiap butir.
3. Typecheck dan test terarah lewat `heavy`. Typecheck gagal lebih dari 2 kali berturut: berhenti dan lapor. Review, temuan nyata dibetulkan.
4. Commit, push, `bd comment legend-cpq2`, update `docs/PROGRESS.md`.

Migrasi bila perlu: nomor sementara 0236, `when` 1794341000000, FK inline di CREATE TABLE (tanpa angkat NO FORCE), migrator non-superuser. Edit pakai tool Edit, bukan sed. Jangan pkill proses lain. Stempel waktu pakai `date`.

## Laporan
Sekali di akhir: SHA, test gagal-dulu, temuan review, kartu sisa.
