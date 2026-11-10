# legend-94q2l: konsumen manual_refund_approved — keputusan desain tertahan

Status: belum ada kode. Berhenti sebelum implementasi karena butuh keputusan desain uang/jurnal (tingkat K).

## Temuan
- `refundableBalance` (payment-admin.service.ts) menahan seluruh total-DP penjualan QR pay-first yang sudah fired (`qrSaleInUseOfIntent`). Cap = 0 untuk order lunas, jadi refund intent biasa untuk satu baris ditolak (`cap_exceeded` saat approve). `createRefund` juga menolak intent bersumber dokumen (`REFUND_SOURCE_DOCUMENT`).
- Order POS (`pos_orders` ada) memakai `refundPosOrder` (shift, laci, approval, promo): terlalu berat untuk konsumen sistem.
- Event hanya membawa `amountIdr` = `lineTotalIdr` (sebelum service charge, PBJT, diskon).

## Rancangan architect (subagent, 10 Nov 2026)
Usulan "kurangi hold dengan refund ber-order_issue_id saja" TIDAK aman: payout mendebit `customer_deposit` padahal `order.paid` sudah memindahkan uang ke pendapatan; guard jurnal `backedIdr` gagal atau saldo negatif. Perlu meniru model POS:
1. Migrasi 0222 (when 1794301000000): `payment_refunds.order_issue_id uuid` + unique parsial `(tenant_id, order_issue_id) WHERE order_issue_id IS NOT NULL AND status <> 'failed'`.
2. `systemRefundActorSchema` (packages/shared/src/payment/admin.ts): tambah `system:recovery`.
3. Konsumen baru `services/order-recovery-refund.ts` di worker-main.ts, satu transaksi di bawah `lockIntentsForFact`: clamp `min(line, due - sudah dilepas)`, audit selisih; append event `order.refunded` (refundId = orderIssueId, grossSalesIdr = refundGatewayIdr = amt, lainnya 0) untuk membalik pendapatan; buka refund dengan kunci `order-recovery-refund:<issueId>`.
4. `qrSaleInUseOfIntent` cabang pinned: `greatest(due - released_o, 0)`; released dari DISTINCT order_issue_id, status apa pun.
5. `accounting-auto-journal-guards.ts` `qrSales`: kurangi released hanya bila jurnal `order.refunded` sudah posted; pending memberi `backingPending`; tambah Backing kind `qrRefund`.
6. Four-eyes: approver payout bukan resolver issue dan bukan approver ORD-09.
- Order POS: tidak buka refund; audit `order_issue.refund_routed_pos`, kasir pakai `refundPosOrder`.
- open_bill tanpa `pos_orders`: refund biasa tanpa `order.refunded`. Tanpa intent: audit saja. Split bill: tolak dan audit.
- Cek konsumen loyalty dan pos-shift untuk `order.refunded` menerima refundId non-POS.

## Keputusan founder/finance
Nominal = harga baris sebelum service charge dan PBJT. PBJT tetap terlalu besar dan tamu dapat nominal pra-pajak. Perlu aturan: nominal dengan pajak/service pro-rata atau tidak.
