# Brief 176c: second-opinion — blind close for the cashier (legend-4wrfd)

Tier K (cash drawer, access to figures). Codex second opinion before the release gate. This brief deliberately leaves out the Claude review findings.

## Range

- Repo `/Users/ifanshori99/Projects/legend super app/legend`, branch `ws/shift-blind-close` (local only, not pushed), worktree `.worktrees/shift-blind-close`.
- Base `ws/shift-close-held` at `6b3c6840` (brief 176b).
- Diff: `git diff 6b3c6840..545bf785`. About 190 non-test lines (added plus removed). One run.

## The rule (CTO decision, 9 Nov)

Blind close for the cashier. Every shift DTO and the close response sent to a caller without permission to see the variance carry `expectedIdr`, `varianceIdr` and the drawer breakdown (`cashSalesIdr`, `cashRefundsIdr`, `cashInIdr`, `cashOutIdr`, `cashDropIdr`) as null, open or closed. Supervisors and above (`shift.cash.view_all` or `shift.cash.approve_close`) see the full figures of other cashiers' shifts; their own shift is blind to them (POS-03). Never figures computed "as if held were booked". Events, audit and the ledger keep the full figures.

## What changed

- `packages/shared/src/pos/schemas.ts`: the seven figures are nullable, all null together (blind) or all present (full, still checked against the expected-cash formula). `POS_SHIFT_BLIND_FIELDS`, `PosShiftWithFigures`.
- `packages/shared/src/pos/calculations.ts`: `closeShift` takes and returns the full shape.
- `apps/api/src/services/pos-shift-support.ts`: `shiftDto(row, live, { blind })`, `blindShiftDto`, `shiftFiguresDto` (full, for maths, events and audit).
- `apps/api/src/services/pos-shift.service.ts`: open (and replay), the cashier close (and replay) are blind; report and list are blind unless a supervisor reads another cashier's shift; force close answers full.

- Tests: acceptance `e2e-az/az-e-cashier-shift.test.ts` and `cash-shift-close-default-tier.test.ts` no longer read the variance from the cashier's close answer; they assert it is null and read the figures through the supervisor report or the row. Judge whether any check was weakened.

## Invariants to attack

- B1: No response a cashier (or any caller holding only `shift.cash.operate`, or a supervisor on their own shift) can read carries expected cash, variance, or a drawer breakdown, on any route: open, close, close replay, report, list, movements, count receipt, errors.
- B2: For the cashier, every response is identical whether a cash out, refund or void was held or normal, before and after the close (legend-utqr).
- B3: A supervisor reading another cashier's shift sees the full stored figures, equal to the database row; the ledger, events, audit and the day report are unchanged.
- B4: Force close: who calls it, whose shift, and what it returns; a supervisor can never force close their own shift to see its figures.
- B5: Replays (idempotency keys) return the same shape the same caller would get, never the other caller's shape.
- B6: The shared schema accepts only all-null or all-present figures; a partial mix is refused; the full shape is still checked against the expected-cash formula.
- B7: Web and any other consumer of `PosShift` handle null figures without a crash (typecheck is green; no UI was redesigned).

## Output

Findings only, each with file:line, a concrete scenario and a severity. State it plainly when an invariant holds.
