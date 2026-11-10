# legend-gmww: persist accounting contract deltas

Peran: engineer (baca berkas peran dan "Paralel dulu" di TEAM.md). Tingkat K: satu subagent architect review.
Basis: `git worktree add .worktrees/gmww-accounting-deltas -b ws/gmww-accounting-deltas milestone/m1` (29ddcbf7). Push cabang kerja ke origin tiap commit. Jangan push main, jangan --force.

## Kerja
Ikuti `bd show legend-gmww`. Audit: bank_statement_imports dan gl_account_id sudah ada di 0191. Sisa kemungkinan cash_deposits (covers_from, slip_reference), tax_reports, reconciliation_cases. Ikuti kontrak akuntansi di packages/shared.
1. Cek dulu apa yang sudah ada di m1; jangan tulis ulang. Kartu terlalu besar: kerjakan irisan pertama yang utuh, buat kartu bd untuk sisanya.
2. Test gagal-dulu tiap butir.
3. Typecheck dan test terarah lewat `heavy`. Typecheck gagal lebih dari 2 kali berturut: berhenti dan lapor. Review, temuan nyata dibetulkan.
4. Commit, push, `bd comment legend-gmww`, update `docs/PROGRESS.md`.

Migrasi bila perlu: nomor sementara 0235, `when` 1794340000000, FK inline di CREATE TABLE (tanpa angkat NO FORCE), migrator non-superuser. Edit pakai tool Edit, bukan sed. Jangan pkill proses lain. Stempel waktu pakai `date`.

## Laporan
Sekali di akhir: SHA, test gagal-dulu, temuan review, kartu sisa.
