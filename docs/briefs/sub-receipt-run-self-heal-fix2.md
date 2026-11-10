# Sub-brief fix round 2: receipt run self-heal (legend-hfq3z)

Read `docs/briefs/sub-receipt-run-self-heal.md` and `-fix1.md` first. Same rules (only your files, no commit, no tsc/full suite). Current: 7 files / 167 tests pass.

## Findings (re-review K)

R1 (major). The claim "a `claim_rotated` row bound to exactly this (node, instance) only comes from the heal" is false: a normal claim rotation by database I2 of node N retires I1's row and `retireSequence` keeps the row's binding (N, I1). So for I1 the throttle counts I2's rotations, and A4's clone check raises a false alarm when I1 later reports a higher number (failover / reinstall).
R2 (minor). On a `prefix_used` refusal, `input.report.get(sequence.prefix)` is the number of ANOTHER local row (the clashing one). The heal guard then refuses (≠ 0) and, when the heal does not run, the yd0h8 path raises this run's `edge_reported_number` from that foreign number; later a false `edge_regressed`.

## Section A — `apps/api/src/services/pos-receipt.service.ts` (implementer)

1. Heal marker: the heal retire sets `retired_at = tau` AND `edge_reported_at = tau` (same JS Date). Extend `retireSequence` with an optional `retiredAt?: Date` (default `now()` as today) and pass `tau` for both in the heal only. A heal row is then exactly: `retired_reason = 'claim_rotated' AND retired_at = edge_reported_at` (+ this binding). Normal rotations (retired_at = now(), edge_reported_at older or NULL) and `edge_regressed` (retired_at = now() ≠ stamped tau) never match.
2. Use that marker in BOTH the throttle query and the A4 `cloneSeen` query: for `claim_rotated` rows require `retired_at = edge_reported_at` (`edge_regressed` rows keep the current condition). Fix the comments/JSDoc that claim exact binding alone identifies a heal.
3. Heal guard: keep `report !== undefined`; ignore `report.get(prefix)` when the refusal reason is `prefix_used` (that number is another row's); keep it for `id_used`. Also skip a heal when `sequence.edgeReportedAt !== null && tau <= sequence.edgeReportedAt` (stale; defensive — a heal-eligible row normally has NULL).
4. A row refused with `prefix_used` that is NOT healed (throttled) must skip the yd0h8 report handling below for that row (`continue`), so the foreign number never raises its high-water nor rotates it as regressed.

## Section T — tests in `apps/api/src/test/pos-receipt-seq-edge.test.ts` hfq3z block (test-writer)

T1. Failover: run P2 bound to (N, I1) reported `P2:5`; a pull by (N, I2) rotates it normally (`claim_rotated`, binding stays I1); then I1 pulls with report `P2:7` → NO `receiptRunAlert`; and I1's heal throttle is not reduced by that rotation (e.g. I1 can still heal with `RECEIPT_REFUSAL_ROTATIONS_MAX` heals).
T2. A heal row has `retired_at = edge_reported_at` (query both columns directly; `fullRows` lacks edge_reported_*).
T3. prefix_used where the report carries a number for that prefix (other device's local run, e.g. `P3:4`, refused run is P3): the heal still runs (new prefix above floor), and the healed row's `edge_reported_number` stays 0.
T4. prefix_used throttled: the row's `edge_reported_number` is not raised from the report and it is not rotated as `edge_regressed`.
Write only; the engineer runs tests.
