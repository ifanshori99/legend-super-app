# 6c6 fix round 2 (architect round 2). Money rule: when in doubt, the choice that limits payment/access.

Files: apps/api/src/services/payment-recurring.service.ts (S), payment-webhook.service.ts invoice branch (S), payment-doit-recurring-wire.ts (S), tests apps/api/src/test/payment-recurring*.test.ts, payment-webhook-api.test.ts, payment-doit-recurring-wire.test.ts (T). Exported service signatures stay.

## Fix (S)
1. HIGH webhook ~1198-1201: every `invoice.created`/`invoice.paid` goes to the recurring parser; an invoice event that is NOT ours (no `data.invoice.subscription_id` string) must keep the old path: stored `ignored` (EVENT_TYPE_IGNORED), HTTP 200 (not MALFORMED/500). Only events with a `data.invoice.subscription_id` go to parseDoitInvoiceEvent; if it is present but the body is otherwise malformed => MALFORMED as now.
2. service ~607-613: integration check must accept the integration that actually verified the event. Compare against `subscription.gatewayIntegrationId` using the verified integration's id AND handle the old/rotated secret and two integrations sharing a secret: mirror `signedByIntentIntegration` (payment-webhook.service.ts, payment path) — find how it resolves the signing integration by id and reuse the same helper for the invoice branch. Unknown/other integration still => INTEGRATION_MISMATCH.
3. service ~854-855, ~881-890: a paid event on an invoice already `needs_review` (or moved to review because of payment) must set `paid_at` (if null) and keep status `needs_review`; never activate.
4. (NO CHANGE, strict continuity stays; CTO decision.)
5. service ~509-513 pause race: when the guarded update misses because a payment landed, re-read the row and apply `paused` anyway (same as cancel fix). Never throw CONFLICT after DOIT already paused.
6. service ~489 and ~922: period end is EXCLUSIVE (start+1 interval). Access/active check must be `periodEnd > businessDate(now)`, not `>=`.
7. service ~336, ~462: start/pause/resume/cancel must load DOIT credentials by the plan's/subscription's `gatewayIntegrationId` (not the outlet's current active integration). For createRecurringPlan the outlet's active integration is chosen and stored as today.
8. wire ~110: reject a period where `period_end <= period_start` in `parseDoitInvoiceEvent` (returns null => MALFORMED).

## Tests (T), fail-first at behavior level
- payment-webhook-api.test.ts: put back, in the ignored-event list, `invoice.created` WITHOUT `data.invoice.subscription_id` (e.g. a payload like `{id,type:'invoice.created',created_at,data:{}}` built by existing helpers) => 200 `ignored`. Do not touch other fixtures there.
- payment-recurring.test.ts: finding 2 (event verified by the integration the subscription is bound to is accepted even when another active integration of the tenant exists with the same secret / rotated secret if cheap), 3 (paid on needs_review invoice sets paid_at, stays needs_review, never active), 5 (pause vs payment race ends `paused`), 6 (a paid invoice whose period_end == today does NOT activate; period_end == tomorrow does), 7 (cancel/pause use the subscription's own integration after the outlet gets another active integration; fake client via `deps.clientFor` records which integration id it was built for), 8 (wire test: same start/end date rejected).
- Keep REC-08 strict-continuity cases unchanged.
