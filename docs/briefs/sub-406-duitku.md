# Sub-brief 406: perbaikan temuan Codex Duitku (legend-s0u8c)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/duitku-406`, cabang `ws/duitku-406`. Selalu `cd` ke sana dulu dan cetak `pwd`.
Temuan: `docs/briefs/406-second-opinion-duitku-rerun-hasil.md` (5 temuan, F1..F5).
Commit terkait sebelumnya: `1b301b15` (test race poll/webhook, reservasi, POS), `008cbd93` (paidAt, mismatch held).

## Keputusan tetap
- D-mismatch: nominal callback bertanda tangan != nominal intent => intent ditandai gagal untuk review (bukan `ignored`) + `logger.warn` tanpa rahasia (tanpa signature, merchantKey, payload mentah). Sesuai s5jup D2.
- D-paidAt: paidAt = min(now, receivedAt) hanya bila intent TERKUNCI masih `pending`; status dibaca setelah lock, bukan sebelum panggilan Duitku.
- Satu protokol kunci untuk webhook, poller, pembatalan POS, pembatalan reservasi. Urutan kunci ditulis di komentar kode + docs.

## Area
- A. `apps/api/src/services/payment.service.ts` (~1325 poller reconcile, ~1683 guard tagihan tertutup).
- B. `apps/api/src/services/payment-duitku-webhook.service.ts` (~375 paidAt, ~388 mismatch).
- C. `apps/api/src/services/payment-late-settlement.ts` (~47 status reservasi tanpa kunci) + jalur pembatalan POS dan reservasi.
- Test: `apps/api/src/test/payment-duitku-webhook.test.ts` (pola race `Promise.all` ~1236), test POS/reservasi late payment yang ada.

## Aturan test
- Gagal-dulu: test harus GAGAL di kode sekarang karena alasan temuan, bukan karena setup.
- Race nyata: dua transaksi DB sungguhan bersamaan (ikuti pola race yang ada, misal tahan satu transaksi dengan barrier/deferred sebelum commit). Unit/integration, bukan e2e.
- Test root/api dijalankan lewat skrip paket (`pnpm --filter api test -- <file>` atau sesuai package.json), `LEGEND_TEST_FILES` bila didukung. Jangan `node --test` langsung.
- Jangan ubah kode produksi (test-writer). Jangan sentuh `e2e/`.

## Protokol kunci (keputusan engineer, satu untuk semua jalur)
Urutan: pemilik tagihan (reservations baris deposit, ATAU orders lalu pos_orders) → payment_links (bill) → payment_intents (id naik) → funds/refunds.
- Settlement (webhook via confirmPayment, poller via applyConfirmation, hold mismatch): kunci pemilik tagihan DULU (helper baru `lockBillOwner(tx, context, linkId)` di `payment-late-settlement.ts`: reservations WHERE depositPaymentLinkId=link FOR UPDATE; orders yang terkait link — orders.paymentLinkId atau via pos_order_tenders — FOR UPDATE ORDER BY id), lalu link, lalu intent. Baca status bisnis setelah kunci.
- Pembatalan POS: sudah orders → pos_orders → link. Pastikan semua jalur void yang meninggalkan intent pending tetap memegang kunci order sampai commit (sudah lewat mutatePosOrder).
- Pembatalan reservasi: reservation (lockReservation) → link FOR UPDATE → cek ulang intent di link itu: ada yang `paid` → jangan pakai jalur deposit-belum-bayar (pakai jalur deposit terbayar bila depositPaymentId ada, atau tolak 409 agar dicoba ulang setelah consumer). Lalu `cancelPaymentLinkInTx` untuk expire intent pending.
- Komentar urutan kunci ditulis di `payment-late-settlement.ts` (sumber utama) dan dirujuk dari applyConfirmation, closeReservation, voidPendingQrisTenders. Docs: tambah bagian "Urutan kunci pembayaran" di docs pembayaran yang ada (cari `docs/*payment*`).

## Kontrak antar-berkas
- (A) `payment.service.ts`:
  - applyConfirmation: panggil `lockBillOwner` sebelum kunci link. Guard `billClosedForLateSettlement` berlaku untuk status `pending` JUGA (bukan hanya failed/expired) saat `closedIntentNeedsOpenBill`.
  - Intent yang ditahan mismatch (penanda di `flags` atau kolom yang ada; tentukan sendiri, migrasi hanya bila perlu, nomor 0274-0275, `when` > 1794470000000) → applyConfirmation menolak `AMOUNT_MISMATCH` (pemanggil memarkir dana).
  - Ekspor `holdGatewayAmountMismatch(context, intentId, input: { providerRef, paidAmountIdr, eventId?, source: "webhook"|"gateway_status" }, now)`: dalam satu tx dengan urutan kunci di atas; intent belum paid → set `failed` + penanda tahan mismatch + event; selalu catat dana unsettled (`recordUnsettledGatewayFunds` atau setara dalam tx); kembalikan `{ held: boolean, intentStatus }`. Poller (`assertStrictAmount` gagal) juga memanggil ini.
  - paidAt: confirmation menerima `receivedAt?: Date`; applyConfirmation memilih paidAt dari status TERKUNCI: pending → min(now, receivedAt ?? now), selain itu now. Poller: sama (tanpa receivedAt = now).
- (B) `payment-duitku-webhook.service.ts`: cabang mismatch nominal → `holdGatewayAmountMismatch(..., source:"webhook")`, baris webhook `failed` kode `REJECTED_AMOUNT_MISMATCH` (bukan `ignored`), `logger.warn({ intentId, eventId, code })` tanpa rahasia/payload. paidAt: hapus pilihan pra-panggilan (`plausiblePaidAt` 375-381) → kirim `receivedAt: row.receivedAt` ke confirmPayment.
- (C) reservasi (`reservation-lifecycle.ts`, `reservation-core.ts`) + bila perlu `pos-order-payment.ts`: protokol pembatalan di atas.
