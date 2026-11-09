# Sub-brief fix round 3: receipt run self-heal (legend-hfq3z)

Read `docs/briefs/sub-receipt-run-self-heal.md`, `-fix1.md`, `-fix2.md` first. Same rules (only your files, no commit, no tsc/full suite). Code for this round is done by the engineer in `apps/api/src/services/pos-receipt.service.ts` (do not edit it).

## Findings (re-review K round 2) and the code change

F1 (minor). A `prefix_used` heal row entered the clone check; the edge keeps reporting that prefix for its other local run, so every later pull raised a false `receiptRunAlert` for 24 h.
Change: a `prefix_used` heal retires at `retired_at = tau + 1 ms` (`edge_reported_at = tau`); an `id_used` heal keeps `retired_at = edge_reported_at = tau`. The clone check counts only `retired_at = edge_reported_at` heal rows; the heal throttle counts both markers (difference 0 or 1 ms).
F2 (minor). A `prefix_used` row whose `edge_reported_number` was already raised (> 0) from the other run (old yd0h8 path) failed the heal guard and was then skipped: device left without a run, no alert.
Change: for `prefix_used` the guard no longer requires `edge_reported_number = 0` (still `lastNumber = 0` and the stale-token check). `id_used` unchanged.

## Section T — tests in `apps/api/src/test/pos-receipt-seq-edge.test.ts` hfq3z block (test-writer)

T1. F1: prefix_used heal where the report carries a number for that prefix (reuse the fix2 T3 setup, e.g. refused P3, report `P3:4`); a follow-up pull (newer tau) with the same report `P3:4` and no refusals → NO `receiptRunAlert`. Keep/confirm the existing id_used clone-alarm test still expects the alert.
T2. Heal marker columns: id_used heal row has `retired_at = edge_reported_at`; prefix_used heal row has `retired_at - edge_reported_at = 1 ms` (query both columns directly). Update the existing fix2 T2 test if it asserts equality for a prefix_used heal.
T3. F2: a current prefix_used-refused row with `edge_reported_number` already > 0 (set it via the normal report path first, or direct SQL if the forward-only trigger allows raising it) and `lastNumber` 0 → heal runs (new prefix above floor, device can sell after apply).
T4. Throttle still counts prefix_used heals: `RECEIPT_REFUSAL_ROTATIONS_MAX` prefix_used heals in the window → next refusal is throttled (`receiptRunAlert: true`). Reuse an existing throttle test shape.

Write only; the engineer runs tests.
