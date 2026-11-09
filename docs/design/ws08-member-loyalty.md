# WS-08 member foundation: customer identity, consent and the point ledger

Status: design, 2026-11-10. Owner: architect (legend-u57q chain).
Cards: `legend-k2l`, `legend-111j`, `legend-m4p5`, `legend-ts50`, `legend-3zd1`,
then `legend-u57q`; one new card is proposed for the loyalty journal (§9).
Inputs: PRD v1.7 (D16, D18, A15, AUTH-01..07, §3.20 F20 lines 786-803,
LOY-01..04, §6.G lines 1859-1909, `user_identities` line 1599), the CRM
contract `packages/shared/src/crm/*` (legend-zk25), the member UI
`apps/web/src/features/ws08-member`, and the code on `milestone/m1` (d2080951).

Engineers build from this file and the per-card briefs
`docs/briefs/290a-*.md` to `290g-*.md`. Where the contract already fixes a
shape (field names, enums, error codes, the ledger sign rules), the contract
wins and this file only adds storage, authorization and concurrency.

## 1. What exists on m1 and what is missing

Exists:

- One Better Auth instance (`apps/api/src/lib/auth.ts`), plugin `admin()` only,
  `emailAndPassword` on, no email sender, no social provider, cookie prefix
  `siteConfig.id`, session lifetime 90 days. `session.kind` defaults to
  `customer` and is upgraded to `management` by the identity gate
  (`middleware/identity.ts:61`) when the user holds an active role assignment.
- WhatsApp reverse OTP (AUTH-01..04): `identity-login.service.ts`,
  `identity-wa-inbound.service.ts`, `lib/identity-session.ts`
  (`createCustomerSession`). A verified number creates a Better Auth `user`
  (placeholder email `<digest>@wa.invalid`) plus a `user_identities` row
  (`type='whatsapp'`, `value_hash` = HMAC digest, `verified_at`). So customers
  already live in the same `user` table as staff.
- `user_identities` (global, no RLS, unique `(type, value_hash)`).
  The signed-in "link WhatsApp" path refuses with `IDENTITY_ALREADY_LINKED`
  when the number belongs to another account (`identity-login.service.ts:475`);
  the merge was left to k2l.
- `consents` (append-only, tenant RLS, `subject_id` = customer profile uuid
  without FK, `source` CHECK already allows `member_pwa`). `recordConsent`
  (`consent.service.ts:129`) accepts only `cashier` and `import`.
- `orders` (`db/schema/qr-order.ts:184`) is the one order table for every
  channel (POS, QR, delivery); `pos_orders` is only the POS extension
  (`cashier_id`, `shift_id`, `device_id`). `orders.customer_profile_id`
  exists (nullable, no FK, never written). Order ids are ULIDs stored in
  `uuid` columns (`ulidInUuid`).
- Outbox `domain_event_outbox` + `domain_event_consumptions` (PK tenant,
  consumer, event_id). `order.paid` is emitted by `pos-order.service.ts` and
  `qr-order-paid.ts`; `order.refunded` by `payment-refund.service.ts` and
  `pos-order-corrections.ts`. Payloads (consumer zod in
  `accounting-auto-journal-amounts.ts:162-190`) carry `grossSalesIdr`,
  `discountIdr`, `serviceChargeIdr`, `pbjtIdr`, `totalIdr`, `paidPointsIdr`,
  `cashierId`, `businessDate`, `paidAt`; refunds carry `refundId`,
  `grossSalesIdr`, `discountIdr`, `amountIdr`. No customer id in either.
- POS points tender: a pluggable port `posPointsTenderPort()` that refuses
  ("Pembayaran dengan poin belum tersedia.").
- CoA roles `loyalty_liability` and `loyalty_breakage_revenue`; journal source
  type `'loyalty'` allowed by CHECK, written by nobody.
- `vouchers` (crm-promo) with nullable `customer_profile_id`.

Missing: magic link, Google, identity merge, `customer_profiles`, point ledger,
earn/reverse, program config, consent policy versions, member authorization,
rewards, redemptions, missions, feedback, tiers, expiry.

## 2. Decisions

### M1. One person table; members and staff are roles, not separate auth

Keep the single Better Auth instance and its `user` table as the global
person. A person is a **member of tenant T** when a `customer_profiles` row
exists for `(T, user_id)`, and **staff of tenant T** when an active role
assignment exists. The member API never accepts staff permissions as access,
and staff guards never accept a profile as access.

Why (business): the customer login that exists today (WhatsApp) already
creates `user` rows; the PRD defines one global identity graph; and the
anti-fraud rule "staff cannot earn on their own transactions" needs to
recognise that a cashier and a member are the same person. A second Better
Auth instance would duplicate the auth stack, rewrite tested WhatsApp login,
and hide exactly that link.

Rejected: a separate Better Auth instance with `member_*` tables (possible:
own `basePath`, `cookiePrefix` and `modelName`s), because of the reasons above.

Risk: a member session reaching a staff route. Already closed:
`requireTenantPermission` denies a user without assignment
(`PERMISSION_DENIED`). Kept by a test in k2l. Fallback: if a later need
appears to isolate members further, the member cookie can move to its own
Better Auth instance without touching the ledger, because every member table
keys on `customer_profile_id`, never on `user_id`.

### M2. Member sign-in methods and their limits

- WhatsApp reverse OTP (exists): primary, and the only way to verify a number.
- Email magic link: Better Auth `magicLink` plugin, `expiresIn: 600`, sender
  behind an `EmailSender` port. Production refuses with 503
  `EMAIL_NOT_CONFIGURED` until the provider key exists (Brevo proposed in
  `docs/plan/providers.md`). Addresses ending in `.invalid` are refused.
- Google: Better Auth `socialProviders.google`, enabled only when
  `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.
- `account.accountLinking: { enabled: true, trustedProviders: ["google"] }`:
  a Google sign-in with a verified email joins the magic-link user with the
  same email. Nothing ever links to a `@wa.invalid` placeholder.
- All three create `session.kind='customer'` sessions (90 days, existing).
- **Staff accounts are refused on member methods** in m1: a Better Auth
  `hooks.before` on `/sign-in/magic-link`, `/magic-link/verify` and
  `/callback/:id`, plus the existing WA login, refuses (generic answer, no
  enumeration) when the user has an active role assignment or a
  `platform_admins` row. Reason: magic link would otherwise let an email
  inbox replace a staff password plus MFA. Business impact: staff cannot use
  the member app with their staff account in m1 (they also cannot earn on
  their own transactions, see M6).

### M3. Identity graph and merge

`user_identities` gains rows for every verified method: `email` (digest of
the normalized address, written after magic-link verify or Google sign-in),
`google` (`provider_subject` = Google `sub`), `whatsapp` (exists). A person
has at most one WhatsApp identity: new partial unique index
`user_identities_one_whatsapp_per_user ON (user_id) WHERE type='whatsapp'`.

Merge happens only when a signed-in user U proves a WhatsApp number (reverse
OTP link path) that already belongs to user V:

1. V must be WhatsApp-only: no identity other than its WhatsApp row, no role
   assignment, no `platform_admins` row. Otherwise refuse 409
   `IDENTITY_MERGE_NEEDS_SUPPORT` (new code) and write an audit row; support
   resolves by hand. Reason: a WhatsApp-only account belongs to whoever
   controls the number (D16); an account with an email or Google identity
   may belong to a different person (recycled numbers).
2. U must not already hold a different WhatsApp identity (unique index).
3. One transaction, advisory locks on both user ids in sorted order:
   move V's identity rows to U; for each tenant, move V's
   `customer_profiles.user_id` to U (rules below); delete V's sessions;
   ban V (`banned=true`, `banReason='merged'`); insert `identity_merges`.
4. Profile rule per tenant: if only V has a profile, repoint it. If both have
   one, U's profile must have no ledger rows and no WhatsApp hash (it can only
   be `pending_verification`); close it (`membership_status='closed'`,
   `merged_into_profile_id` = V's profile) and re-record U's latest
   consent decisions onto V's profile (source `member_pwa`, same policy
   version). Anything else refuses with `IDENTITY_MERGE_NEEDS_SUPPORT`.

The ledger never moves: it keys on `customer_profile_id`, which survives.

### M4. Member authorization (the member sees only their own data)

Router chain for every `/api/member/*` route:
`tenantContext({ required: true, resolveDomain })` (tenant from the PWA host,
same as `/api/auth/login-challenges`) → `requireAuth` →
`requireTrustedOrigin` (mutations) → `jsonBody` (POST/PATCH) →
`requireMember({ allow })`.

`requireMember` loads `customer_profiles` by `(tenant_id, user_id =
session.user.id)` and builds `MemberScope = { tenantId, customerProfileId,
userId, status }`. No profile: 404 `CUSTOMER_NOT_FOUND` (the UI sends the
person to `/member/daftar`). Status not `active`: 403
`MEMBERSHIP_NOT_ACTIVE`, except routes that set `allow: "pending"` (profile
read, consents, consent policies). Member services take `MemberScope` as their
only identity input and never read a profile id from the path, query or body.

Database defense in depth: `withMemberScope(db, scope, fn)` = `withTenant`
with tenant-wide outlet scope plus
`set_config('app.customer_profile_id', <id>, true)`. Migration 0193 adds
`app.member_profile_id()` (returns `NULLIF(current_setting(
'app.customer_profile_id', true), '')::uuid`) and
`app.enforce_member_rls(regclass)`, which adds

```sql
CREATE POLICY member_self ON <table> AS RESTRICTIVE FOR ALL
  USING (app.member_profile_id() IS NULL
         OR customer_profile_id = app.member_profile_id())
  WITH CHECK (app.member_profile_id() IS NULL
         OR customer_profile_id = app.member_profile_id());
```

Applied to every table with a `customer_profile_id` that a member route reads
(`customer_profiles` uses `id`, so it gets its own policy text). Staff and
worker paths never set the GUC, so the policy is inert for them. A test
asserts that member route modules import `withMemberScope` and never
`withTenant` directly.

### M5. Point ledger invariants (LOY-01..03)

Storage rules for `point_ledger`:

- Append-only: `BEFORE UPDATE OR DELETE` trigger raises
  `point_ledger is append-only (LOY-01)`; `legend_app` gets SELECT and INSERT
  only (same pattern as `stock_ledger`, `drizzle/0017_inventory_rls.sql`).
- Balance = sum of ledger, enforced by the database: an `AFTER INSERT`
  trigger (`SECURITY DEFINER`, owned by the migrator) adds `NEW.points` to
  `customer_profiles.points_balance`; `CHECK (points_balance >= 0)` aborts any
  insert that would go negative. `legend_app` has no UPDATE privilege on the
  `points_balance` column (column-level grant on every other column). A
  nightly check job compares balance and ledger sum and writes a
  `balance_mismatch` anomaly if they differ.
- One writer at a time per member: every ledger insert runs inside
  `withProfileLock(tx, profileId)` (`SELECT … FROM customer_profiles WHERE id
  = $1 FOR UPDATE`). The daily cap, balance checks and redemption checks read
  under that lock.
- Idempotency: unique `(tenant_id, type, source_type, source_id) WHERE
  source_id IS NOT NULL` = `pointLedgerDedupeKey` in the contract. Earn uses
  `source_type='order'`, `source_id` = order id. Reverse uses `'refund'` +
  refund id (so several partial refunds each post once). Redeem uses
  `'reward_redemption'` + redemption id. Expire uses `'expiry'` + the id of
  the grant row it expires (so the job can rerun). Mission/referral/birthday
  bonuses use their progress id, the referral id (referrer) or first order
  id (referee), and a UUIDv5 of `<profileId>:<year>` (birthday).
- Liability: `liability_idr = points * point_value_idr` (CHECK), with
  `point_value_idr` copied from the program on every row. The program's
  `point_value_idr` is locked after the first ledger row
  (`point_value_locked_at`, trigger refuses the change). Sum of
  `liability_idr` therefore always equals outstanding points times the one
  point value. Changing the value later is a finance project, not a setting.
- CHECKs mirror the contract `superRefine`: sign per type, allowed
  `source_type` per type, `expires_at` required on earn/bonus and null on
  redeem, `reason` required on adjust.
- Every insert also writes the matching outbox event in the same transaction
  (`points.earned`, `points.reversed`, `points.redeemed`, `points.expired`,
  payloads in `packages/shared/src/crm/events.ts`).

### M6. Earn and reverse, tied to the existing payment events

Who is the member on an order:

- `orders.customer_profile_id` (exists) plus new columns on `orders`:
  `customer_attached_by` (text, user id), `customer_attached_via`
  (`member_qr`, `phone_lookup`, `pwa_session`, `receipt_claim`),
  `customer_attached_at`. Nothing is added to `pos_orders`.
- POS: `PUT /api/pos/orders/:orderId/customer` with `{ memberToken }` (the
  rotating QR from the member page) or `{ whatsappNumber }` (cashier lookup;
  flagged for anomaly review). Allowed while the order is unpaid.
- QR self-order: when the guest has a member session with an active profile in
  that tenant, order creation sets the profile (`pwa_session`).
- After payment the profile cannot change (trigger), except NULL to a value
  through `receipt_claim` within 24 hours of `paid_at` (PRD line 609; the claim
  endpoint itself is a later card, default off).
- Member QR token: `POST /api/member/qr-token` returns an HMAC token over
  `(tenant_id, customer_profile_id, exp, nonce)`, 120 s lifetime, key derived
  from `BETTER_AUTH_SECRET` with a separate label. Stateless.

Consumer `loyalty-earn` (outbox, pattern of
`accounting-auto-journal-consumer.ts`: runs inside the consumption
transaction, savepoint per event, parks failures):

On `order.paid`:

1. Read `orders.customer_profile_id` (and `pos_orders.cashier_id` for POS)
   for the event's `orderId`. None: done (no record). Gross sales in the
   payload already exclude service and PBJT for nett-price orders
   (`orderRevenueSplit`, legend-zmc2, `pos-order.service.ts:1248`).
2. Upsert `point_earn_records` by `(tenant_id, order_id)`; an existing record
   means replay: done.
3. Lock the profile. Decide, in this order, and store the outcome on the
   record: program inactive → `skipped_program_inactive`; profile not active
   or WhatsApp not verified or loyalty consent not active at `paidAt` →
   `blocked_not_member`; self-serve (below) → `blocked_self_serve` + anomaly.
4. `eligibleSpendIdr = max(0, grossSalesIdr − discountIdr − paidPointsIdr)`.
   Gross sales are before service and PBJT (`orderRevenueSplit`); a test
   still pins it for a nett-price outlet and for the QR paid path
   (`qr-order-paid.ts`). Points tender is subtracted so points never earn
   points.
5. `points = pointsForSpend(program, eligibleSpendIdr, tierMultiplierBp)`
   (contract function; multiplier 10 000 until 3zd1 ships tiers).
6. Daily cap (`antiFraud.dailyPointCapPerCustomer`, per tenant, per
   `businessDate`): `booked = min(points, cap − alreadyBookedToday)`; the
   cut-off part is stored as `capped_points` and raises a `daily_cap_hit`
   anomaly. `booked = 0` → outcome `capped`, no ledger row.
7. Insert the `earn` row (`expires_at = paidAt + expiryMonths`), set the
   record to `booked`, insert the visit row, emit `points.earned`.

Self-serve (`antiFraud.employeeSelfServeBan`): blocked when the order's
`cashierId` or `customer_attached_by` is the profile's `user_id`, or when that
staff user's WhatsApp identity digest equals the profile's `whatsapp_hash`.
QR orders paid by the guest through the gateway have no serving staff.

On `order.refunded`:

1. Find the record for `orderId`; none or not booked: done.
2. `refundEligible = max(0, grossSalesIdr − discountIdr)` of the refund
   event; add to `refunded_eligible_idr` (capped at `eligible_spend_idr`).
3. `target = ceil(booked_points × refunded_eligible_idr / eligible_spend_idr)`
   (cumulative, rounds against the member, full refund = all points).
   `delta = target − reversed_points`.
4. Under the profile lock: `posted = min(delta, points_balance)`. Insert a
   `reverse` row for `−posted` (`source_id` = refund id,
   `reverses_entry_id` = the earn row). If `posted < delta`, store the
   shortfall and raise `refund_after_redeem`; the balance never goes negative.
5. Record becomes `reversed` when `reversed_points = booked_points`.

### M7. Consent with `member_pwa` and versioned policies

- New table `consent_policy_versions` (tenant): one row per `(purpose,
  version)` with the policy text hash and `published_at`. The active version
  of a purpose is the latest `published_at <= now()`. Tenants are seeded with
  `2026-01` for `loyalty`, `marketing`, `ai` by
  `db/backfill-tenant-defaults.ts` and tenant provisioning (matches the UI
  fallback `FALLBACK_POLICY_VERSION`).
- New `recordMemberConsent(scope, { purpose, granted, policyVersion })` in
  `consent.service.ts`, source fixed to `member_pwa`, `recorded_by` = the
  member's user id, `subject_id` = profile id. A grant with a version other
  than the active one fails 409 `CONSENT_POLICY_OUTDATED` (new code). A
  withdrawal accepts any version. The staff `recordConsent` stays as it is.
- Signup: `POST /api/member/consents` with `loyalty` granted creates the
  profile when the person has none in that tenant (name from the account,
  WhatsApp hash and `whatsapp_verified_at` from the identity graph). The
  status becomes `active` when the WhatsApp is verified and the loyalty
  consent is active, otherwise `pending_verification`. Withdrawing `loyalty`
  sets `suspended` (earn and redeem stop; the balance stays; points still
  expire). `marketing` keeps `marketing_opt_in` in sync.
- New read `GET /api/member/consent-policies` returns the active version per
  purpose (contract addition, replaces the UI fallback).

### M8. Migration order and numbering

Reserved `0193`-`0197`, `when` 1794272000000-1794276000000 in steps of
1000000. Numbers follow merge order; if the merge order changes, the merge
train renames the files and `when` values, nothing else.

| # | Card | Content |
|---|---|---|
| 0193 | legend-111j | `customer_profiles`, `consent_policy_versions`, `loyalty_programs`, `point_ledger`, `point_earn_records`, `customer_visits`, `loyalty_anomalies`; order attach columns; `app.member_profile_id()`, `app.enforce_member_rls()`; triggers and grants |
| 0194 | legend-k2l | `identity_merges`; `user_identities_one_whatsapp_per_user` |
| 0195 | legend-m4p5 | `rewards`, `reward_redemptions`, `missions`, `mission_progress` |
| 0196 | legend-ts50 | `feedback`, `segments`, `segment_members` |
| 0197 | legend-3zd1 | `loyalty_tiers`, `customer_profiles.tier_id` (FK), `customer_tier_history`, `referrals` |

111j goes first because k2l's merge repoints `customer_profiles`. k2l's
sign-in work (magic link, Google, staff refusal, identity rows) does not need
0193 and starts in parallel; only its merge slice rebases on 111j.

## 3. Tables

All tenant tables: composite PK `(tenant_id, id)`, FKs inside `CREATE TABLE`
(contracts.md pattern 1), `SELECT app.enforce_tenant_rls(...)`; tables with
`outlet_id NOT NULL` also `app.enforce_outlet_rls(...)`; member-read tables
also `app.enforce_member_rls(...)`. Money `*_idr` bigint (`idrColumn`).
Points `bigint` (contract caps at safe integer).

### 0193 (legend-111j)

`loyalty_programs` (T): `id`, `tenant_id`, `name`, `earn_spend_idr` (>0),
`earn_points` (>0), `expiry_months` (1-60, default 12), `rolling_months`
(1-60, default 12), `point_value_idr` (>0), `daily_point_cap_per_customer`
(null = none, default 1000), `employee_self_serve_ban` (default true),
`referral` jsonb (contract `referralRulesSchema`, default off),
`is_active` (default **false**), `point_value_locked_at`, `updated_at`,
`updated_by`. Unique `(tenant_id)`: one program per tenant.

`customer_profiles` (T, not outlet-owned): contract fields plus
`user_id` text null (Better Auth id, UUID form), `home_outlet_id` null,
`merged_into_profile_id` null, `updated_at`. Unique
`(tenant_id, user_id) WHERE user_id IS NOT NULL`; unique
`(tenant_id, whatsapp_hash) WHERE whatsapp_hash IS NOT NULL AND
membership_status <> 'closed'`; unique `(tenant_id, referral_code)`. CHECKs:
`points_balance >= 0`, status enum, `active ⇒ whatsapp_verified_at IS NOT
NULL`, `birth_month_day ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'`.
Member policy `member_self` on `id`.

`point_ledger` (T): `id` char(26) ULID, `tenant_id`, `customer_profile_id`,
`outlet_id` null (where it happened, reporting only), `type`, `points`,
`source_type`, `source_id` text null, `reverses_entry_id` char(26) null,
`expires_at` null, `point_value_idr`, `liability_idr`, `business_date`,
`reason` varchar(300) null, `created_by` text null, `posting_seq` bigint
identity, `created_at`. Constraints from M5. Index
`(tenant_id, customer_profile_id, posting_seq)`.

`point_earn_records` (T+O): `id`, `tenant_id`, `outlet_id`, `order_id` text,
`channel`, `customer_profile_id`, `state` (`booked`, `reversed`, `skipped`,
`blocked`, `capped`), `outcome_reason`, `business_date`, `paid_at`,
`eligible_spend_idr`, `computed_points`, `capped_points`, `booked_points`,
`refunded_eligible_idr`, `reversed_points`, `reversal_shortfall_points`,
`earn_entry_id`, `created_at`, `updated_at`. Unique `(tenant_id, order_id)`.
Mutable, written only under the profile lock.

`customer_visits` (T+O, member policy): `id`, `tenant_id`, `outlet_id`,
`customer_profile_id`, `order_id`, `business_date`, `visited_at`,
`spend_idr` (eligible spend), `item_count`. Unique `(tenant_id, order_id)`.
Written for every paid order with an active member, also when the earn is
blocked or capped. `visits_count`, `lifetime_spend_idr`, `first_visit_at`,
`last_visit_at` on the profile are updated in the same transaction.

`loyalty_anomalies` (T+O): `id`, `tenant_id`, `outlet_id`,
`customer_profile_id` null, `order_id` null, `kind` (`daily_cap_hit`,
`self_serve_blocked`, `refund_after_redeem`, `phone_lookup_attach`,
`balance_mismatch`), `details` jsonb, `created_at`, `reviewed_by`,
`reviewed_at`. Staff read with a new permission `crm.loyalty.review`.

Order columns: `orders` + `customer_attached_by`, `customer_attached_via`,
`customer_attached_at`; FK `(tenant_id, customer_profile_id)` →
`customer_profiles (tenant_id, id)` on the existing column. `orders` is an
existing FORCE table: add the FK with contracts.md pattern 2 (lift FORCE on
`orders` and `customer_profiles`), and check first that every existing
non-null `customer_profile_id` is null (it is never written today). Trigger
`orders_customer_lock` from M6.

Consents: no schema change (`member_pwa` is already allowed).

### 0194 (legend-k2l)

`identity_merges` (global, like `user_identities`; no tenant): `id`,
`survivor_user_id`, `absorbed_user_id` (unique), `trigger`
(`whatsapp_link`, `support`), `identity_ids` uuid[], `profile_moves` jsonb
(`[{tenantId, profileId, action}]`), `created_at`, `created_by`. Append-only
trigger, `legend_app` SELECT and INSERT.
Index `user_identities_one_whatsapp_per_user`. The migration first checks
for duplicates and raises with a clear message instead of failing on the
index.

### 0195 (legend-m4p5)

`rewards` (T, catalog, not member-owned): contract fields plus
`per_customer_limit` int null, `redemption_valid_days` (default 30),
`created_by`, `updated_at`. CHECK type rules (voucher has value and no item;
item rewards have an item and no value). `stock` null = unlimited, CHECK
`>= 0`.

`reward_redemptions` (T, member policy): contract fields plus
`ledger_entry_id`, `voucher_id` null, `expires_at`, `fulfilled_outlet_id`
null, `fulfilled_by` null, `restore_entry_id` null. Unique
`(tenant_id, customer_profile_id, idempotency_key)`; unique
`(tenant_id, redemption_code)`. Status transitions per contract, trigger
refuses others.

Redeem (`POST /api/member/rewards/:rewardId/redemptions`), one transaction:
lock the profile, then `SELECT … FROM rewards … FOR UPDATE`; replay of the
same idempotency key returns the first redemption; run the contract
`rewardRedemptionCheck`; decrement stock; insert the redemption, the `redeem`
ledger row (`−pointsCost`), and for voucher rewards a `vouchers` row
(`customer_profile_id`, `source='loyalty_reward'`, value, validity); emit
`points.redeemed`. Errors map to the contract codes (`POINTS_INSUFFICIENT`,
`REWARD_OUT_OF_STOCK`, `REWARD_EXPIRED`, `REDEMPTION_LIMIT_REACHED`).
Cancel (member before use, or staff) and expiry of a pending redemption put
the points back with an `adjust` row (`source_type='adjustment'`,
`source_id` = redemption id, reason `redemption_cancelled` or
`redemption_expired`) and restore stock. Fulfilment at the cashier:
staff enters the code, the item or voucher is applied to the order.

`missions` (T): contract fields. `mission_progress` (T, member policy):
contract fields plus `period_key` (`2026-11`, `2026-W46`, or the range);
unique `(tenant_id, mission_id, customer_profile_id, period_key)`. Progress
moves in the `loyalty-earn` consumer after the visit row (same
transaction); completion issues the reward once (`bonus` row with
`source_type='mission'`, `source_id` = progress id, or a voucher).
Refund of the order does not undo mission progress in m1 (stated in the UI
copy; review if abused).

Vouchers: no new table; `GET /api/member/vouchers` reads `vouchers` by
profile.

### 0196 (legend-ts50: Customer 360, segments, feedback)

The card covers three things; all are staff reads of member data, so it is
level K (personal data).

Customer 360 (`GET /api/customers`, `GET /api/customers/:customerProfileId`,
contract `customer360Schema`): no new table; reads profiles, consents,
visits, favorites, feedback and vouchers. The WhatsApp number is shown
masked; the full number needs a new permission `crm.customer.pii.read`, is
read from `user_identities.value_encrypted`, and every reveal writes an audit
row.

Segments (`GET`/`POST /api/segments`, `POST /api/segments/preview`, contract
`segmentRuleSchema`/`segmentDefinitionSchema`): `segments` (T) stores the
definition; `segment_members` (T, `segment_id`, `customer_profile_id`,
`materialized_at`, unique `(tenant_id, segment_id, customer_profile_id)`) is
rebuilt by a worker job daily and when a segment is saved. RFM inputs come
from `customer_visits`. Campaigns (legend-113e) read `segment_members` and
still check marketing consent per send (LOY-04).

`feedback` (T+O): contract fields plus `handled_note`. Member policy applies
on `customer_profile_id` (rows from QR guests have null profile and are
invisible to members). Unique `(tenant_id, order_id, customer_profile_id,
kind)` for member feedback on an order. A member may only reference their own
order (`customer_profile_id` match) or a table session they joined
(`session_participants.user_id`). Staff queue with `crm.feedback.*`
permissions and the contract `transitionFeedback`.

### 0197 (legend-3zd1)

`loyalty_tiers` (T): contract fields, unique `(tenant_id, rank)`.
`referrals` (T, member policy on `referrer_profile_id`): contract
`referralSchema` fields; unique `(tenant_id, referee_profile_id)` (one
referrer per person). Flow: the referee enters the referrer's
`referral_code` at signup; the row starts `pending`; the `loyalty-earn`
consumer qualifies it on the referee's first paid order of at least
`minFirstOrderIdr` and books two `bonus` rows (`source_type='referral'`;
referrer `source_id` = referral id, referee `source_id` = the first order id,
so the two rows never collide on the unique key); the referrer's monthly cap
is checked under the referrer's profile lock; self-referral and a referee
whose WhatsApp hash already had a profile are refused.
`customer_profiles.tier_id` (FK, pattern 2) and `tier_evaluated_at`.
`customer_tier_history` (T, append-only): profile, from, to, reason, stats,
`created_at`. Nightly tier job uses `customer_visits` for the rolling window
and the contract `evaluateTier`; emits `tier.changed`. The earn consumer
starts reading the tier multiplier.

Expiry job (no new table): per profile, under the lock,
`expirable = Σ over grants with expires_at <= now of (grant − reversals of
that grant) − Σ redeem/negative adjust − Σ previous expire`, consumed oldest
first; one `expire` row per expired grant (`source_id` = grant id). Emits
`points.expired`. A 30-day reminder list feeds the notification card later.
Birthday bonus (tier benefit) runs in the same job family; its
`source_id` is a deterministic UUIDv5 of `<profileId>:<year>` (the contract
requires a uuid or ULID), so a rerun books once.

## 4. API surface per card

| Card | Member routes | Staff routes |
|---|---|---|
| 111j | `GET /api/member/profile`, `GET /api/member/points`, `POST /api/member/consents`, `GET /api/member/consent-policies` (new), `POST /api/member/qr-token` (new) | `PUT /api/pos/orders/:orderId/customer` (new), `GET`/`PUT /api/loyalty/program`, `GET /api/customers/:customerProfileId/points`, anomaly list (new) |
| k2l | Better Auth `/api/auth/sign-in/magic-link`, `/api/auth/magic-link/verify`, `/api/auth/sign-in/social` (google) | support merge view (read) |
| m4p5 | `GET /api/member/rewards`, `POST /api/member/rewards/:rewardId/redemptions`, `POST /api/member/redemptions/:redemptionId/cancel` (new), `GET /api/member/missions`, `GET /api/member/vouchers` | `/api/loyalty/rewards`, `/api/loyalty/missions` CRUD, `POST /api/loyalty/redemptions/fulfil` (new) |
| ts50 | `POST /api/member/feedback` | `GET /api/customers`, `GET /api/customers/:customerProfileId`, `/api/segments` (+ preview), `GET /api/feedback`, `PATCH /api/feedback/:feedbackId` |
| 3zd1 | tier fields in profile, referral code at signup | `/api/loyalty/tiers` CRUD, job status |
| u57q | `GET /api/member/overview`, `GET /api/member/visits`, `GET /api/member/favorites`, `PATCH /api/member/profile` (new), web switched from mocks to the API, e2e | - |

New endpoints and error codes (`IDENTITY_MERGE_NEEDS_SUPPORT`,
`CONSENT_POLICY_OUTDATED`, `EMAIL_NOT_CONFIGURED`) are additive changes to
`packages/shared/src/crm/endpoints.ts` and `errors.ts`, made by the card that
needs them.

## 5. Accounting (proposed card, see §9)

Consumer `loyalty-journal` on the points events, source type `'loyalty'`:

- `points.earned` / bonus: Dr `loyalty_points_deferral` (new contra-revenue
  role under 4100), Cr `loyalty_liability`, amount `liabilityIdr`.
- `points.reversed`: the mirror entry.
- `points.redeemed`: Dr `loyalty_liability`, Cr `sales_discount` (the free
  item or voucher appears as a discount on the order where it is used, so
  the two cancel and the deferred revenue is recognised).
- `points.expired`: Dr `loyalty_liability`, Cr `loyalty_breakage_revenue`.
- Restore of a cancelled redemption: mirror of the redeem entry.

Needs the accounting second opinion and the founder's accountant (Q7).

## 6. Risks

1. WhatsApp verification at Meta is still pending (PRD R05). No verified
   WhatsApp means no earn and no redeem (AUTH-07), so loyalty is dark until
   WhatsApp is live, even though sign-in by email or Google works.
2. Refund after redeem: the balance cannot go negative, so the reward bought
   with refunded points is lost to the business. Mitigation: the refund
   approval screen shows the shortfall before approval; anomaly row.
3. Recycled WhatsApp numbers: a WhatsApp-only account goes with the number.
   Points expire after 12 months, and numbers are recycled after long
   inactivity, so the exposure is small.
4. Phone-lookup attach lets a cashier attach any registered number. Flagged
   per attach and reviewed; when WhatsApp is live the member gets a
   "poin masuk" message (notification card).
5. `grossSalesIdr` excludes service and PBJT through `orderRevenueSplit`
   on the POS path; the QR paid path is pinned by a test too.
6. The point value locks at the first issued point; the founder must set it
   before launch.
7. `customer_profile_id` columns in the existing promo tables have no FK.
   Left as is (out of scope).

## 7. Tests that must fail first (summary; details in the briefs)

- Ledger: UPDATE and DELETE refused for `legend_app`; balance equals ledger
  sum after random sequences; a negative-balance insert aborts; the same
  order paid event twice books once; two partial refunds reverse exactly
  `booked_points` in total; full refund after redeem clamps and records the
  shortfall; daily cap across two outlets on one business day.
- Isolation: member A cannot read B's profile, points, redemptions, visits,
  feedback through any route; with the GUC set, a raw select of B's rows
  returns nothing; a member session gets 403 on a staff route; a staff user
  without a profile gets 404 on member routes.
- Identity: staff email refused on magic link; Google joins the magic-link
  user with the same verified email; merge of a WhatsApp-only account moves
  profiles and bans the absorbed user; merge refused when the other account
  has an email identity.
- Consent: grant with an old version 409; withdrawal of loyalty suspends;
  staff path still refuses `member_pwa`.
- Redemption: 20 parallel redeems with stock 1 give exactly one success;
  replay of an idempotency key returns the first redemption.

## 8. Defaults used until the founder answers

Program created inactive per tenant. Earn Rp10.000 = 1 point; point value
Rp100; expiry 12 months; tier window 12 months; daily cap 500 points;
self-serve ban on; referral off; points tender stays refused; cancelled and
expired redemptions restore points; receipt claim off. All are columns of
`loyalty_programs` or feature flags, changeable without code.

## 9. Card plan

See `docs/briefs/290a-*` to `290g-*`. Summary:

| Brief | Card | Level | Depends on | Parallel with |
|---|---|---|---|---|
| 290a | legend-111j profile, consent, ledger, earn/reverse | K | - | 290b |
| 290b | legend-k2l magic link, Google, identity graph, merge | K | merge slice on 290a | 290a |
| 290c | legend-m4p5 rewards, redemptions, missions, vouchers | K | 290a | 290d, 290e, 290f |
| 290d | legend-ts50 Customer 360, segments, feedback | K | 290a | 290c, 290e, 290f |
| 290e | legend-3zd1 tiers, expiry, birthday, referral | K | 290a | 290c, 290d, 290f |
| 290f | new card: loyalty journal | K | 290a (+290c for redeem) | 290c-290e |
| 290g | legend-u57q member API rest + web wiring | K | 290a-290e | - |
