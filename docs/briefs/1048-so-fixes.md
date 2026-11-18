# 1048 fix second opinion POS 936 (thread engineer, bead legend-hpgyw)

Worktree `/Users/ifanshori99/Projects/legend super app/legend-8eb871ce`, branch `ghostex/8eb871ce`.
Second opinion: `/Users/ifanshori99/Projects/legend super app/legend/docs/qa/second-opinion-pos-936-1047.md` (5 P1 + 3 P2).
Shared context of the earlier work: `docs/briefs/1039-sub-shared.md`. Tier K (money). Migration working numbers: 0672 and 0673.

## Rules for every subagent

- No vitest, tsc or build: the main thread holds the heavy token and runs the tests. Run `pnpm exec prettier --write` and `pnpm exec eslint` on the files you touch.
- Touch only the files in your own group. Do not touch `apps/web`.
- Rule "jangan sampai rugi": when in doubt, pick the rule that limits payment.
- Tests live in new files `apps/api/src/test/pos-936-so-<group>.test.ts`, ids `SO-<group>-NN`. Copy the helpers/fixtures pattern from `pos-936-points.test.ts` and `pos-936-ticket.test.ts`. A test must fail on today's code for the right reason.
- Error shape: `HttpError(status, "CODE", "pesan")` (see `pos-points.service.ts`). New codes are listed below; use exactly these.

## Decisions (CTO)

1. Manual refund does not count a points tender (`pos_order_tenders.method = 'points'`) as refundable money.
2. Points already debited on a not-yet-paid bill: void/cancel gives the points back exactly once (idempotent).
3. Training mode: points redeem and ticket slot hold are refused.
4. Points redeem needs proof the member is present: `orders.customer_attached_via` must be `member_qr` or `pwa_session`; typed phone (`phone_lookup`), null or anything else is refused.
5. Door credential (QR/PIN) must connect to a door check and be revoked on void/refund.
6. P2: an old credential key replayed after a newer mint must not change the newest pair. P2: points expiry uses the DB clock after the locks.

## Group P (points service) — owner files: `services/pos-points.service.ts`, `routes/pos-points.routes.ts` only if needed

- Training (finding 3): in redeem, before any lock/debit, `isTrainingOrder(tx, tenantId, orderId)` from `services/device-training.ts:41`; refuse `409 POINTS_TRAINING_REFUSED`. No ledger row, no tender.
- Member proof (finding 4): select `customerAttachedVia` with the order (~line 120); refuse `409 POINTS_NEED_MEMBER_PROOF` unless `member_qr` or `pwa_session`. Enum in `packages/shared/src/crm/endpoints.ts` (~238-246); `setPosOrderCustomer` writes it (`pos-order-customer.service.ts:188`). Edge-ingested orders have null: refused (redeem is cloud-only anyway). A cashier re-scanning the member QR upgrades the order to `member_qr` (existing behavior, test it). Replay of a legit redeem (same idempotency key) stays one debit.
- Expiry clock (P2): after the second `withProfileLock`, read `select clock_timestamp()` inside the tx and use it for `expirePointsForProfile` and the ledger entry instead of `input.at` (taken before the transaction). Test: hold the profile/order lock past an expiry boundary, then redeem is refused with no debit and no tender.

## Group R (refund and void) — owner files: `services/order-issue-manual-refund.ts`, `services/pos-order-corrections.ts` (payout split ~757-770 only), `services/pos-order.service.ts` (void only, ~1674-1724), new `services/pos-points-restore.ts`, migration `drizzle/0672_*.sql` + `_journal.json` + `db/schema/crm-ledger.ts` only if the point_ledger check constraints must change

- Finding 1: `order-issue-manual-refund.ts` (~97-112) sums every captured tender. Exclude `method = 'points'` (refundable money = non-points captured tenders). A bill fully paid by points: manual refund limit is 0 (refused). Mixed: limit = the non-points part. Also exclude points in the corrections payout split. Race: cashier refund + manual refund approval must not double use.
- Finding 2: void currently throws CONFLICT when `capturedIdr(tenders) > 0` (`pos-order.service.ts:1674`) and only voids `authorized` tenders. New: when every captured tender is a points tender, void is allowed: in the same transaction, on the locked order, set each points tender `voided` and post ONE ledger restore row per tender (positive points, `reversesEntryId` = the redeem row, `source_id` = tender id). Idempotency by the unique index `point_ledger_dedupe_key (tenant_id, type, source_type, source_id)`. `reverse` requires negative points: check `point_ledger_type_check` and sign rules in `db/schema/crm-ledger.ts` (~129-153) and `point-ledger.service.ts` (~131-150); the existing restore is type `adjust`. If a constraint must change, migration 0672: ALTER only with the DROP/ADD CHECK pattern of `0670_pos_points_tender.sql` (lock_timeout wrapper, NOT VALID then VALIDATE). Mixed bill (points + cash/other captured) stays refused as today: report it, do not build it. Training orders are never debited so nothing to restore.
- Test: partial redeem then void restores the exact points once (balance, tender status, ledger row); void twice and a concurrent redeem/void race give one restore; a paid-in-full order still cannot be voided; GL/journal unchanged (a pos_tender debit books no journal).

## Group T (ticket, door) — owner files: `services/facility-pos-ticket-sale.ts`, `services/facility-pos-tickets.ts`, `services/facility-pos-ticket-hold.ts`, `db/schema/facility-pos-ticket.ts`, new `services/facility-door-check.ts`, `routes/facility-pos-ticket.routes.ts`, `packages/shared/src/pos/ticket.ts` and `packages/shared/src/facility/endpoints.ts` (additions only), migration `drizzle/0673_*.sql` + `_journal.json`

- Training (finding P2-12): `sellPosTicket` must refuse BEFORE `holdFacilitySlot` when the caller device has `devices.trainingMode` (query as `pos-order.service.ts:866`); `409 TICKET_TRAINING_REFUSED`. No hold, no order, no ticket.
- Key replay (P2): table `access_ticket_credential_keys (tenant_id, outlet_id, access_ticket_id, key_digest, version, created_at)`, unique `(tenant_id, access_ticket_id, key_digest)`, FKs inside CREATE TABLE, RLS like `0671_facility_pos_tickets.sql` (`app.enforce_tenant_rls`), digest only (sha256 of the key), insert in the same tx under the existing ticket-row lock. Replay of ANY seen key (not only the last) answers `409 TICKET_CREDENTIAL_SHOWN`; version and digests of the newest pair never change. Test A -> B -> A and a concurrent replay.
- Door check (finding 5): there is NO existing door check (no endpoint, no reader sync; lock hardware is bead legend-bzih). Build the smallest cloud validator: `facility-door-check.ts` taking `{ qrToken }` or `{ ticketId, pin }`; hash with the same sha256 as `facility-pos-tickets.ts:64`; lookup by `qrDigest` (unique per tenant) or `pinDigest` (`sha256("ticketId:pin")`); refuse revoked credential, outside `validFrom/validUntil`, a rotated (not newest) version, and a ticket not `paid`/`in_use` (refunded/cancelled/void). On success set `firstOpenedAt` if null and move the ticket to `in_use` under `FOR UPDATE`. Route in `facility-pos-ticket.routes.ts` (same guard order as the sale route; permission: the facility operate permission, check what `facility.routes.ts` uses), schema in shared endpoints. Edge offline readers: out of scope, report.
- Test: pay and issue, door check by QR and by PIN opens once-state `in_use`; after rotation the old QR and PIN fail; after refund/void both fail; wrong PIN rate/format rejected; another tenant cannot check; an unpaid ticket has nothing to check.

## Evidence the main thread collects

fail-first run of the three new test files (before the fixes), then green run; regression files from `docs/PROGRESS.md` 18 Nov entry; API typecheck; contract tests; prettier/eslint; one architect xhigh on the diff, then one reviewer after fixes.
