# Brief: ws/finance-followups (3 kartu, backend, tanpa migrasi, tanpa UI)

Repo worktree: /Users/ifanshori99/Projects/legend super app/legend-e112ed7c, cabang ws/finance-followups (dari origin/milestone/m1). Test API di `apps/api/src/test/`.

## Kartu
1. legend-qsgg3: `reverseJournalInTransaction` (apps/api/src/services/accounting-journal.service.ts ~896) hanya menolak reversal atas reversal. Perbaikan: tolak reversal manual untuk jurnal yang dirujuk `fixed_asset_depreciations` atau `fixed_asset_depreciation_reversals` (jurnal run asli dan jurnal koreksi penyusutan). Jalur internal reversal penyusutan (service aset tetap) harus tetap berjalan: pembeda jalur manual vs internal harus jelas. Error pakai HttpError yang sudah ada di service itu.
2. legend-ym2kr: kas keluar (`cash_movement`) yang ditahan `needsApproval` tidak memancarkan `cash_movement.recorded`, jadi setelah disetujui jurnal tidak pernah dibukukan. Perbaikan: pembukuan terjadi tepat saat disetujui (bukan saat ditahan), idempoten lewat kunci `aj:cash-movement:<id>`, tidak dobel, tidak dibukukan bila ditolak. Cari aturan posting auto-journal cash_movement.recorded yang sudah ada (temuan legend-89pn).
3. legend-4lft: `accounting-period-close.service.ts:199` `cumulativeBalances` memakai `idr(Number(sum))` yang melempar di atas 2^53. Pakai konversi aman bigint/numeric, bukan float, tanpa pembulatan.

## Aturan uang
Test wajib membuktikan: jurnal tetap seimbang (debit = kredit), tidak ada kas keluar terbukukan tanpa persetujuan, saldo tidak terpotong/membulat (>2^53). Ragu soal aturan akuntansi: berhenti dan lapor. Tanpa migrasi (bila perlu, berhenti dan lapor).

## Aturan kerja
- Test gagal-dulu terarah: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` dari root worktree. Hanya satu subagent menjalankan test/tsc pada satu waktu.
- ID di test: ikuti helper/brand proyek (ULID bila diminta), jangan `as` literal brand.
- Jangan commit; engineer yang commit.
