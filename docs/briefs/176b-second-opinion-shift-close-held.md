# Brief 176b: second-opinion — held manual cash outs expire at shift close (legend-y9bf)

Tier K (cash drawer, ledger, migration). Codex second opinion before the release gate. This brief deliberately leaves out the Claude review findings.

## Range

- Repo `/Users/ifanshori99/Projects/legend super app/legend`, branch `ws/shift-close-held` (local only, not pushed), worktree `.worktrees/shift-close-held`.
- Base `ws/shift-close-fix` at `1c051167` (brief 167).
- Diff: `git diff 1c051167..6b3c6840`. Skip `apps/api/drizzle/meta/*_snapshot.json` (generated).
- About 610 non-test lines (SQL included; the trigger SQL appears twice, in 0143 and pos-shift.custom.sql), under the 800-line limit. One run.

## The rule (CTO decision for Codex 146 F2)

A manual cash out or drop held for review (`cash_movements.needs_approval`, legend-67dt) was not paid out: the money is still in the drawer. At close, normal or forced:

1. Every held cash movement of the shift with no outcome expires: one `cash_movement_outcomes` row `expired` and one audit `pos_shift.cash_movement_expired` each. It is never booked. The cashier asks again in the next shift.
2. Expected cash leaves held movements out (as before). The booked difference no longer adds them, so a close is posted normally instead of parked as `POSTING_AMOUNTS_MISMATCH`.
3. An approval or rejection that comes after the close for an expired movement is refused. No approval path exists today; the database enforces it (one outcome per movement, approve or reject refused once the shift is closed).
4. The day report shows the expired held cash (`expiredCashOutIdr`).

Held refunds and voids keep their rule: their cash is booked by `order.refunded`, so the booked difference still adds it.

## What changed

- Migration `0143_cash_movement_outcomes.sql`: table `cash_movement_outcomes` (RLS forced, append-only, insert trigger rules), `pos_shifts.difference_idr` (the difference the close booked; null on shifts closed before), `pos_shift_counts.held_correction_idr`, and a rewritten `pos_shifts_closed_check`. Custom SQL in `apps/api/src/db/schema/pos-shift.custom.sql`.
- `pos-shift-support.ts`: `heldCorrectionCashIdrOf` (held refund and void cash), `expireHeldCashMovements`.
- `pos-shift.service.ts`: count stores the held correction; `closePosShift` and `forceClosePosShift` expire held movements and book `differenceIdr = variance + held correction`.
- `packages/shared/src/pos/events.ts` (close event docs; the refine formula is unchanged, so stored events still parse), `packages/shared/src/pos/schemas.ts` (day report DTO).
- `accounting-auto-journal-amounts.ts` (`cashier_shift.closed`): compares with `difference_idr`; a shift with null `difference_idr` keeps the old comparison with the variance.
- `pos-day.service.ts`: variance from `difference_idr` (legacy fallback), expired held cash per device.

## Transition (judge, not bugs in themselves)

- Held movements on shifts closed before 0143 get no outcome row (no backfill); those closes were booked or parked by the old rule.
- A count submitted before 0143 has no held correction and is stale at close; the cashier recounts.
- `approved` outcomes are refused until an approval flow updates the drawer figures (legend-3l4q).

## Invariants to attack

- K1: No journal ever books a held manual cash out, at close or after. Codex example: expected Rp100.000, held cash out Rp150.000, counted Rp100.000 → difference 0, nothing posted, nothing parked.
- K2: A real shortage or overage is posted once, with the right sign, on both close paths, with or without held cash outs, held refunds or held voids.
- K3: A legacy event (shift closed before this change, `difference_idr` null) whose difference carried a held cash out stays parked if retried; it never posts the fictitious debit.
- K4: Every held movement of a closed shift has exactly one outcome; a non-held movement never has one; no outcome other than `expired` lands after the close; outcome rows never change or disappear; tenant isolation holds (RLS forced).
- K5: Nothing the cashier reads (count, close, movement responses, errors) differs between a held and a normal cash out, a held and a normal refund, or reveals the expiry (legend-utqr, brief 167 J1).
- K6: `differenceIdr ≠ 0` always carries a note; the note requirement the cashier sees follows the booked difference.
- K7: The day report total equals the sum of the booked differences of its closed shifts, and `expiredCashOutIdr` equals the expired outcomes of the day.
- K8: Migration 0143 is safe on a live database with open shifts, counts in flight and closed legacy shifts (the rewritten closed check must accept every existing row).

## Output

Findings only, each with file:line, a concrete scenario and a severity. State it plainly when an invariant holds.
