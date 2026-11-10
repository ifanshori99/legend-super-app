# Brief: second-opinion (Codex) — accounting small fixes

Repo worktree `.worktrees/accounting-small-fixes`, cabang `ws/accounting-small-fixes`, diff `d8ea5e0b..HEAD` (2 commit). Read-only review, tingkat K (uang).

## legend-3r6r (K)
Sale (`order.paid`) dengan tender gateway menunggu `payment.paid`. Dead letter lebih dari 3 hari kini memarkir sale non-retryable `AUTO_JOURNAL_RECEIPT_DEAD_LETTERED`, tanpa fallback `gateway_clearing`; dilepas saat `payment.paid` outlet yang sama diposting.
- `apps/api/src/services/accounting-auto-journal-amounts.ts`: `assertNotDeadLettered`, dipanggil dari `receiptStatesOf`.
- `apps/api/src/services/accounting-auto-journal-consumer.ts`: `requeueReceiptDependents`, `park`.
- Tes: `apps/api/src/test/accounting-auto-journal.test.ts` AJ-3R6R-01..03.

Pertanyaan: ada jalur double count atau jurnal hilang? Race replay vs sweep? Pelepasan terlalu luas (per outlet)? Payout `payment.refunded` (guards.ts, tidak disentuh) tetap menunggu tanpa batas: apakah perlu kartu sendiri?

## legend-bqup (S)
Lock `chart_of_accounts:<tenant>:<entity>` sudah ada; hanya tes konkuren baru `accounting-accounts-race.test.ts`.

Format laporan: temuan nyata saja, file:line, perbaikan singkat.
