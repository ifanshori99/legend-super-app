# legend-94q2l implementasi: refund dari approval item gagal (brief subagent)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/94q2l-impl` (cabang `ws/94q2l-impl`). Jangan checkout folder lain, jangan commit, jangan push. Latar: `docs/briefs/94q2l-design-blocker.md`. Tingkat K (uang + migrasi). Edit hanya file di slice-mu.

## Alur

`resolveOrderIssue` (order-recovery.service.ts:~1510) menulis event `order_issue.manual_refund_approved` (payload `packages/shared/src/qr-order/events.ts:167`: orderId, orderItemId, orderIssueId, amountIdr=lineTotalIdr, approvalRequestId, approvedBy = approver ORD-09, reason). `event.actor` = `{type:"user", id: resolver}`. Konsumen baru membuka refund pembayaran untuk baris itu.

## Kontrak bersama (semua slice pakai nama ini persis)

- Kolom: `payment_refunds.order_issue_id uuid` NULL, Drizzle `paymentRefunds.orderIssueId`. Unique parsial `payment_refunds_order_issue_unique` pada `(tenant_id, order_issue_id) WHERE order_issue_id IS NOT NULL AND status <> 'failed'`.
- Aktor sistem `system:recovery` (`systemRefundActorSchema`, packages/shared/src/payment/admin.ts) + nama tampilan.
- Kunci idempotensi admin `order-recovery-refund:<orderIssueId>` (prefix masuk `SYSTEM_KEY_PREFIXES`, payment-admin-idempotency.ts). `request` = `{orderIssueId, paymentIntentId, resolvedBy, approvedBy}`; `response` = `{refundId: string|null, resolvedBy, approvedBy}`.
- Fungsi murni `recoveryRefundSplit` di `apps/api/src/services/order-recovery-refund-amount.ts`:
  ```ts
  export function recoveryRefundSplit(input: {
    order: OrderRevenueInput & { depositAppliedIdr: number }; // order-revenue.ts
    lineTotalIdr: number;
    releasedIdr: number; // sudah dilepas issue lain di order ini
  }): {
    wantedIdr: number;
    amountIdr: number;
    shortfallIdr: number;
    grossSalesIdr: number;
    discountIdr: number;
    serviceChargeIdr: number;
    pbjtIdr: number;
  };
  ```
  Pro-rata (keputusan CTO, bisa diganti founder ke "harga baris saja"): `s = lineTotalIdr / subtotalIdr`. Dari `orderRevenueSplit(order)`: tiap komponen (gross, discount, service, pbjt) × s, dibulatkan half-up dengan BigInt. `wantedIdr = gross - discount + service + pbjt` (rounding kas order tidak ikut). `room = max(0, (totalIdr - depositAppliedIdr) - releasedIdr)`. `amountIdr = min(wanted, room)`, `shortfallIdr = wanted - amountIdr`. Bila dipotong: skala discount/service/pbjt dengan `amountIdr/wantedIdr` (half-up), gross = sisa supaya `gross - discount + service + pbjt = amountIdr`; tidak ada komponen negatif. Subtotal 0 atau lineTotal <= 0: semua 0. Contoh: subtotal 100.000, discount 0, service 5% = 5.000, PBJT 10% dari 105.000 = 10.500, total 115.500; baris 40.000 -> gross 40.000, service 2.000, pbjt 4.200, wanted 46.200.
- Konsumen `deliverOrderRecoveryRefundEvent(context, event, tx)` di `apps/api/src/services/order-recovery-refund.ts`, dipanggil di `worker-main.ts` tepat setelah `deliverSwapKitchenEvent` (pola sama: `services/order-recovery-swap-kitchen.ts`). Abaikan event lain, tenant lain, outlet beda, payload tidak valid. Kunci baris `order_issues` FOR UPDATE, lalu `orders` FOR UPDATE (urutan ini). Issue harus `status='resolved'`, `resolution='manual_refund'`.
  Cabang (audit `objectType:'order_issue'`, `objectId` = issue id, actorType system):
  1. Order punya baris `pos_orders`: tidak buka refund; audit `order_issue.refund_routed_pos` (kasir pakai `refundPosOrder`).
  2. Split bill (intent order punya `bill_split_id`, atau order punya lebih dari satu intent dibayar / bill split): tolak; audit `order_issue.refund_blocked` `blockedReason:'split_bill'`.
  3. Tanpa intent (`orders.payment_intent_id` null): audit `order_issue.refund_blocked` `blockedReason:'no_intent'`.
  4. Intent belum settled (bukan paid/partially_refunded atau `paid_at` null): audit `refund_blocked` `blockedReason:'intent_not_settled'`.
  5. QR `pay_first` fired tanpa pos_orders: `lockIntentsForFact` (payment-refund-fact-time.ts) pada intent; `releasedIdr` = jumlah refund ber-`order_issue_id` issue lain di order ini (distinct per issue, status apa pun, max amount per issue); `recoveryRefundSplit`; shortfall > 0 -> audit `order_issue.refund_shortfall`; amount 0 -> audit `refund_blocked` `blockedReason:'nothing_left'`, selesai. Dalam `idempotentPaymentAdminWrite(tx, context, "system:recovery", key, "refund.create", request, run)`: (a) `appendPosEvent(tx, context, "order.refunded", {order, payload, caller:null, now})` seperti `qr-order-paid.ts` dengan payload: orderId, outletId, businessDate, `refundId = orderIssueId`, amountIdr, reason `"other"`, reasonNote = alasan issue, approvedBy = approver ORD-09, overrideId null, approvalRequestId, gross/discount/service/pbjt dari split, refundGatewayIdr = amountIdr, cash/edc/points 0, `lines:[{method: qrTenderMethod(intent.method), amountIdr}]`, refundedAt. (b) insert `payment_refunds` (`requestedBy:'system:recovery'`, `orderIssueId`, `reason:'Refund item gagal (ORD-09)'`, amount), `openRefundChainSafely`, audit `payment.refund_requested`, `appendPaymentEvent` `payment.refund_requested` (tiru `pos-refund-gateway.ts`), audit `order_issue.refund_requested`.
  6. `open_bill` tanpa pos_orders, intent settled: refund biasa TANPA `order.refunded`; amount = min(wanted, cap - reserved dari `refundableBalance`), shortfall diaudit; kunci dan audit sama.
     Ulangan event / event kedua: tidak ada refund ganda (kunci idempotensi + unique index). Kesalahan teknis dilempar (outbox retry); kondisi bisnis tidak dilempar.
- Hold (payment-admin.service.ts `qrSaleInUseOfIntent`): cabang pinned jadi `greatest(o.total_idr - o.deposit_applied_idr - released_o, 0)`, `released_o` = sum per distinct `order_issue_id` (max amount) refund yang `order_issue_id`-nya milik issue order `o`, status apa pun.
- Guard jurnal (`accounting-auto-journal-guards.ts` `qrSales`, ~:785): kurangi released per issue HANYA bila jurnal `order.refunded` issue itu posted; masih di outbox/parked retryable -> `backingPending`. Tambah Backing kind `{kind:"qrRefund"; refundId: string}` (refundId = orderIssueId) dengan key `aj:order-refund:<id>` dan pending dari outbox `order.refunded` `payload.refundId`.
- Four-eyes (payment-refund.service.ts): perluas `isPosRefundParty` (atau fungsi baru dipanggil di semua tempat yang sama: :382, :1055, :1225, :1495, :1518): untuk `requestedBy==='system:recovery'`, pihak = `order_issues.approved_by` (lewat `refund.orderIssueId`) + `resolvedBy`/`approvedBy` dari baris idempotensi `key LIKE 'order-recovery-refund:%' AND response->>'refundId' = refund.id`. Gagal tertutup: tidak terbaca = semua dianggap pihak.

## Slice

- I1 migrasi+skema: `apps/api/drizzle/0222_payment_refund_order_issue.sql` (+ `meta/_journal.json` entri idx 222, `when` 1794301000000, + `meta/0222_snapshot.json`), `apps/api/src/db/schema/payment-admin.ts`, `packages/shared/src/payment/admin.ts`, `apps/api/src/services/payment-admin-idempotency.ts`. Cara: ubah skema, `pnpm db:generate` (perlu DB dev? kalau tidak bisa, tulis SQL+snapshot tangan dari snapshot terakhir), ganti nama ke 0222 + set `when`, `db:generate` kedua harus kosong. FK `order_issue_id` -> `order_issues` (pakai komposit tenant bila order_issues punya unique `(tenant_id,id)`), harus jalan sebagai migrator non-superuser di tabel FORCE RLS: pola `git show 9e3d3928 -- apps/api/drizzle/0219_profit_share.sql` (NO FORCE, FK, FORCE lagi) dan `docs/plan/contracts.md` pola 2.
- I2 konsumen: `order-recovery-refund-amount.ts`, `order-recovery-refund.ts`, `worker-main.ts` (satu baris panggilan + import).
- I3 hold+four-eyes: `payment-admin.service.ts`, `payment-refund.service.ts`.
- I4 guard: `accounting-auto-journal-guards.ts`.
- T1 test: `apps/api/src/test/order-recovery-refund-amount.test.ts` (murni) dan `apps/api/src/test/order-recovery-refund.test.ts` (konsumen, DB; helper `order-recovery-helpers.ts`, pola `order-recovery-paid-intent.test.ts` dan test swap kitchen): tiap cabang 1-6, idempotensi (event diulang dan event kedua untuk issue sama), shortfall, payload `order.refunded` di outbox, hold dilepas (`refundableBalance` cap naik sebesar amount).
- T2 test: `apps/api/src/test/order-recovery-refund-four-eyes.test.ts`: approver payout = resolver ditolak, = approver ORD-09 ditolak, orang ketiga dengan `payment.reconcile` boleh; guard `qrSales` hanya mengurangi setelah jurnal `order.refunded` posted (pending -> backingPending).

## Bukti

Tes: `LEGEND_TEST_FILES="src/test/<file>.test.ts" pnpm test` dari root worktree (butuh Docker; jalankan lewat `heavy` bila hook minta). Typecheck api: `heavy pnpm --filter @starter/api typecheck`. Jangan jalankan suite penuh. Laporkan file berubah + ringkas.

## Putaran 2: temuan architect (10 Nov 2026)

- R1 (I2, High): refund `system:recovery` yang `failed` dengan alasan selain `rejected` (approval_expired, approver_unauthorized, cap_exceeded, provider_declined, source_document) dibuka ULANG otomatis. Fungsi ekspor `refileRecoveryRefundAfterFailure(tx, context, failedRefund, now)` di `order-recovery-refund.ts`; dipanggil di `failRefund` (`payment-refund.service.ts`) setelah `refileQrLatePaymentAfterFailure`, lewat lazy `await import(...)` (siklus impor). Syarat: `requestedBy==='system:recovery'`, `orderIssueId` ada, belum ada refund hidup (status <> failed) untuk issue itu. Nominal = nominal refund yang gagal (TANPA `order.refunded` baru: pendapatan sudah dibalik). Kunci `order-recovery-refund:<issueId>:<failedRefundId>`, response `{refundId, resolvedBy, approvedBy}` disalin dari baris idempotensi asli `order-recovery-refund:<issueId>`; baris asli tidak ada = tidak re-file, audit `order_issue.refund_refile_blocked`. Lalu `openRefundChainSafely`, audit `payment.refund_requested` + `order_issue.refund_refiled`, event `payment.refund_requested`. Alasan `rejected`: tidak re-file, audit `order_issue.refund_rejected` (keputusan CTO menyusul).
- R2 (I2): `isRecoveryRefundParty` cari baris idempotensi dengan kunci tepat `order-recovery-refund:<refund.orderIssueId>` atau `LIKE 'order-recovery-refund:<orderIssueId>:%'` + `response->>'refundId' = refund.id` (bukan LIKE global).
- R3 (I1): indeks biasa `payment_refunds_order_issue_idx` pada `(tenant_id, order_issue_id) WHERE order_issue_id IS NOT NULL` di skema + 0222 (ubah di tempat, snapshot ikut), `db:generate` kedua kosong.
- R4 (I4): `releasedOf` di guard `qrSales` dibatasi waktu fakta seperti `posRefundsAt(bound)` (refund setelah bound tidak dihitung).
- T3 (test): `order-recovery-refund.test.ts`: refund gagal `approval_expired` -> refund baru pending, nominal sama, satu `order.refunded` saja, hold tidak berubah, four-eyes tetap berlaku untuk refund baru; `rejected` -> tidak re-file, audit `order_issue.refund_rejected`; gagal kedua kali -> re-file lagi (kunci beda). Guard: refund setelah bound tidak mengurangi.

## Putaran 3: delta architect

- R5 (I2): re-file otomatis HANYA untuk `approval_expired` dan `approver_unauthorized`. `provider_declined`, `cap_exceeded`, `source_document`: tidak re-file, audit `order_issue.refund_refile_blocked` dengan `blockedReason:'failure_needs_person'` + `failureReason` (provider_declined bisa berarti uang sudah terkirim: re-file = payout ganda).
- R6 (I2): batas: issue yang sudah punya >= 3 refund `failed` tidak di-re-file; audit `refund_refile_blocked` `blockedReason:'refile_limit'`.
- R7 (I2): `fileRecoveryRefund` set `createdAt: input.at` (jam fakta sama dengan guard). Komentar kode: re-file memegang kunci intent lalu FK key-share ke `order_issues` (urutan terbalik dari konsumen; deadlock langka, outbox retry).
- T4 (test): re-filed refund (setelah `approval_expired`): approve oleh resolver dan oleh approver ORD-09 -> `APPROVER_IS_REQUESTER`; orang ketiga lolos. `provider_declined` dan `cap_exceeded` -> tidak re-file, audit `failure_needs_person`. 3 kali gagal -> tidak re-file keempat, audit `refile_limit`.

## Putaran 4: refund `rejected` membalik jurnal (keputusan CTO 10 Nov)
Penolakan final. Refund `system:recovery` yang gagal `rejected` (QR pay-first, ada `order.refunded`): jurnal `aj:order-refund:<issueId>` dibalik otomatis (pendapatan, service, PBJT diakui lagi; customer_deposit kembali), idempoten; audit `order_issue.refund_rejected` tetap. Open bill (tanpa `order.refunded`): hanya audit, tidak ada event.
- Event baru `order_issue.refund_reversal_requested` (agregat `order_issue`, aggregateId = issue id), payload strict: `orderId`, `orderIssueId` (uuid), `refundId` (uuid, refund yang ditolak), `amountIdr` (>0), `rejectedAt` (iso). Daftar di `packages/shared/src/qr-order/events.ts` (seperti `order_issue.manual_refund_approved`) dan `packages/shared/src/events/catalog.ts`.
- J1 (implementer): event shared + catalog; `refileRecoveryRefundAfterFailure` cabang `rejected`: bila ada `order.refunded` untuk issue (outbox `order.refunded` dengan `payload.refundId = issueId`), append event itu sekali per issue (cek outbox dulu; pola `appendRecoveryEvent` di order-recovery.service.ts, tulis helper lokal, jangan ekspor ulang). Hold `qrSaleInUseOfIntent` (payment-admin.service.ts): issue yang punya refund `failed` dengan `failure_reason='rejected'` TIDAK dilepas lagi (sale menahan uangnya lagi). File: events.ts, catalog.ts, order-recovery-refund.ts, payment-admin.service.ts.
- J2 (implementer): konsumen auto-journal (`accounting-auto-journal-consumer.ts`, `-amounts.ts`, file baru `accounting-auto-journal-recovery-refund.ts`): `order_issue.refund_reversal_requested` ditiru dari `order.voided` (`accounting-auto-journal-void.ts`, `postAutoJournal` ~:545): fakta = entry jurnal posted `aj:order-refund:<issueId>` (`postedEntryIdOf`/`backingStateOf` guards, kind `qrRefund`); `reverseJournalInTransaction(postedBy null, idempotencyKey = kunci auto-journal event ini, tanggal `resolveAutoJournalDate`, alasan "Refund item gagal ditolak <issueId>")`. Jurnal refund masih pending -> error baru retryable `AutoJournalRecoveryRefundPending` (diparkir, sweep mencoba lagi). State `none` (tidak pernah posted, atau sudah dibalik) -> ignored. Kunci idempotensi auto-journal: `aj:order-refund-reversal:<issueId>`. Cloud-only lewat `postsInventoryGl` seperti jurnal lain (worker-main tidak perlu diubah bila event masuk daftar nama event auto-journal).
- T5 (test-writer) `apps/api/src/test/order-recovery-refund-reject.test.ts`: rejected pada QR pay-first -> satu event reversal di outbox, audit refund_rejected; konsumen auto-journal membalik jurnal order.refunded (reversal_of = entry refund, baris sama dengan debit/kredit tukar); dijalankan ulang -> tidak ada reversal kedua; jurnal refund masih pending -> diparkir retryable lalu sweep membalik setelah jurnal refund posted; hold: setelah rejected `refundableBalance` cap kembali turun sebesar refund; guard `qrSales` tidak mengurangi lagi setelah reversal posted; open bill rejected -> tidak ada event. Pola test jurnal: `order-recovery-refund-four-eyes.test.ts` (RG-*), `accounting-auto-journal*.test.ts`.
