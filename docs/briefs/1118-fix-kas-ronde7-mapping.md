# 1118 Perbaikan SO kas ronde 7: kasbon Dr1102/Cr1102 (tingkat K uang)
Peran: engineer (`~/.agents/team/roles/engineer.md`). Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang `ghostex/cek-kas-1102-pinjaman-reimburse-supplier` (head 5c06f743c), worktree `legend-bb6a2919`. Laporan SO: `docs/qa/second-opinion-kas-payout-ronde7-1115.md` (P1-1: bukti rantai, skenario). Push tanpa `--force`. Tanpa migrasi bila bisa; bila perlu, pakai nomor sesudah yang terakhir di cabang dan lapor.

## Keputusan CTO (membatasi; tutup kelasnya)
1. Validasi mapping (`packages/shared/src/accounting/coa.ts` `accountMappingIssues`, dipakai `accounting-accounts.service.ts`): satu akun TIDAK boleh dipetakan ke dua role bila salah satunya role kas/bank (petty_cash, cash, bank, dan role kas lain di COA). Tolak dengan kode error jelas. Ragu apakah role termasuk kas = tolak.
2. Poster jurnal (`accounting-journal.service.ts` jalur posting rule): jurnal yang mendebit dan mengkredit akun yang sama dalam satu entri ditolak (gagal tertutup; event tetap pending/gagal, tidak `posted`), supaya mapping lama yang sudah salah tidak bisa melepas cadangan.
3. Cadangan kas (`accounting-petty-cash.service.ts`): cadangan kasbon hanya dilepas bila jurnal yang terposting benar-benar mengurangi akun kas secara neto sebesar pokok; selain itu tetap dihitung sebagai cadangan.
4. Gerbang rilis: tambah cek read-only (pola `release-gates`/predeploy bila ada di cabang ini; bila tidak, query di `docs/deployment.md`) = 0 baris mapping akun ganda role kas.

## Bukti
Test integrasi skenario SO (GL dan kas 1102 Rp100.000, mapping employee_receivable->1102, dua kasbon Rp100.000): merah di 5c06f743c, hijau di head (kasbon kedua ditolak / mapping ditolak / jurnal ditolak). Regresi test `cash-1102-*`, payroll-loans, accounting mapping/journal. Typecheck API dan web (shared berubah) sekali lewat heavy (heap 8 GB bila OOM). Prettier/eslint. Architect xhigh delta sekali.

## Laporan
Per keputusan: commit, head SHA, risiko. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
