# Sub-brief legend-5u03q: Codex fixes for acting-staff (POS cashier token)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/aruta-pos-pin` (branch `ws/aruta-pos-pin`).
Always `cd` there and print `pwd` first. Do NOT commit; the engineer commits. Do not touch files of another section.
No new migration. Never log/audit a token or PIN. Keep existing comments.

Rule for every section: write the test FIRST, run it, confirm it FAILS for the stated reason, then fix, run again, confirm it passes. Report the fail output line and pass line.

API tests: `LEGEND_TEST_FILES="src/test/<file>.test.ts" pnpm test` from the worktree root (starts its own isolated PostgreSQL, light for `heavy`). Run only your own test file. Do not run the full suite or `pnpm check`. Do not run tsc (engineer runs it once).

---

## S1 web: expired or missing token must hold POS requests (P1)

Files: `apps/web/src/lib/api/acting-staff.ts`, `apps/web/src/lib/api/client.ts`, `tests/acting-staff-path.test.mjs` (root node:test, run with `node --test tests/acting-staff-path.test.mjs`; it has no DB).

Bug: `readActingStaffToken` (acting-staff.ts:69) clears an expired token silently and returns null; `apiFetch` then sends the POS mutation without `X-Acting-Staff`, and the API treats it as the session owner (owner identity and permissions).

Required behavior:

- On a POS path (`POS_PATH`), when the token is expired, OR when no token exists but the active-cashier label (`ACTIVE_STAFF_STORAGE_KEY` in localStorage) says a cashier is active: the request is NOT sent. Run the rejection flow (`handleActingStaffRejection(ACTING_STAFF_ERROR_CODES.EXPIRED)`: clear token + label, go to the PIN screen `/pos/ganti-pengguna`), and `apiFetch` throws `ApiError(401, EXPIRED, "Kasir aktif sudah kedaluwarsa. Masukkan PIN lagi.")` without calling `fetch`.
- Apply to all methods on POS paths (a GET as owner leaks owner-only reads too).
- No token and no label (owner works the POS directly): unchanged, request goes without header.
- Expiry anywhere (also `readActingStaffToken` callers) must run the full rejection flow, not a silent clear.
- Keep the decision in `acting-staff.ts` (importable by plain Node: no `@/` imports there). Suggested shape: `actingStaffHeaderFor(path)` returns `null` when the request must be held; `client.ts` throws on `null`. Check every caller of `actingStaffHeaderFor`/`readActingStaffToken` (`features/ws01-device-pin/*`) still compiles and behaves.
- Tests: expired token on POS path -> held (null/throws, redirect called via a stubbed `window.location.assign`, token + label cleared); label without token -> held; no token no label -> `{}`; non-POS path -> `{}` always.

## S2 API: PIN verify and token insert must agree on one PIN generation (P1)

Files: `apps/api/src/services/pos-acting-staff.service.ts`, `apps/api/src/services/device-pin.service.ts` (only `attemptStaffPin` / `PinAttemptOutcome` / `verifyStaffPinOnDevice` return data), new test `apps/api/src/test/pos-acting-staff-pin-race.test.ts` (reuse setup patterns from `pos-acting-staff.test.ts` and `pos-acting-staff-sync-revoke.test.ts`).

Bug: `issueActingStaff` (pos-acting-staff.service.ts:111-123) verifies the PIN, then inserts the token in a separate transaction. A PIN reset (`setStaffPin`, which revokes live tokens in its own tx) committing in between leaves a fresh token from the OLD PIN that nobody revokes.

Fix:

- Make the verified outcome carry the PIN version it checked: the `staff_pins` row id plus `pinGenerationAt` and `pinSalt` (salt is random per set). Do not expose hash/salt outside the API service layer; do not put them in any response or audit.
- Inside the issue transaction, before revoke/insert: `SELECT ... FROM staff_pins WHERE tenant, outlet, user ... FOR UPDATE`. Missing row, or `pinGenerationAt`/`pinSalt` differ from the verified ones -> throw `HttpError(401, ACTING_STAFF_ERROR_CODES.INVALID, "PIN baru saja diganti. Masukkan PIN lagi.")` (or IdentityError PIN_INVALID if that fits existing tests better; say which). The lock serialises with a reset: a reset that commits first is detected; a reset that waits for the lock revokes the new token after commit (confirm `setStaffPin` revokes AFTER it writes `staff_pins`, device-pin.service.ts:~313; same for `staff-pin-sync.ts:571/600`).
- Test: deterministic race. E.g. wrap/inject so the reset (`setStaffPin` new PIN) commits after verify and before the issue transaction (a test hook, or call the internal steps; keep any hook test-only and minimal), then assert no live token remains for that staff (either issue refused, or token revoked). Must fail on current code.

## S3 API: edge -> cloud PIN adoption must revoke tokens (P1)

Files: `apps/api/src/edge/access-applier.ts`, `apps/api/src/test/edge-access-applier.test.ts` (add to the `legend-kyie staff_pin.set from an edge` describe, ~line 634).

Bug: `applyStaffPinSet` adopts new edge PIN material (update returns "applied" at :302, insert paths at :346-349) without revoking the staff member's live acting-staff tokens.

Fix: whenever new material is written ("applied" via update or insert), call `revokeActingStaffForStaff(tx, meta.context.tenant, { outletId, staffUserId: payload.userId, reason: "pin_reset" })` on the same tx (import from `services/pos-acting-staff-revoke.ts`). Not on "not_applicable" / same material. Make sure it runs inside `guardPinWrite` scope or after it, on the same transaction, and that `EdgeTx` fits `Tx` (cast only if types are structurally identical; explain). Check RLS context of that tx allows the update on `pos_acting_staff` (test proves it).

- Test: seed a live `pos_acting_staff` row for the staff at that outlet, apply a newer `staff_pin.set` with other material -> token `revoked_at` set, reason `pin_reset`. Same-material re-send -> token stays live.

## S4 API: GET /api/pos-overrides/:overrideId must respect the token's outlet (P2)

Files: `apps/api/src/routes/device-pin.routes.ts`, `apps/api/src/services/staff-override.service.ts` (`getPosOverride` ~:793), new test `apps/api/src/test/pos-override-outlet-scope.test.ts`.

Bug: the GET passes no outlet; with an acting-staff token of outlet A, a staff member who is also in outlet B can read AND settle (`settlePending`) a pending override of outlet B.

Fix: route passes `req.actingStaff?.outletId ?? null` to `getPosOverride` (new optional param, keep existing callers working). In the service, when an outlet is given, add `eq(posOverrides.outletId, outletId)` to the WHERE of the `FOR UPDATE` select, so a mismatch answers the same 404 as unknown and `settlePending` never runs. Check the same router for other `:overrideId` handlers that settle or change rows and apply the same scope; report them.

- Test: staff member in outlets A and B, pending override in B, GET with a token of A -> 404 and row still pending (not settled); GET with a token of B -> 200. Route-level (supertest, as other route tests do).
