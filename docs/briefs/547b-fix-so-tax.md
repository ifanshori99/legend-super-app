# 547b Fix temuan second-opinion Codex pajak (ws/ws07-tax-reports)
Peran: engineer. Worktree .worktrees/ws07-tax-reports. Test gagal-dulu tiap temuan, commit per temuan, jangan merge.
- P1 `apps/api/src/services/accounting-auto-journal-tax-split.ts:362`: net Rp100.000 + pajak Rp10.000, refund Rp36.670 + Rp36.670 + Rp36.660 -> pembulatan pajak Rp10.001, cap memarkir seluruh jurnal ketiga walau total Rp110.000 sah (kas/pendapatan hilang Rp36.660). Fix: alokasi komponen dari saldo tersisa / delta kumulatif; test tiga refund itu (total pajak dikembalikan = Rp10.000 tepat, jurnal seimbang).
- P2 `:166`: cap memakai mapping akun terkini; setelah mapping PBJT A->B, pungutan terbaca nol, refund sah diparkir permanen. Fix: identitas akun pajak historis penjualan untuk cap dan posting refund.
- P2 `packages/shared/src/accounting/statements.ts:557`: beli aset Rp1.000.000 (kas Rp100.000 + utang Rp900.000) -> investasi -1.000.000, operasi +900.000. Fix: keluarkan komponen nonkas; investasi -100.000.
- P2 `apps/api/src/services/accounting-ap.service.ts:169`: invoice PPh 23 menerima NPWP kosong, snapshot immutable, tidak bisa dibetulkan. Fix: tolak posting tanpa NPWP pemasok; koreksi diaudit untuk data lama.
- P2 `apps/api/src/services/accounting-statements.service.ts:74`: status periode dan ledger dibaca terpisah -> label closed_snapshot dengan angka baru. Fix: satu transaksi REPEATABLE READ.
- Sekalian kartu legend-0af6c: PPh 21 karyawan tanpa NPWP pakai NIK; tolak bila keduanya kosong.
Bukti: test terarah via heavy, tsc api/shared, eslint/prettier. Lapor dengan angka subagent.
