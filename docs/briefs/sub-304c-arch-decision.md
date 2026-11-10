# D-msqvi: Points journal (PSAK 72) — decision record (architect, 10 Nov 2026)

Status: proposed. Needs founder accountant (Q7) and Codex second opinion (xhigh) before release.
Note: IAI renumbered PSAK 72 as PSAK 115 from 2024 (same content as IFRS 15). A private entity may report under SAK EP instead. The accountant confirms which one applies (Q7).

## 1. Policy

- Points are a material right. This is a separate performance obligation.
- Earn: defer the fair value of the points. Fair value = points x Rp100 (Q68) x expected redemption rate.
- The rate stays at 100% in v1, because there is no history yet. With 100%, no breakage is estimated up front. Breakage is recognised only when points expire (remote-breakage approach).
- Allocation uses face value, not relative standalone selling price. Earn is 1 point per Rp10.000 and 1 point = Rp100, so face value is 1.00% of the sale. The relative SSP would be 0.990%. The gap is about 1% of the deferral, which is immaterial. Q7 confirms.
- Bonus points (mission, referral, birthday) are consideration payable to the customer (PSAK 72 para 70). They also reduce revenue. Referral points could instead be marketing expense: Q7 decides.
- Recognition happens at `points.redeemed`, when points become a voucher or free item (brief 304 C). Known limitation: redemptions still pending at period end (`redemptionValidDays`, default 30, max 365) are recognised early. The `points.adjusted` restore reverses this if the redemption is cancelled or expires.

## 2. Accounts

- New role `loyalty_points_deferral`, type `revenue`. Seed account 4105 "Penangguhan Pendapatan Poin Loyalty", parent 4100. It is a contra-revenue account and the code is unused today.
- Existing roles: `loyalty_liability` = 2105, `loyalty_breakage_revenue` = 4104.
- Do not use `sales_revenue` 4101: it must keep matching gross POS sales.
- Do not use `sales_discount` 4103 for redemptions. This replaces design §5 and brief 290f. Two reasons:
  - A free item fulfilled without an order would leave 4103 with a credit balance.
  - The voucher used on an order already debits 4103 through `order.paid` `discountIdr`. That is a separate fact.
- Result: 4105 net = earned - redeemed, which is the movement of the deferred revenue.

## 3. Entries

Amount = `liability_idr` read from the point_ledger row. The value is signed, and the row is the authority, not the payload.

| Event                                                | Debit         | Credit                                     |
| ---------------------------------------------------- | ------------- | ------------------------------------------ |
| points.earned (order, mission, referral, birthday)   | 4105 deferral | 2105 liability                             |
| points.reversed (refund, void)                       | 2105          | 4105 (exact mirror of the reversed amount) |
| points.redeemed (source_type reward_redemption only) | 2105          | 4105                                       |
| points.adjusted restore (+)                          | 4105          | 2105 (mirror of the redeem)                |
| points.adjusted manual (+)                           | 4105          | 2105                                       |
| points.adjusted manual (-)                           | 2105          | 4105                                       |
| points.expired                                       | 2105          | 4104 breakage                              |

How the rules are written:

- `points.adjusted` is ONE rule: Dr deferral / Cr liability, `pointsValueIdr` = signed `liability_idr`. A negative amount flips the sides (`buildJournalLinesFromRule`).
- Replace the existing `points.earned` rule (Dr sales_revenue). It was never wired: AUTO_JOURNAL_EVENTS lacks it.
- Add rules for `points.reversed`, `points.redeemed` and `points.adjusted`.

## 4. No double count with order.paid / order.refunded

- `paidPointsIdr` and `refundPointsIdr` are only for points used as tender. Points tender stays refused, so both stay 0.
- If points tender ever ships, its ledger row needs a distinct source_type. This consumer must ignore that row, because the sale journal already moves 2105.
- A pin test is required: the consumer journals `points.redeemed` only for `reward_redemption`.

## 5. Idempotency

- Key: `aj:loyalty:<ledgerEntryId>`. One ledger row = one journal.
- Journal fields: `source_type='loyalty'`, `source_id` = ledger ULID.
- Same advisory lock and lookup-first as `settleAutoJournal`.
- The payload has no entry id, and `points` is abs(), so the sign is lost for manual adjustments. Fix: add an additive `ledgerEntryId` (ULID, optional in the schema, B11) to all 5 points.* payloads. The value comes from `eventFor` base in point-ledger.service.ts.
- If the field is missing, the consumer parks AUTO_JOURNAL_PAYLOAD_INVALID. Loyalty is dark, so no production events exist yet.

## 6. Guards

- Accounting module enabled: use the existing `accountingEnabled`.
- Do NOT gate on `loyalty_programs.is_active`. Switching a program off would strand the liability on later expire, redeem and reverse events. "Tenant switched on" is still enforced, because the earn consumer only writes ledger rows while the program is active.
- Training orders:
  - `points.earned` with source order: if `isTrainingOrder(sourceId)`, ignore.
  - `points.reversed`: look up the reversed earn row and check its order. If it is a training order, ignore.

## 7. Legal entity and outlet (no migration)

- Points events have outletId null, and auto_journal_parked.outlet_id is NOT NULL.
- v1 supports only tenants whose outlets all share ONE legal entity. All loyalty journals post there.
- Journal outlet_id:
  - ledger.outlet_id for earn;
  - the reversed row's outlet for reverse;
  - null (entity-level) otherwise.
- Business date comes from ledger created_at and an anchor outlet clock. The anchor is the oldest outlet of that entity, which is also used for parking.
- Tenants with more than one entity park non-retryable `LOYALTY_LEGAL_ENTITY_AMBIGUOUS`. Follow-up card: `loyalty_programs.legal_entity_id`. That card needs migration 0212.
- Migration: NONE for this card. Roles are varchar without a CHECK, `'loyalty'` is already in the source_type CHECK, and the new account and mapping go in through backfill.

## 8. Steps (files)

1. packages/shared/src/accounting/coa.ts: add the role and the 4105 seed row.
2. packages/shared/src/accounting/posting-rules.ts: change the rules as in §3.
3. packages/shared/src/crm/events.ts + apps/api/src/services/point-ledger.service.ts: add `ledgerEntryId`.
4. apps/api/src/services/accounting-auto-journal-amounts.ts:
   - add the 5 events;
   - read the stored event;
   - key `loyalty:<id>`;
   - fact from the point_ledger row.
5. apps/api/src/services/accounting-auto-journal-consumer.ts: entity/anchor resolution and the training guard for points.
6. apps/api/src/db/backfill-tenant-defaults.ts + provisioning:
   - insert 4105 and the mapping per entity;
   - skip if code 4105 is taken. The posting then parks retryable ACCOUNT_MAPPING_MISSING.
7. apps/api/src/test/loyalty-journal.test.ts: balanced, once per event, partial reverse, void, restore, manual +/-, tenant isolation, training ignored, multi-entity parked.
8. docs/DECISIONS.md, docs/briefs/304c-second-opinion-points-journal.md.

## 9. Risks

- The earn consumer does NOT skip training orders (loyalty-earn-consumer.ts has no isTrainingOrder). Training orders award real points. New card needed.
- A `bonus` row with source_type `adjustment` emits no event (`eventFor` returns null), so it is never journaled. Positive manual adjustments must use type `adjust`. No producer exists today.
- Accounting switched on after points already exist: redeem and expire would push 2105 into a debit balance. Finance must post an opening balance for 2105.
- Early recognition of pending redemptions (§1).
- The 100% rate can never change silently. A rate below 100% needs the rate stored per ledger row (migration) plus breakage-pattern recognition.
