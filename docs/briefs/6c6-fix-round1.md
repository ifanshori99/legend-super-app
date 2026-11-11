# 6c6 fix round 1 (typecheck log + architect review)

Typecheck log: `/private/tmp/claude-501/6c6-tsc1.log` (18 errors: 5 in payment-recurring.service.ts lines ~588/664 etc. e.g. `amountIdr` number vs branded Idr, `eq(tenantId, ...)` overload on subscription_invoices; 13 in payment-recurring-isolation.test.ts: tests called service fns with 3 args / read `.data` / passed string where Date). Service signatures are the truth; do NOT change exported signatures (tests align to them).

## Architect findings (fix all)
1. HIGH `payment-webhook.service.ts` invoice branch (~1244-1260): never checks which DOIT integration signed. Fix: add `gateway_integration_id` uuid NOT NULL to `payment_recurring_plans` and `payment_recurring_subscriptions` (set from the loaded integration id at plan creation `payment-recurring.service.ts` ~85, copied to subscription from its plan). When verified integration id != subscription's `gateway_integration_id`: store event as failed/ignored with code `INTEGRATION_MISMATCH`, change nothing. Mirror `signedByIntentIntegration` in the payment path.
2. HIGH service ~508-513: invoice period not checked vs plan interval. Require `period_end == period_start + interval` (month: +1 calendar month; week: +7 days) and, when subscription has `currentPeriodEnd`, `period_start == currentPeriodEnd` (continuity). Otherwise invoice stored `needs_review`, `review_reason='PERIOD_MISMATCH'`, no notification, paid never activates.
3. MED service ~748-774: paid invoice sets `active` even if period not advanced / already past. Set `active` only if period advances AND `period_end >= business date of now`; else mark invoice paid, keep status, `review_reason` note not needed.
4. MED service ~679/~608: paid invoice whose period is already taken is ignored (money hidden). Fix: period unique index becomes partial `WHERE status IN ('open','paid')`; a second invoice for a taken period is stored `needs_review` `DUPLICATE_PERIOD` when the older one is open/paid, never silently ignored.
5. MED service ~379-422 cancel: DOIT cancel then guarded update can lose to concurrent invoice.paid. When guarded update misses on cancel, re-read the row and apply `cancelled` anyway.
6. MED migration snapshot missing: lead runs db:generate later; do not hand-write it.
7. MED service ~265: `customerProfileId` must exist in tenant (`customer_profiles` by `(tenant_id,id)`) and `merged_into_profile_id IS NULL`, else 404/422 (HttpError style used in the file).

## Ownership this round
- M (schema/migration): `db/schema/payment-recurring.ts`, `drizzle/0285_payment_recurring_billing.sql` only (findings 1 columns, 4 partial index).
- S (service): `services/payment-recurring.service.ts`, `services/payment-webhook.service.ts` invoice branch only, plus the 5 tsc errors. Column names: `gatewayIntegrationId` (db `gateway_integration_id`).
- T (tests): both test files: fix compile errors to real service signatures/return shapes, and add fail-first cases for findings 1,2,3,4,5,7 (behavior-level; integration seeding via existing helpers).
