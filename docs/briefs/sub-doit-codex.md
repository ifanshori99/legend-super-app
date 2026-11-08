# Sub-brief: Codex second-opinion fixes on DOIT (brief 95, base 8fed84ef)

Worktree `.worktrees/doit-provider`, branch `ws/doit-provider`. API code `apps/api/src`. Money code (level K).
Rules: never read `.env*`; never pkill/killall; heavy commands via `heavy`; no git commit/stash (lead commits); do not run drizzle-kit (lead generates migrations; describe any schema change exactly in your report).
Focused DB test run (from worktree root): `LEGEND_TEST_FILES="src/test/<file> ..." heavy pnpm test`.

## Invariants
- One DOIT payment ↔ one local intent; money that DOIT collected is never left unrecorded (settled, late, or unallocated).
- Idempotency-Key and `reference` for one logical create never change across retries.
- An intent leaves reconciliation only on a definitive provider status (paid / expired / failed) or an explicit long cap; a gateway error is never definitive.
- Recorded payment time = provider time (`paid_at`) when the provider gives one.

## P1 — orphan remote payment on lost create response (payment-doit.ts:~477, payment.service.ts create/refresh)
Persist the intent row (stable id, amount, method, outlet, idempotency key) BEFORE the DOIT POST, with providerRef null; POST with that id as `reference` and a key derived from it; on success update providerRef/instructions. On retry (same link/count/amount), reuse the persisted unsent/unconfirmed intent and the same key → DOIT replays → recovered. If POST fails definitively (4xx validation), mark that row failed. Recovery path when local update failed after DOIT success: next attempt replays same key and binds. Tests: response lost after DOIT accepted → retry binds the same DOIT id, no second DOIT payment, one intent; local update throws → retry recovers.
Owns: services/payment-doit.ts (createIntent only), services/payment.service.ts create/refresh/supersede functions only, test/payment-api.test.ts, test/payment-doit.test.ts (createIntent tests).

## P2 — gateway error after expiry expires intent (payment.service.ts:~1741)
Gateway error (getStatus threw) is not definitive: never expire on it. Keep intent `pending` past expiry and keep polling with backoff (e.g. skip if gateway_polled_at newer than min(2^n·1 min, 1 h) based on time past expiry) until provider says paid/expired/failed; cap at the poll window (24 h past expiry) then expire with reason "timeout" and audit. Link view must not block or 5xx on gateway error; it may present the intent as expired-for-guest without changing DB state if that already exists, else leave as is. Also check syncExpiredIntentPayment selection grace for superseded codes (60 s) — a gateway error there must not drop it either.
Owns: services/payment.service.ts sync/poll functions only (syncPendingIntentDetailed, syncExpiredIntentPayment, pollPendingGatewayIntents, constants), test/payment-webhook-api.test.ts polling tests, test/payment-supersede-doit.test.ts.

## P3 — polling drops paid_at (payment-doit-wire.ts:~274)
Add `paidAt: string | null` to `GatewayPaymentStatus` (payment-gateway.ts), map from wire `paid_at`, use `at: providerStatus.paidAt ?? now.toISOString()` in every confirmation/unsettled-funds built from getStatus. Tests: paid 09:59 (before expiry), polled 10:01 → not late_payment, evidence receivedAt 09:59.
Owns: services/payment-gateway.ts, services/payment-doit-wire.ts, the `at:` lines in payment.service.ts sync paths (coordinate: lead applies if conflict).

## Lead decisions (supersede the slice text above where different)
- P1 design: NO new status / migration. Make the intent id deterministic: `intentId = uuidv5(namespace, tenantId + ":" + idempotencyKey)` (implement v5 with node:crypto sha1 if no `uuid` dep; set version/variant bits). Same key → same id → same DOIT `reference` + same Idempotency-Key → DOIT replays → line ~477 check passes → insert binds. readIntentPlan re-check unchanged. A dangling DOIT invoice from a failed local insert is unpaid (guest never received it) and is recovered by the retry. Document this in a code comment. Add tests: (a) DOIT accepted, response lost (fake throws after recording) → retry same key → same intent id, single DOIT payment, intent created; (b) local insert fails after DOIT success (e.g. bill locked/changed then restored) → retry same key binds. Also confirm refresh key path gets the same property.
- Slice A = P1 (own worktree via isolation; files: payment.service.ts createIntent/readIntentPlan/refresh only, payment-doit.ts createIntent only if needed, test/payment-api.test.ts, test/payment-doit.test.ts).
- Slice B = P2 + P3 together (main worktree; files: payment-gateway.ts, payment-doit-wire.ts, payment-doit.ts getStatus mapping, payment.service.ts sync/poll functions, test/payment-webhook-api.test.ts, test/payment-supersede-doit.test.ts, new test file test/payment-poll-reconcile.test.ts if cleaner).

## Round 2: review fixes (architect on b80001ff + working tree)

Worktree: `.worktrees/doit-provider`. Do not commit; the lead commits. Do not read `.env*`, no pkill. Do not run DB tests (the lead runs them); `npx tsc --noEmit -p apps/api` must stay at 0 errors.

Shared helper (owned by implementer B, imported by A), new file `apps/api/src/services/payment-paid-at.ts`:
```ts
/** DOIT's paid time if plausible (createdAt - 5 min .. now + 5 min), else `now`. Logs a warning on fallback. */
export function plausiblePaidAt(candidate: string | null | undefined, createdAt: Date | null, now: Date): string
```
`createdAt` null means: check only the upper bound (now + 5 min). Returns an ISO string.

- **A (payment.service.ts + payment-webhook-api.test.ts):**
  - (1) In `syncPendingIntentDetailed` past expiry, a settlement error that is NOT `PaymentConfirmationRejected` (DB or serialization) must count as inconclusive. The intent then stays `pending` until `GATEWAY_POLL_WINDOW_MS`, like a gateway error. Any `PaymentConfirmationRejected` stays definitive, so the intent expires as today.
  - (3) Use `plausiblePaidAt(providerStatus.paidAt, intent.createdAt, now)` in both poll paths that compute `paidAt`: `syncPendingIntentDetailed` and `syncExpiredIntentPayment`.
  - Tests: `applyConfirmation` throws once (a non-Rejected error, e.g. `vi.spyOn` or a DB trigger) past expiry, so the intent stays pending. The next poll settles it.
  - Also test: a DOIT `paid_at` in the future (+1 day) falls back to the poll time.
- **B (payment-doit-wire.ts, payment-webhook.service.ts, payment-paid-at.ts, payment-doit.test.ts):**
  - (2) Parse DOIT `paid_at` with `isoDateTimeSchema` from `@starter/shared/core`, so a timestamp without a time zone becomes null. `expires_at` stays as is.
  - (3) Create the helper above, and apply it in the webhook's `readPaidAt` path. Use the intent's `createdAt` if the caller has it; otherwise pass null.
  - Unit tests in `payment-doit.test.ts`: a zoneless `paid_at` maps to `paidAt: null`. Add helper bounds tests in a new file, `src/test/payment-paid-at.test.ts`, which needs no DB.
