# Second opinion (Codex): refund POS berpromo dan baris refund per tender (brief 186)

Tingkat K (uang). Baca saja; jangan edit. Laporkan temuan nyata dengan path:line, contoh angka Rupiah, dan langkah reproduksi.

## Lokasi
- Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-refund-promo`, cabang `ws/pos-refund-promo` (dasar `milestone/m1` 9a2c1e86). Diff: `git diff milestone/m1...ws/pos-refund-promo`.
- File utama: `apps/api/src/services/pos-order-corrections.ts` (`refundPosOrder`, `refundLinesByTender`, `stillRefundableByMethod`, `correctionsOf`).
- Pendukung: `apps/api/src/services/crm-promo-refund.ts` (hitung ulang promo), `packages/shared/src/pos/schemas.ts` (`posRefundLineSchema`), `apps/api/src/db/schema/pos-order.ts` (`PosRefundLineRow`), `apps/api/src/services/pos-order-support.ts` (daftar kunci audit).
- Test: `apps/api/src/test/pos-refund-promo-db.test.ts` (describe `legend-186`, `legend-wkl3`).

## Aturan bisnis (founder)
- F&B: retur per menu yang habis atau salah boleh. Q30 = A: kembalikan uang menu itu saja; selisih promo kecil diterima.
- Item gratis yang dikembalikan tidak menghasilkan uang (Q19). Retur Rp0 tetap dicatat sebagai baris refund Rp0 (tanpa baris pembayaran, tanpa event `order.refunded`, tanpa jurnal).
- Diskon yang tetap dipegang item yang disimpan: min(subtotal yang disimpan, pro-rata, diskon promo bila dihitung ulang atas item yang disimpan).

## Perubahan yang perlu diuji
1. Refund tanpa item pada pesanan berpromo kini menjadi pelunasan: membayar `min(jumlah diminta, sisa jatuh tempo, sisa di tender)`. Bila tidak ada yang jatuh tempo: 422 `REFUND_NOTHING_DUE`. Bila hitung ulang menggugurkan promo: 409.
2. Pesanan dengan DP: bila tender sudah habis tetapi tamu masih berhak atas uang, retur item dicatat Rp0 dan audit mencatat `depositOwedIdr`. DP tidak dikembalikan lewat POS.
3. Baris refund mencatat `tenderId` dan `paymentIntentId`. Total per metode tetap dari `refundAllocation` lama, lalu dibagi FIFO per tender. Baris lama tanpa `tenderId` diputar ulang FIFO. Event tetap satu baris per metode, tanpa id.

## Pertanyaan yang ingin dijawab
- Adakah jalur yang membayar lebih dari yang dibayar tamu, atau membuat item gratis menghasilkan uang?
- Bisakah pelunasan tanpa item dipakai untuk menarik uang yang tidak terutang (misalnya setelah promo diedit atau anggaran promo berubah)?
- Apakah pembagian FIFO per tender bisa mengatribusikan uang ke tender yang sudah habis, atau membuat total per metode berbeda dari sebelumnya?
- Apakah ada pembaca `pos_order_refunds.lines` (rekap harian, shift, laporan, payout intent) yang rusak karena kini ada beberapa baris per metode?
- Apakah aturan DP bisa menyembunyikan uang yang seharusnya dibayar tunai ke tamu?
