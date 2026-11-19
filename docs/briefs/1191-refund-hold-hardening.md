# 1191 Refund hold hardening (shared brief)

Cabang `ws/1191-refund-hold-hardening`, base int/batch97 (431cb2c04). Tingkat K (uang: refund). Aturan: bila ragu, hold tetap (jangan lepas tanpa bukti). Tidak ada refund ganda, total refund <= diterima, isolasi tenant. Migrasi dihindari; bila wajib pakai 0730-0731 saja. Jangan sentuh reservation-*, payroll-payout*, payment-webhook* (di luar kebutuhan kartu), edge/*, sealed/reseal.

Path relatif ke `apps/api`. Test: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` dari root worktree. Hanya SATU subagent menjalankan vitest/tsc pada satu waktu.

## Kartu 1 legend-tbygu: hold palsu dari echo refund milik kita
- Keputusan: `recordProviderRefundInTx` di `src/services/payment-provider-partial-refund.ts:333` (cabang `synthetic_full` :817-905, `left` :879-882, `left <= 0` -> own/duplicate :921-945, `byHandIdr` :867). Echo payment-object tanpa refund id dengan event id baru dari refund kita yang `completed`: kini bisa jadi hold CONFLICT palsu (tes 1075-r3-08: `src/test/refund-1075-r3-matched-unproven-success.test.ts:385-436`).
- Mau: bila transaksi sudah tertutup penuh oleh refund kita (completed) -> tidak ada hold baru (dianggap echo). Echo yang jumlahnya MELEBIHI refund tercatat tetap hold. Echo parsial/ambigu tetap hold.
- Test baru: `src/test/refund-1191-a-echo-closed-by-own.test.ts` (harness `src/test/refund-1072-harness.ts`).

## Kartu 2 legend-rdg29: poller hold own_refund_failed_unverified
- Fakta kode (Explore): `verifyOwnRefundFailedHolds` di `src/services/payment.service.ts:4411-4520`. Premis kartu (cap 12 galat, berhenti saat paid) TIDAK ada di base: poller bertanya tiap 60 dtk tanpa batas, errors di-swallow, `paid`/error tidak mengubah apa pun; hold tidak pernah ditutup poller. Kolom state: hanya `gatewayPolledAt`, `gatewayPollLeaseUntil` (`src/db/schema/payment.ts:208-214`). Alert sekali saat hold dibuat: `alertOwnRefundFailedUnverified` di `src/services/payment-provider-refunded-alert.ts:411`.
- Mau (tanpa migrasi bila bisa): (a) backoff berdasar umur hold (`refund_recon_holds.flagged_at`): mis. 60 dtk selama 1 jam pertama, 10 mnt sampai 24 jam, 1 jam sesudahnya; dihitung di klausa due SQL; (b) alert ulang ke finance periodik selama hold masih terbuka (mis. sekali per hari) lewat `alertReconHoldFiled` dengan kunci dedupe per tanggal bila notifikasi punya dedupe key; hold tetap tertahan sampai terbukti. Jawaban `paid`/galat TIDAK menutup hold.
- Test baru: `src/test/refund-1191-b-poller-backoff-realert.test.ts` (pola `src/test/refund-1045-a-no-webhook-failed-own.test.ts`).

## Kartu 3 legend-r7oi3: race kredit DP vs hold konflik atomik (r1-04)
- File: `src/test/refund-1075-r1-hold-atomic-race.test.ts:540-542` (todo), header :24-39 (barrier `vi.mock`). Harness `src/test/refund-1072-harness.ts` (`createRefundHarness` :98, `deliver` :474, `allHolds` :664). Fixture DP `paidDeposit` di `src/test/refund-1072-a2-small-fact-hides-conflict.test.ts:165-230` (tenant lain dari harness; butuh fixture satu tenant / lintas tenant yang benar).
- Kode: apply `applyReservationCustomerCredit` `src/services/reservation-deposit-remainder.ts:404` (FOR UPDATE :462-476, advisory `reservation-credit:` :483, shared `deposit-intent:` :185/:518); hold `fileOwnRefundSurplusHoldInTx` `src/services/payment-provider-partial-refund.ts:1422` (intent FOR UPDATE :1451, `lockDepositIntentsExclusive` :1035). Dua koneksi pg, barrier sebelum insert hold; akhir: satu hold, tidak ada kredit terpakai berlebih/ganda; tidak ada overspend. Catatan: apply ditolak sebelum lock bila R dan fakta echo sudah ada (a2-06).
- Bila test menemukan bug produksi, betulkan (jaga isolasi tenant).

## Kartu 4 legend-sy98y: paymentReference + outletName di tampilan hold
- Sudah ada di base (a3d2340e2 leluhur HEAD): `packages/shared/src/payment/admin.ts:536-556` (`paymentReference: ref.nullable()`, `outletName: z.string().min(1).max(150).nullable()`), service `src/services/refund-recon-hold.service.ts:133-157` (`toView`), panel `apps/web/src/features/ws05-payment-admin/components/refund-holds-panel.tsx:109-120`.
- Mau: verifikasi benar-benar terisi (tes service: hold tampil dengan paymentReference dan outletName benar, lintas tenant tidak bocor), tambahkan test bila belum ada; teks UI baru (jika ada) masuk katalog (`node --test tests/text-contract.test.mjs`). Bila lengkap: tutup kartu dengan bukti, tanpa duplikasi.
