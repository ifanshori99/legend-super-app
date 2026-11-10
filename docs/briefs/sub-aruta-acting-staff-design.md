# Brief: architect review - design "token kasir aktif per perangkat" (legend-aruta)

Worktree: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/aruta-pos-pin (ws/aruta-pos-pin). Tier K (akses + uang). Read-only; return a decision text I paste into docs/DECISIONS.md (Indonesian, same style as the 2026-11-10 entry in `git show origin/ws/arch-357-decisions:docs/DECISIONS.md`).

## Problem (proven, red test apps/api/src/test/pos-cashier-switch-actor.test.ts)
POS cashier switch by PIN is client-only. `POST /api/staff-pins/verify` (routes/device-pin.routes.ts:72, services/device-pin.service.ts:502) returns {user,outletId,verifiedAt}, no token. Web stores it in localStorage (features/ws01-device-pin). All POS routes take actor from `getAuth(req).user.id` (routes/pos-order.routes.ts:108 caller(), pos-shift.routes.ts:111, pos-receipt.routes.ts:70, pos-receipt-writeoff.routes.ts:89, pos-order-customer.routes.ts:54) and `requireOutletPermission` checks the session user.

## Approved direction (founder/CTO)
Device-bound "acting staff" token. verify gets `purpose:"pos_session"` -> returns token; POS requests send header `X-Acting-Staff`; a POS middleware validates it and makes the token's staff the actor AND the subject of permission checks. No header = old behaviour (a bd card will later make it mandatory in shared-device mode).

## Constraints already fixed
- Own table in migration 0243 (do NOT use/alter the PIN-proof table of thread u7g9w; do NOT touch core of device-pin.service.ts verify). Put the pos_session branch in separate file/route if possible; list touch points for merge train.
- Bound to device + outlet + staff; staff must be entitled at that outlet; TTL = min(shift close, 12h); revoked on switch of cashier / shift close / PIN reset; permissions evaluated for acting staff, not session owner; audit records both session_user and acting_staff.
- Store only sha256 of token (pattern pp_ + 32 random bytes base64url), like arch-357 decision 1.

## Decide / answer (be concrete, short)
1. Table columns, constraints, indexes, RLS (tenant), one-live-token-per-device rule, how revoke on switch/shift close/PIN reset is wired (which existing functions to hook: setStaffPin, shift close, new verify).
2. Where the middleware sits and exactly how it replaces actor + permission subject without changing every caller (e.g. wrap getAuth? new req.actingStaff + helper `actorOf(req)`); list every route file/function that must switch. Pitfalls: requireOutletPermission uses which user lookups/cache? session-vs-acting permission leakage (acting staff must NOT inherit session owner permissions, nor vice versa); can a session user lacking pos.* still act via token? Is a token valid if the session is a different tenant/outlet?
3. Idempotency/replay: idempotency keys fingerprint caller.userId - what changes? Same key with different acting staff.
4. Audit shape: how to store session_user + acting_staff in audit log and domain rows (cashier_id etc. = acting staff).
5. Failure modes + error codes (expired, revoked, wrong device, wrong outlet, no permission, staff inactive/locked), HTTP status, rate limit/lockout reuse.
6. Offline/edge: does the edge (EDGE_API_EXACT_ROUTES) POS path need the header? Just flag.
7. Anything in the approved direction you think is unsafe: say so with the minimal fix.
Cite file:line. Do not write code.
