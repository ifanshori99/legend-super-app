# Brief: red test for legend-aruta (POS cashier switch by PIN)

Worktree: this one (ws/aruta-pos-pin). Template/fixtures: `apps/api/src/test/pos-order-approval.test.ts` and `pos-order.test.ts` (isolated tenant, real Express app, RLS DB).

Claim to prove: POS cashier switch by PIN is client-only. `POST /api/staff-pins/verify` (device-pin.routes.ts:72) returns only {user,outletId,verifiedAt}; no POS route reads it. All POS routes (pos-order.routes.ts caller() ~L108, pos-shift.routes.ts ~L111) take actor = `getAuth(req).user.id` (session user).

Write `apps/api/src/test/pos-cashier-switch-actor.test.ts`:
1. Session = member A (e.g. owner/cashier w/ pos perms). Cashier B has staff PIN (setStaffPin) and a registered device (see device-pin-service.test.ts / helpers for device token + verify).
2. B types PIN via /api/staff-pins/verify on the device -> success (this is the "switch").
3. Then the POS action sequence as the device would: open shift, create order, add tender (and void/discount if cheap). Assert the recorded actor (pos_shifts.cashier_id, order created_by, tender actor_id, audit/events actor) equals B. Today it equals A => test must FAIL (red) with a clear message. Do not change production code. Do not weaken other tests.
4. Add a second test (should pass now): a wrong PIN does not change anything.
Keep file ≤ 250 lines. Run only this file via `heavy` (see TEAM.md "Gate"; `LEGEND_TEST_FILES=<file>` style used in repo; check package.json scripts). Report: red output (actor values), how a real device request is built (headers/cookies), and any harness gap that makes a real switch impossible to express.
