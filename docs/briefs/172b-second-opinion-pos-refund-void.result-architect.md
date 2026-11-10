# 172b hasil architect 1 (review ganda Claude, brief 225)

Kode: `milestone/m1` 94d769c6. Kartu: legend-a0i7, legend-ioyg (review).

Hasil: **Bersih** (tidak ada P1/P2 baru).

## Invariant
1. Retur bertahap = sekaligus: `crm-promo-refund.ts:615-671` menghitung diskon yang dipertahankan per baris dari himpunan item yang disimpan saja (`min(share, original, recheck)`, original dari evaluasi checkout), dan `pos-order-corrections.ts:713-750` menghitung kewajiban kumulatif `paidIn - refunded - keptPayableBill`; jumlah di bawah kewajiban ditolak 422 `REFUND_AMOUNT_BELOW_DUE`, di atasnya dipotong. Hasil akhir hanya bergantung pada himpunan item yang disimpan. Contoh: total 100.000, DP 30.000, tender 70.000, item A 60.000 dan B 40.000: A lalu B = 60.000 + 10.000, B lalu A = 40.000 + 30.000, sekaligus = 70.000; ketiganya 70.000 dari tender, sisa 30.000 di DP (`depositOwedIdr`).
2. Tidak ada sisa terkunci: setelah semua item kembali `keptPayableBill = 0`, jadi refund = sisa tender. Bila baris lama membayar kurang, pelunasan tanpa item (`pos-order-corrections.ts:637-647`) membayar sisanya.
3. `spent_idr`: penurunan dan kenaikan per baris di `order-promo-refund.ts:104-238` (naik dibatasi sisa budget, kekurangan diaudit `budgetShortIdr`); `spent_idr` tetap menghitung setiap baris applied, jadi void penuh berikutnya tidak membuatnya negatif. Void sesudah refund apa pun ditolak (`pos-order-corrections.ts:214`).
4. Jumlah baris applied = `total_discount_idr` kecuali kenaikan terpotong budget (diaudit).
5. Void: `pos-order-corrections.ts:266-277` menolak tender captured/authorized non-tunai (qris, va, ewallet, card, edc_card, edc_qris, points). Status lain (`failed`, `voided`) tidak memegang uang. Void DP ditolak (228). Tunai yang dikembalikan = tender tunai captured = total (tender menyimpan nilai yang diterapkan, bukan uang yang diserahkan).
6. Penolakan melempar di dalam satu transaksi `withTenant` + `posIdempotent` (tanpa catch), jadi baris refund, promo, budget, persetujuan tidak tertulis.

## Catatan P3 (tidak dibuat kartu)
1. `crm-promo-refund.ts:528-531`: promo yang gugur mengurangi `spent_idr - discount_idr` tanpa `GREATEST(…,0)`. Aman selama invariant 3 terjaga; data lama yang menyimpang membuat refund gagal oleh CHECK (refund tertahan, bukan uang hilang). Saran: pakai GREATEST dan audit selisihnya, seperti `order-promo-refund.ts:226`.
2. Promo pra-snapshot (tanpa `rules_snapshot`) dihitung ulang dengan aturan hari ini (`crm-promo-refund.ts:375-388`); hasil tetap dibatasi `min(share, original)`, jadi selisihnya paling besar bagian pro-rata. Sudah tercatat sebagai perilaku terdokumentasi.
