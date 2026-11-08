# Sub-brief: EDC review K fixes (ws/edc-framework)

Worktree: `legend/.worktrees/edc-framework` (already merged with `main`, HEAD 437b2add).
Rules: never read `.env*`; never `pkill`/`killall`; heavy commands (build, playwright) via `heavy <cmd>`.
Stop only your own PIDs. Do not commit; the engineer commits.

Files: `apps/api/src/edge/edc/agent.ts` (agent), `registry.ts`, `simulator.ts`,
`apps/api/src/db/schema/edc.ts` + `edc.custom.sql`, `packages/shared/src/edc/index.ts`,
tests `apps/api/src/test/edc-agent.test.ts`, `tests/edc-contract*`.
Invariant for every money test: simulator `chargedCount` stays 1 (no double charge).

## A. agent.ts (implementer A, owns agent.ts only)

A1 (high) Rows "approved late": status cancelled/failed/declined with `needs_reconciliation = true`
(see agent.ts ~719-751) are today treated as not charged. `guardRetry` (~1083-1087), the
`blocking` check in `writeAhead` (~972-976) and ~923-929 only look at approved/pending/unknown.
Fix: also block when any row for that (tenant, outlet, reference) has `needs_reconciliation = true`
→ reject with new reason `EDC_NEEDS_RECONCILIATION` (add to EdcError reasons in shared) until
void + reconciliation. Also reject `EDC_STATUS_UNKNOWN` when any row for that reference is still in
the in-memory `inFlight` set, whatever its status.
A2 `~279-284`: inquiry `not_found` from `by_trace` is trusted without age limit, but contract
(`packages/shared/src/edc/index.ts:238`) says by_trace sees current batch only → after settlement an
approved row would become failed and retry passes. Fix: trust `not_found` only while
`now - dispatched_at <= notFoundTrustWindowMs` (agent option, default 15 min); outside it keep
`unknown` + `needs_reconciliation = true`.
A3 `~1203-1215`: `cancel` bypasses `withTerminalLock` and ignores `stuck`; `~292-294` accepts a
null `trace` from inquiry → another transaction's answer is recorded for this row. Fix: cancel goes
through the terminal queue (withTerminalLock) unless the row is in `inFlight`; reject when terminal
is `stuck`; inquiry answer with null/mismatched trace must not settle the row (stay unknown).
A6 `~1027-1043` recoverPending snapshots inFlight before UPDATE; a second start() can flip a live
row to unknown. Fix: only rows of outlets newly acquired by this start(), or condition
`dispatched_at IS NOT NULL OR created_at < startedAt` and not in inFlight at UPDATE time.
Keep existing tests in edc-agent.test.ts green; adjust only if a test encoded the old buggy behavior
(say which). Run: `pnpm --filter @starter/api exec vitest run src/test/edc-agent.test.ts` (check the
real filter/package name in apps/api/package.json).

## B. schema, shared, registry (implementer B, never touches agent.ts)

B5 `registry.ts:39-46`: `simulator: true` allowed in production. Throw when production (use the
repo's existing production-env convention; grep how other code detects production).
B7 PRD §6 `edc_transactions` (docs/PRD.md:1772) needs columns `type` (`sale`/`void`/`refund`,
default `sale`), `mode` (`ecr`/`standalone`, default `ecr`), `payment_intent_id` (uuid, nullable;
FK only if `payment_intents` table exists in schema, else plain uuid + comment). CHECKs like the
existing ones. Add `void` to `EdcProvider` (shared) + implement in simulator (void an approved
sale by trace; voided sale not charged → simulator `chargedCount` decrements or tracks voids;
keep `chargedCount` semantics = net charged). Agent need not call void yet.
Migrations: branch's old 0063/0064 were removed in the merge (copies in scratchpad
`old_0063.sql`, `old_0064.sql` at /private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app/41b732c8-807e-4b8a-9eac-f16952bf8313/scratchpad).
Regenerate with drizzle-kit from 0067: `pnpm --filter <api> exec drizzle-kit generate --name edc_transactions`
then the RLS one with `drizzle-kit generate --custom --name edc_rls` and paste old_0064 content
(look at how 0061/0062 or 0064_fiscal_close_lock_rls were made; follow that). Never hand-edit
`_journal.json`. Expected result 0068_edc_transactions.sql + 0069_edc_rls.sql.
Fix any test (edc-rls, edc-contract, edc-simulator, migration upgrade tests that name migration
numbers) broken by renumbering.

## T. regression tests (test-writer, new file only)

New file `apps/api/src/test/edc-agent-review.test.ts`, reuse helpers/fixtures from
edc-agent.test.ts (import or copy the setup). One test per finding: A1 (scenario like
edc-agent.test.ts ~999 "approved late" then re-bill same reference with a NEW idempotency key →
rejected `EDC_NEEDS_RECONCILIATION`, chargedCount 1), A1b inFlight → EDC_STATUS_UNKNOWN,
A2 not_found older than window → stays unknown + needs_reconciliation, A3 cancel while terminal
busy goes through queue / stuck rejected / null trace inquiry does not settle, A6 second start()
does not flip a live dispatched row to unknown, B5 registry throws in production. Tests are
expected to fail until A/B land; write them to the spec above, not to the implementation.

## O. outbox (later, after A)

Write `edc_transaction.*` events to the outbox in the same DB transaction as the ledger status
change (EDC-05). Convention found by Explore goes here.

### O details (from Explore)

- Helper `appendOutbox(tx, ctx, {id, event, destination, direction, peerId})`
  `apps/api/src/services/core-outbox.ts:26`; template emitter with `nextSequence`:
  `apps/api/src/services/payment-support.ts:~130-187` (destination `"cloud-sync"`, direction null,
  peerId null, idempotencyKey `${name}:${aggregateId}:${sequence}`, payloadSchemaRef `${name}.v1`).
- Catalog `packages/shared/src/events/catalog.ts` WS-00 already has `edc_transaction.created
edc_transaction.settled edc_transaction.cancelled`. Keep `settled` for bank settlement (EDC-06,
  not now). Add `edc_transaction.approved edc_transaction.declined edc_transaction.failed
edc_transaction.flagged` (flagged = needs_reconciliation set / outcome unknown) to WS-00.
- Define events with `defineDomainEvent` in new `packages/shared/src/edc/events.ts` (strict payload:
  transactionId, terminalId, bank/provider key, reference, amountIdr, status, trace|null,
  approvalCode|null, maskedPan|null, needsReconciliation; never raw PAN). Export via the edc subpath.
- agent.ts: emit inside the same `withTenant(db, ctx, tx => …)` as each ledger status change:
  created on write-ahead insert; approved/declined/failed/cancelled on terminal transitions;
  flagged when needs_reconciliation flips true or row goes unknown. Actor `{type:"system"}`.
- Tests (in edc-agent-review.test.ts or a new edc-outbox.test.ts): one approved sale →
  outbox has created + approved for that aggregate, same tx (rollback of ledger write leaves no
  outbox row); catalog/contract tests still pass.

## Round 2 (CTO follow-up): batch check before trusting not_found

Problem: by_trace inquiry sees only the current batch. If the bank closes the batch (settlement)
inside the 15-min window, a charged sale answers `not_found` → row `failed` → retry charges again.

Design (decided):

- New nullable column `edc_transactions.dispatch_batch_no varchar(20)`: the terminal's last known
  batch at dispatch = `batch_no` of the newest row of the same (tenant, terminal_id) with
  `batch_no IS NOT NULL` (order by completed_at desc), read and written in the dispatch-claim tx.
  Migration via `drizzle-kit generate --name edc_dispatch_batch` (→ 0070); never hand-edit journal.
- Adapter contract: an inquiry `not_found` MUST carry the terminal's current open `batchNo`.
- `patchFromAnswer` not_found for a DISPATCHED row: `failed` only if all old rules hold AND
  `result.batchNo !== null && row.dispatchBatchNo !== null && result.batchNo === row.dispatchBatchNo`.
  Otherwise `unknown` + `needsReconciliation: true` + new message (batch changed or unknown).
  Never-dispatched rows unchanged (failed). Batch equal ⇒ no close since a txn older than dispatch.
- Simulator: per-terminal batch counter (start "000001"); results and not_found inquiries carry the
  current batchNo; new `closeBatch(terminalRowId)` (settlement): batch+1, earlier records invisible
  to inquiry (not_found). Existing tests that rely on not_found→failed for a dispatched row must
  first settle one approved sale on that terminal so the batch is known (say which tests changed).
- JSDoc on `EdcProvider` / `sale`: the sale frame must be written to the wire synchronously when
  `sale()` is called (no await/connect/open before the write; open the link beforehand); the agent's
  cancel bypass relies on it. Also document the not_found batchNo rule on `ecrInquiryResultSchema`.

Tests (test-writer, new file `apps/api/src/test/edc-agent-batch.test.ts`):

- B1 known batch, sale X times out (terminal actually approved), bank closes batch within 15 min,
  inquiry not_found (batch 2) → X stays unknown + needs_reconciliation; re-bill same reference with new
  key → `EDC_NEEDS_RECONCILIATION`; simulator chargedCount for X's sale = 1 (no second charge).
- Batch unknown (first sale on a terminal, no earlier row with batch_no) + not_found → unknown +
  needs_reconciliation, not failed.
- Control: same batch, not_found in window → failed, retry allowed and charged once.
- dispatch_batch_no is stored on dispatch from the newest known batch.
