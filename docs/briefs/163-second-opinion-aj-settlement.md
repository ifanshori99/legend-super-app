# Brief 163: second opinion, auto-journal slice 4 settlement + MDR (legend-9pz9)

Role: second-opinion (Codex). Tier K (money, journals). Effort xhigh. Read-only: do not edit, commit or push.

## Where
- Repo: `/Users/ifanshori99/Projects/legend super app/legend`, worktree `.worktrees/aj-settlement`, branch `ws/aj-settlement`.
- Diff range: `ab1c5aab..abb920e4` (ab1c5aab = merge of `ws/aj-fix142`, reviewed in brief 142b).
- Design (read first): `docs/design/auto-journals.md` §1 (settlement rows), §4 (keys and emitter contract), §8.
- Posting rules (unchanged): `packages/shared/src/accounting/posting-rules.ts` rules `gateway_settlement` and `edc_settlement`.

## Run (one, ~190 non-test lines)

| Files | Lines |
|---|---|
| `packages/shared/src/payment/settlement-events.ts` (new), `packages/shared/src/payment/index.ts`, `packages/shared/src/edc/events.ts` (comment), `apps/api/src/services/accounting-auto-journal-{amounts,consumer}.ts` | ~190 |

Use `git diff ab1c5aab..abb920e4 -- <files>`. Tests (`apps/api/src/test/accounting-auto-journal.test.ts`, block AJ-SET) may be read for intent.

## Risky spots
- Entry date: `AutoJournalFact.entryDate` (= `settledOn`) preferred over the outlet business date of `moneyTime`; late adjustment into the first open day; retry sweep rebuilding the fact.
- Payload strictness and parking: a ZodError must park non-retryable; envelope outlet vs payload outlet.
- Idempotency keys `aj:settlement:<settlementId>`, `aj:edc-settlement:<settlementBatchId>`: replay, cross-outlet, cross-tenant.
- No backing guard on gateway_clearing / edc_clearing (deliberate: over-settlement is a reconciliation case).

## Invariants
- Every settlement journal balances: Dr bank net + Dr gateway_fee_expense fee = Cr clearing gross; zero lines dropped.
- A gateway payout never credits edc_clearing and an EDC payout never credits gateway_clearing.
- One payout posts at most once; the journal date is exactly the bank settlement date (or the first open day, audited).
- Every query is tenant-scoped; no change to RLS, migrations or posting rules; no emitter is added.

## Output
Findings with severity, file:line, concrete scenario, suggested fix; or "No findings" with what you verified. Write to `docs/briefs/163-second-opinion-aj-settlement.result.md`.
