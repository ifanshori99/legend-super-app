# Sub-brief: fix/edc-so-829 (kartu legend-ftsq0)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-49162ff8`, cabang `fix/edc-so-829` (base 7e32d2707).
Temuan: `docs/briefs/so-edc-829-findings.md` (P1-A guard cancel, P1-B unknown tanpa flag, P1-C declined tanpa bukti wire, P2 outbox).

## Keputusan CTO (jangan diubah)
- Fail-closed: kunci tagihan tahan restart tetap terpasang sampai sale DAN cancel final dan tidak mungkin ada respons sale tertunda. Jawaban cancel saja bukan bukti sale selesai.
- Selama kunci: tunai, QRIS baru, ubah, void tagihan ditolak.
- QRIS tertangkap webhook saat sale kartu terbuka lalu kartu approved: kartu menang, QRIS di-void + refund penuh otomatis. Aturan ditulis di SATU tempat (konstanta/fungsi) agar mudah diganti (founder Q5 pending). Kartu declined: tagihan terbuka lagi, QRIS tetap sah.
- `unknown` tanpa flag (terminal tanpa inquiry/cancel): jalur penyelesaian Owner/Finance Manager berbasis bukti + MFA, tetap fail-closed sampai lewat batas waktu respons tertunda.
- Rekonsiliasi `declined` hanya bila sale terbukti tidak bisa menagih lagi (bukti final + keadaan wire), termasuk setelah restart.
- P2: event penyelesaian rekonsiliasi ditulis ke outbox atomik bersama ledger, juga saat status tetap tapi flag berubah.
- Jangan sampai rugi: test membuktikan tidak ada pihak dibayar lebih dan outlet tidak rugi.

## Scope
Boleh: `apps/api/src/services/pos-order-support.ts`, `pos-order-payment.ts`, `edc-reconciliation.service.ts`, `pos-edc-standalone.ts`, `apps/api/src/edge/edc/**`, test di `apps/api/src/test/`. Jangan: web. Migrasi hanya nomor 0381 bila perlu.

## Aturan kerja subagent
- Satu perintah per Bash. Test terarah: `cd <worktree> && LEGEND_TEST_FILES="src/test/a.test.ts" heavy pnpm test` (hanya pemegang token heavy).
- Tipe brand pakai helper proyek, bukan `as`.
- Jangan commit; engineer yang commit.

## Desain (engineer, final)

### A — agent.ts (P1-A, P1-C wire)
1. Bypass cancel (`sendCancel` without `hold`, i.e. the sale's own adapter call is still on the wire: `holding.has(row.id)` at the moment the cancel answer is applied): an answer whose patch status is final and not `approved` (cancelled/declined/failed) must NOT finalize the row. Keep status open (`pending` stays `pending`, `unknown` stays `unknown`), only store a message constant e.g. `MESSAGE_CANCEL_AWAITING_SALE` ("cancel diterima terminal; menunggu jawaban sale") via applyPatch with no status change (or a direct guarded update). The sale's own answer decides. `approved` from cancel still applies. Re-check `holding.has` right before applying (sale may have settled meanwhile; then applyPatch's open-status guard already handles it).
2. Sale timeout (raceAbort fired, `patch = unknownPatch()`): the adapter promise may still settle later. When it settles with an answer, apply it: `applyPatch(ctx, claimed, patchFromAnswer(claimed, ecrResultSchema.parse(answer), answerContext(provider)))` (applyPatch writes only while open; a late approval after final is flagged, existing code ~950). Capture the provider promise inside the `hold` call closure. Errors in the late path are logged, never thrown (no unhandled rejection). `stop()` already waits on `wires`.
3. Existing tests under `apps/api/src/test/edc-agent*.test.ts` must still pass; update only assertions that encoded the old unsafe behaviour (cancel answer finalizing a sale still on the wire) and say which in the report.

### B — edc-reconciliation.service.ts (P1-B, P1-C, P2)
1. New single-place constant `EDC_LATE_RESPONSE_WINDOW_MS = 10 * 60_000` in new file `apps/api/src/edge/edc/late-response.ts` with helper `lateResponsePossible(row: {dispatchedAt: Date|null}, now: Date): boolean` (false when `dispatchedAt` null; true while `now - dispatchedAt < window`). Doc: sale timeout default 120 s; window covers terminal-side completion and agent restarts (in-memory wire state lost).
2. Gate: accept `needsReconciliation === true` (as today) OR (`type==='sale' && status==='unknown' && !needsReconciliation`) — P1-B unflagged unknown. Anything else: same CONFLICT.
3. Unknown rows (flagged or not), any outcome: if `lateResponsePossible(row, now)` throw new `CoreError("CONFLICT", "Terminal masih mungkin mengirim jawaban untuk transaksi ini; tunggu sampai <window> menit setelah dikirim, lalu ulangi.")`. Flagged declined/cancelled/failed/approved rows (sale already answered): unchanged.
4. Update `.where(and(byId, eq(needsReconciliation, true)))` so unflagged unknown also updates (guard on the status/flag read under row lock instead, e.g. `eq(status,row.status)` + `eq(needsReconciliation,row.needsReconciliation)`). Audit `before.needsReconciliation` = real value.
5. P2: always emit an outbox event in the same tx after the update (status changed OR flag cleared). Name by new status: approved→`edc_transaction.approved`, declined→`.declined`, cancelled→`.cancelled`, failed→`.failed`. Row carries `needsReconciliation:false`.
6. MFA + `payment.reconcile` (Owner/Finance) unchanged; already in `resolveEdcReconciliationForActor`.

### C — pos-order-payment.ts (policy in one place)
Extract the `if (edcOpen)` decision into one exported named policy, e.g. `const QRIS_CAPTURED_WHILE_CARD_SALE_OPEN = "void_and_refund" as const` + short doc citing founder Q5 pending (card wins; QRIS voided + refunded in full). Behaviour unchanged. No other edits.

## Desain ronde 2 (setelah review architect)

New column (migration 0381): `edc_transactions.sale_wire_open_at timestamptz NULL` (Drizzle `saleWireOpenAt`). Meaning: the agent gave up waiting on this sale (timeout) but the adapter call is still running. Not in the shared DTO.

### M — schema + migration (implementer M)
- `apps/api/src/db/schema/edc.ts`: add column. Run `pnpm db:generate` from `apps/api`, rename the generated SQL to `0372_edc_sale_wire_open.sql` and fix `drizzle/meta/_journal.json` tag + snapshot name accordingly (check how earlier range-numbered migrations look in git log, e.g. `git log --diff-filter=A --name-only -- apps/api/drizzle | head`). Only `ALTER TABLE ... ADD COLUMN`.
- Acknowledge the migration in `apps/api/src/test/data-import-registry.test.ts` and any schema column coverage test that lists edc columns (grep `dispatch_batch_no` in src/test to find them).

### A2 — agent.ts (implementer A2)
1. Late sale write (`~1199`): `const late = wire.call.then(write, () => clearWireOpen())`; `trackWire(key, late)` at once so `stop()` waits for it. On write failure log outcome, approvalCode, rrn, amountIdr (never PAN).
2. On timeout while the adapter call has not settled: set `sale_wire_open_at = now()` on the row (plain guarded update by id, any status). When the call settles (answer or error): clear it to NULL in the same tx as the late `applyPatch` when there is an answer, else a plain update. Never leave it set by our own process.
3. `start()` recovery for an outlet this instance just acquired: clear `sale_wire_open_at` on that outlet's rows (the previous process's wire is gone with it). The 10-min dispatch window still guards those rows.
4. Cancel rule (replaces the `holding.has` check): a cancel answer whose patch is final and not `approved` NEVER finalizes a row that was dispatched (`current.dispatchedAt !== null`), bypass or queued. Store `MESSAGE_CANCEL_AWAITING_SALE` only; status stays. Rows never dispatched keep today's behaviour. CTO rule: a cancel answer alone is not proof the sale is over.
5. Late approval after final (`~965`): also persist evidence from `patch.details` (approvalCode, rrn, responseCode, invoiceNo, batchNo, cardType, maskedPan as applyPatch already filters) in that update.

### B2 — reconciliation (implementer B2)
- `edc-reconciliation.service.ts`: refuse (CONFLICT, Indonesian message: terminal masih memproses transaksi ini) when `row.saleWireOpenAt !== null`, any status/outcome. Add 1 case in `edc-reconciliation.test.ts` (row past the window but wire open → 409, row untouched).

### T2 — tests (test-writer)
- Update tests that encode "cancel answer finalizes a dispatched sale": `edc-agent-review.test.ts` (`cancelledButStillSelling` ~363-438, A1b), `edc-pan-logs.test.ts:554-558`, `edc-agent.test.ts` EDC-02/EDC-03 cancel cases, any queued-cancel-on-unknown case. New expectation: row stays open (pending/unknown) until the sale's own answer; never-dispatched rows still `cancelled`.
- `edc-so-829.test.ts`: P1-C waits for `approved` with approval code (not just flagged); add a test: sale times out, `stop()` called, late approval arrives → after stop resolves the row is `approved` (or flagged with approvalCode) and `sale_wire_open_at` NULL; add: late approval after a final row keeps approvalCode/rrn.

## Ronde 3 (architect re-review, commit 99af9af73)

### A3 — agent.ts (implementer)
1. Keep `wireOpen: Set<rowId>` in the agent: add in `setSaleWireOpen(..., true)` (before the DB write), delete when the call settles (in the late chain's clear paths). `clearStaleWireOpen` excludes those ids with `notInArray` (like `recoverPending` skips `inFlight`), so a live call of this process keeps its marker after an outlet re-acquire.
2. `createEdcAgent` throws (plain Error, clear message) when `saleTimeoutMs >= EDC_LATE_RESPONSE_WINDOW_MS` (import from `./late-response.ts`).

### T3 — tests (test-writer)
- `edc-so-829.test.ts`: P1-A make the cash 409 a hard assertion and assert the row stays `pending` before the sale answers. Add: queued cancel on a dispatched `unknown` row → row stays `unknown`; recovered never-dispatched `unknown`/pending row cancelled → `cancelled`; `createEdcAgent` with `saleTimeoutMs` >= window throws; outlet re-acquire (`start()` after lock loss, or a direct call path if lock loss is hard to simulate) keeps `sale_wire_open_at` of a still-running call.
