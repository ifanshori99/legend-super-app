# 845 Finance view dan akses laporan (engineer Sonnet)

Kartu: legend-ftqf (satu tagihan tidak konsisten membuat seluruh daftar dana tak teralokasi 409), legend-5bjh (link laporan pemegang saham membuka /_kelola/reports/* yang butuh dashboard.management.view), legend-z13t (finance view: auto-journal AUTO_JOURNAL_RECEIPT_PENDING lebih dari 1 hari).

- Paralel: Explore per kartu, test-writer gagal-dulu, satu implementer per kartu.
- ftqf: baris bermasalah diberi status needs_review di DTO + UI, baris sehat tetap tampil. Tidak ada saldo atau dana berubah; test bukti tidak ada pihak dibayar lebih.
- 5bjh: akses pemegang saham hanya ke laporannya sendiri; jangan melonggarkan izin manajemen. Bila butuh izin baru, berhenti dan lapor.
- Jangan sentuh cash-out/drawer (thread 841), EDC, payroll.
- Migrasi: bila perlu pakai 0387.
- Review: satu subagent architect effort xhigh (uang dan akses).
- Pra-gate AGENTS.md. Commit + push tanpa force. Lapor dengan angka subagent.

## Peta Explore dan keputusan (engineer)

### ftqf

- API: apps/api/src/services/payment-admin-funds.service.ts `listUnallocatedFunds` :145, `view()` :92, `ambiguous()` :85 (409), lempar di :115 :117 :141 (jalur list). Jalur resolve (:295 :314 :330) TETAP 409, jangan diubah.
- DTO: packages/shared/src/payment/admin.ts `unallocatedStatusSchema` :387 (open|resolved) -> tambah `needs_review`; `unallocatedFundViewSchema` :390; fixture :1091 :1226.
- UI: apps/web/src/features/ws05-payment-admin/ (components/unallocated-panel.tsx status pill :135, format.ts filterUnallocated/unallocatedTone/unallocatedLabelKey) + label teks katalog.
- Test lama yang assert list 409: apps/api/src/test/payment-admin-multi-fund.test.ts MF-03 :366, :391 -> ubah jadi: list 200, baris bermasalah status needs_review, baris sehat tetap, resolve baris needs_review tetap 409/ditolak, tidak ada saldo/dana berubah.
- Aturan uang: baris needs_review tidak boleh bisa di-resolve/dibayar; tanpa mutasi di list.

### 5bjh

- Link tile: apps/web/src/features/ws11-shareholder/components/business-section.tsx:82 -> path /reports/*.
- Guard area kelola: apps/web/src/lib/areas/definitions.ts:138-148 basePaths [/kelola,/reports,/audit], izin dashboard.management.view (JANGAN dilonggarkan untuk /kelola atau /audit).
- Guard halaman laporan sudah mendukung report.aggregate.view: apps/web/src/features/ws11-reports/guard.ts:16. API sudah OK (reports.routes.ts, report-viewer.ts).
- Kode: packages/shared/src/dashboard/catalog.ts:92 AGGREGATE_VIEW_REPORT_CODES (7), :121 reportAcceptsAggregateView.
- Opsi pilih yang paling sempit: shareholder hanya ke 7 laporan agregat, tidak ke /kelola, /audit, atau laporan lain.

### z13t

- Pola tiru: apps/api/src/services/accounting-finance-exceptions.service.ts `listFinanceExceptions` :342, `voidUnsupported` ~:215-265 (outletClause, scope.reach).
- Route: apps/api/src/routes/accounting-finance-exceptions.routes.ts:23 (accounting.journal.view). Tidak ada izin baru, tidak ada migrasi.
- Kind baru di packages/shared/src/validators/finance-exceptions.ts:6, mis. `receipt_pending_stale`; DTO + web apps/web/src/features/ws07-finance-exceptions/ (components/finance-exceptions-page.tsx, lib.ts, mock.ts).
- Sumber: auto_journal_parked (apps/api/src/db/schema/accounting-auto-journal.ts:35-54), error_code AUTO_JOURNAL_RECEIPT_PENDING, `first_failed_at < now() - 1 day` (bukan jendela tanggal last_failed_at); sertakan order id, intent id, amount, state outbox payment.paid (domain_event_outbox core-events.ts:20-50: status, dead_lettered_at).
- Test: accounting-finance-exceptions.test.ts. Read-only; tidak ada mutasi.
