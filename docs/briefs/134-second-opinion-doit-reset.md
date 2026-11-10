# Brief 134: second-opinion (Codex) — reset refund pra-switch DOIT + tutup refund manual (legend-xd2q)

> Catatan CTO 9 Nov 20:45: cabang dan worktree yang disebut di bawah sudah digabung ke `milestone/m1` lalu dihapus. Semua SHA di brief ini ada di m1. Baca dengan `git diff`/`git show` pada SHA itu dari folder utama `/Users/ifanshori99/Projects/legend super app/legend` (read-only, jangan checkout). Cek juga apakah kode yang sama sudah berubah sesudahnya di `milestone/m1` (`git log <tip>..milestone/m1 -- <file>`).

Tingkat K (uang, data produksi). Review read-only. Jangan mengubah berkas, jangan commit, jangan `git add`.

## Di mana
- Worktree: `.worktrees/doit-sandbox`, cabang `ws/doit-sandbox`.
- Rentang diff: `git diff 5316426a..ws/doit-sandbox` (tip saat ditulis: ff4dac27). Base = `ws/doit-refund` (5316426a).
- Pakai tip cabang saat review. Tip sudah memuat legend-8cf3 (runner produksi) dan legend-xd2q (tripwire + settle manual).

## Latar belakang (fakta)
- Sebelum 5316426a tidak ada port refund ke DOIT.
- `runRefundPayout` lama meng-claim refund yang sudah approved (`payout_attempts + 1`). Port yang belum dikonfigurasi melempar `SERVICE_UNAVAILABLE`.
- Setelah 8 percobaan, sweep memberi status `MANUAL_RECONCILIATION`.
- 5316426a: sekarang melempar sebelum claim bila tidak ada gateway (`services/payment-refund.service.ts` `refundGatewayInstalled` sekitar baris 1127, sweep sekitar baris 1518).
- Keputusan founder Q17 (9 Nov 2026): reset satu kali dengan audit, dilakukan sebelum `DOIT_REFUNDS_ENABLED` dinyalakan di env mana pun. Baris yang di-quarantine ikut, tetapi flag `PAYOUT_QUARANTINED` tetap dipertahankan (sudah disetujui CTO).

## Berkas berisiko (diubah di slice ini)
- `apps/api/src/db/reset-preswitch-refund-payouts.ts` (+ `.test.ts`)
- `apps/api/src/reset-preswitch-refunds.ts` (wrapper produksi) + `deploy/single-vm/reset-preswitch-refunds.sh` (+ `test-deploy.sh`)
- `apps/api/tsup.config.ts`
- `package.json` (scripts)
- `docs/qa/doit-sandbox-refund.md`
- `docs/deployment.md` (bagian reset)

### Tambahan legend-xd2q
- `apps/api/src/services/payment-refund.service.ts`: konstanta `SETTLED_OUTSIDE_PROVIDER` dan `PAYOUT_NOT_FOUND_MAYBE_SENT`; `completeRefund` (opsi actor/marker); `contradicts`; `keepSticky`; `runRefundPayout` (syarat kirim `claim.send && !claim.lookupFirst`, cabang `not_found`); sweep exhausted; `assertOpsActor`; `settleRefundManually`; `applyRefundProviderUpdate`.
- `apps/api/src/routes/payment-admin.routes.ts`: `POST /api/payments/admin/refunds/:refundId/settle-manually`.
- `apps/api/src/services/payment-webhook.service.ts`: `findSettledOutsideTarget` dan `processRefundEvent` (webhook `refund.succeeded` tanpa kunci pada refund yang di-settle manual).
- `apps/api/src/services/payment-admin.service.ts`: daftar field audit `refundAudit`.
- `packages/shared/src/payment/admin.ts`: `manualRefundSettlementInputSchema`, endpoint `settleRefundManually`.
- `apps/api/src/services/payment-refund-gateway.ts` (kontrak port, komentar).
- Test: `apps/api/src/test/payment-refund-manual-settle*.test.ts`, `payment-refund-approval.test.ts`.

### Tambahan legend-0yd1 (bentuk jawaban DOIT sandbox yang nyata)
- `apps/api/src/services/payment-doit-refund-webhook.ts`: `readDoitRefundFacts` membaca `data` flat (`refund_id`, `amount`, `payment_id`) dan menyimpan `payment_id` di event tersimpan.
- `apps/api/src/services/payment-doit-wire.ts`: `parseDoitRefundAnswer` menerima `amount` angka atau string bilangan bulat (bentuk replay), cek `payment_id`.
- `apps/api/src/services/payment-webhook.service.ts`: `paymentMatchesRefund` (cek `payment_id`), `findSettledOutsideTarget` lewat `payment_id`.
- Bukti tersensor: `docs/qa/evidence/doit-sandbox/0yd1-results.redacted.json`, ringkasan di `docs/qa/doit-sandbox-refund.md` bagian 9.

## Konteks baca saja
- `services/payment-refund.service.ts`: claim sekitar 1325-1340, tulis error sekitar 1430-1445, sweep sekitar 1509-1560, `maybeSentOf`, release quarantine sekitar 1755-1815.
- `services/payment-doit.ts`: mapping error `call()` sekitar 398-436, `getRefundStatus` sekitar 665-683.
- `services/core-audit.ts`: `recordAudit`.
- `db/schema/payment-admin.ts`: `paymentRefunds`.

## Invariant yang harus dicek
1. Tidak ada refund yang mungkin sudah sampai ke DOIT yang ikut di-reset (cegah pembayaran ganda).
2. Hanya baris yang ada di berkas `--ids` yang sudah direview, dan masih cocok dengan semua kriteria, yang diubah.
3. Flag `PAYOUT_QUARANTINED` tetap terjaga.
4. Satu baris audit per baris yang di-reset, dalam transaksi yang sama, dengan tenant dan outlet yang benar.
5. `--apply` tidak mungkin jalan tanpa cutoff dan ids, dengan switch menyala, atau bila ada bukti kiriman DOIT yang hidup.
6. Rerun idempoten.
7. Dry-run tidak menulis apa pun.
8. Runner produksi tidak pernah mencetak URL DB atau secret. Tidak ada pemuatan `.env` di produksi.
9. RLS/role: jalan sebagai owner migrasi, dengan tenant diset per transaksi.

### Invariant legend-xd2q
10. Refund yang mungkin sudah terkirim (attempts > 0, polls > 0, atau provider_ref ada) tidak pernah di-POST lagi ke provider, termasuk saat jawaban lookup `not_found`, saat retry, sweep, release/reopen quarantine.
11. Jawaban `not_found` memberi flag `PAYOUT_NOT_FOUND_MAYBE_SENT` dan satu audit; flag tidak hilang oleh error tak dikenal atau oleh sweep (tidak berubah jadi `MANUAL_RECONCILIATION`); hanya jawaban `pending` dari provider yang menghapusnya.
12. Settle manual tidak pernah memicu payout: refund berakhir `completed` dengan marker `SETTLED_OUTSIDE_PROVIDER`, payment dan dana (fund) berubah sama seperti penyelesaian lewat provider, audit memuat bukti (paidAt, channel, externalReference, amountIdr, catatan).
13. Settle manual hanya untuk refund `approved` yang belum pernah dilihat provider (provider_ref NULL, polls 0) dan lease bebas; nominal harus sama; paidAt di antara pembuatan refund dan sekarang + 5 menit.
14. Aktor settle manual: payment.reconcile dan pos.refund.approve di outlet refund, bukan peminta refund, MFA dashboard; dicek sebelum tulis idempoten. Replay kunci yang sama mengembalikan hasil yang sama.
15. Jawaban sukses dari provider (worker atau webhook) untuk refund yang sudah di-settle manual dicatat sebagai konflik (pelanggan dibayar dua kali), status tetap `completed`.
16. Script reset pra-switch tidak pernah memilih refund `completed` atau ber-flag `PAYOUT_NOT_FOUND_MAYBE_SENT`, dan menganggap flag itu bukti switch sudah hidup.

### Invariant legend-0yd1
17. Webhook refund DOIT berbentuk flat hanya menyelesaikan refund yang `providerRef`-nya sama dengan `refund_id`; nominal dan `payment_id` harus cocok, selain itu ditolak atau tidak dicocokkan, tidak pernah menebak.
18. Jawaban refund (termasuk replay dengan `amount` string atau kunci dipakai ulang dengan body lain) hanya dianggap sukses bila nominal dan payment sama persis; selain itu hasilnya unknown, bukan failed.
19. Total refund Legend per intent dibatasi oleh Legend sendiri, karena sandbox DOIT tidak membatasi total refund parsial.

## Yang diminta
- Temuan dengan `path:baris`, tingkat keparahan, dan skenario kegagalan yang konkret.
- Verdict: aman atau tidak aman untuk `--apply` di produksi, dan aman atau tidak aman untuk merilis tripwire + settle manual.
- Temuan tanpa skenario kegagalan konkret bukan temuan.
- Tulis dalam bahasa Indonesia, ringkas.
