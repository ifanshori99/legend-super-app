# Sub-brief 290a: slices and shared interfaces (legend-111j)

Worktree: `.worktrees/ws08-111j`, branch `ws/ws08-111j`. Source of truth: `docs/briefs/290a-111j-profile-consent-ledger.md`,
`docs/briefs/290-aturan-bersama.md`, `docs/design/ws08-member-loyalty.md` (§M4-M7, §3 "0193"). Paths below are under
`apps/api/src` unless they start with `packages/` or `apps/`. Edit ONLY the files of your slice. Do not commit. Do not run
`pnpm check`, `pnpm test` (full) or `pnpm db:generate`; the engineer does. You may run
`LEGEND_TEST_FILES="src/test/<file>" pnpm test` from the worktree root (`cd` there first and print `pwd`) and
`pnpm exec eslint <files>`; for typecheck use `heavy pnpm --filter @starter/api typecheck` at most once at the end.
Every shared-registry edit goes in its own block with a `// legend-111j` comment.

## Fixed facts (already decided, do not change)

- Migration is `apps/api/drizzle/0203_*.sql` (engineer writes it). Tables (Drizzle in `db/schema/crm-member.ts` and
  `db/schema/crm-ledger.ts`, written by the engineer FIRST, read them for exact names):
  `loyalty_programs`, `customer_profiles`, `consent_policy_versions`, `point_ledger`, `point_earn_records`,
  `customer_visits`, `loyalty_anomalies`, `member_profile_user_index` (not readable by legend_app);
  `orders` gains `customer_attached_by` (text), `customer_attached_via` (`member_qr|phone_lookup|pwa_session|receipt_claim`),
  `customer_attached_at`.
- DB enforces: `point_ledger` append-only; `customer_profiles.points_balance` is changed ONLY by the ledger trigger
  (legend_app has no INSERT/UPDATE on that column: never include `pointsBalance` in an insert/update); ledger
  `point_value_idr`/`liability_idr` are set by a BEFORE INSERT trigger (pass nothing, Drizzle defaults 0); a ledger
  insert requires a `loyalty_programs` row for the tenant; `points_balance >= 0` CHECK aborts negative balances.
- Member RLS: GUC `app.customer_profile_id`; when set, only that profile's rows are visible in `customer_profiles`
  (id), `point_ledger`, `customer_visits`, `consents` (subject_id).
- WhatsApp digest = `whatsAppDigest(number)` (`lib/identity-digest.ts:82`), same value as `user_identities.value_hash`
  (type `whatsapp`, `verified_at`) and `customer_profiles.whatsapp_hash`.
- Contract (`packages/shared/src/crm/*`) wins on shapes, enums, error codes. Ledger rows: types
  `earn|redeem|expire|reverse|bonus|adjust`; reverse source types `refund|void` (`void` added by slice C).

## Shared interfaces (signatures are binding; implement exactly)

`db/member-scope.ts` (slice L):
```ts
export type MembershipStatus = "pending_verification" | "active" | "suspended" | "closed";
export type MemberScope = {
  context: ScopedTenantContext;      // tenant-wide outlet scope, from tenantWideContext-style builder
  tenantId: string;
  userId: string;                     // Better Auth user id (session)
  customerProfileId: string | null;   // null only for allow:"signup" without a profile
  status: MembershipStatus | null;
};
export function memberTenantContext(tenantId: string): ScopedTenantContext; // tenant-wide, trusted (see payment-webhook.service.ts:133)
export function withMemberScope<T>(database: Database, scope: MemberScope, run: (tx: Tx) => Promise<T>): Promise<T>;
  // = withTenant(database, scope.context, tx => { set_config('app.customer_profile_id', id ?? '', true); run(tx) })
export function setMemberProfileGuc(tx: Tx, profileId: string | null): Promise<void>;
export function withProfileLock(tx: Tx, tenantId: string, profileId: string): Promise<CustomerProfileRow>;
  // SELECT * FROM customer_profiles WHERE tenant_id=$1 AND id=$2 FOR UPDATE; throws HttpError 404 CUSTOMER_NOT_FOUND if none
```

`services/point-ledger.service.ts` (slice L). Caller MUST already hold `withProfileLock` for the profile.
```ts
export type LedgerPostInput = {
  tenantId: string; customerProfileId: string; outletId?: string | null;
  type: PointLedgerType; points: number;            // signed per contract; 0 is forbidden (return null instead, never call)
  sourceType: PointLedgerSourceType; sourceId: string | null;
  reversesEntryId?: string | null; expiresAt?: Date | null; businessDate?: string | null;
  reason?: string | null; createdBy?: string | null;
  event?: Record<string, unknown>;                  // extra payload fields for the outbox event (e.g. rewardId)
};
export type LedgerPostResult = { entry: PointLedgerRow; balanceAfter: number; inserted: boolean };
export function postLedgerEntry(tx: Tx, context: ScopedTenantContext, input: LedgerPostInput, now: Date): Promise<LedgerPostResult>;
  // INSERT ... ON CONFLICT on the dedupe index DO NOTHING; conflict => return existing row, inserted:false, no event.
  // ULID id. After insert, re-read balance; append outbox event in the same tx:
  // earn|bonus -> points.earned, reverse -> points.reversed (reversesLedgerId), redeem -> points.redeemed,
  // expire -> points.expired, adjust -> no event (290c adds points.adjusted). Payload per packages/shared/src/crm/events.ts.
export function listLedgerForProfile(tx: Tx, tenantId: string, profileId: string, page: { cursor?: string; limit: number }): Promise<{ items: PointLedgerEntry[]; nextCursor: string | null }>;
  // order posting_seq DESC; maps rows to the contract pointLedgerEntrySchema shape
export function toLedgerEntryDto(row: PointLedgerRow): PointLedgerEntry;
```

`services/loyalty-anomaly.service.ts` (slice E):
```ts
export type LoyaltyAnomalyKind = "daily_cap_hit" | "self_serve_blocked" | "refund_after_redeem" | "phone_lookup_attach" | "phone_lookup_cap_hit" | "balance_mismatch";
export function recordLoyaltyAnomaly(tx: Tx, input: { tenantId: string; kind: LoyaltyAnomalyKind; outletId?: string | null;
  customerProfileId?: string | null; orderId?: string | null; actorUserId?: string | null; businessDate?: string | null;
  details?: Record<string, unknown> }): Promise<void>;
export function countPhoneLookups(tx: Tx, tenantId: string, actorUserId: string, businessDate: string): Promise<number>; // kind phone_lookup_attach
export function listLoyaltyAnomalies(tx: Tx, tenantId: string, page: { cursor?: string; limit: number; kind?: LoyaltyAnomalyKind }): Promise<{ items: unknown[]; nextCursor: string | null }>;
```

`services/member-profile.service.ts` (slice M):
```ts
export function findProfileByUser(tx: Tx, tenantId: string, userId: string): Promise<CustomerProfileRow | null>;
export function verifiedWhatsAppOfUser(tx: Tx, userId: string): Promise<{ hash: string; verifiedAt: Date } | null>; // user_identities
export function loyaltyConsentActive(tx: Tx, tenantId: string, profileId: string, at?: Date): Promise<boolean>;     // latest consents row by seq, recorded_at <= at
export function onWhatsAppVerified(tx: Tx, userId: string, whatsappHash: string): Promise<void>; // profiles of user visible in tx's tenant
export function toCustomerProfileDto(row: CustomerProfileRow): CustomerProfile; // contract shape (tierId null until 290e)
```

`lib/member-qr-token.ts` (slice M):
```ts
export function issueMemberQrToken(input: { tenantId: string; customerProfileId: string }, now: Date): { token: string; expiresAt: string };
export function verifyMemberQrToken(token: string, tenantId: string, now: Date): { customerProfileId: string } | null; // HMAC, 120 s, timing-safe
// key = HMAC-SHA256(BETTER_AUTH_SECRET, "legend-member-qr-v1"); token = base64url(payload).base64url(sig); payload {t,p,e,n}
```

`services/consent.service.ts` additions (slice M): `recordMemberConsent(scope: MemberScope, input: { purpose; granted: boolean; policyVersion }, now?)`
and `recordMemberConsentInTx(tx, scope, input, now)` (290b merge uses the tx form). `activeConsentPolicies(tx, tenantId, now)`.
Staff `recordConsent` unchanged.

`services/loyalty-earn-consumer.ts` (slice E): `deliverLoyaltyEarnEvent(context: ScopedTenantContext, event: EventEnvelope, tx: Tx, now?: Date): Promise<void>`.

## Slices

### C. Contract (packages/shared only)
`packages/shared/src/crm/{endpoints,errors,events,loyalty}.ts`, `packages/shared/src/access/{permissions,roles}.ts`.
- `loyalty.ts`: reverse source types `refund|void` (`:321-325` superRefine); add `PointLedgerType`/`PointLedgerSourceType` exports if missing.
- `events.ts:83`: `points.reversed.sourceType` `refund|void`.
- `errors.ts`: `CONSENT_POLICY_OUTDATED` 409, `MEMBERSHIP_NOT_ACTIVE` 403, `PHONE_LOOKUP_CAP_REACHED` 429 (message "Batas cari nomor hari ini tercapai. Pakai QR member."), with Indonesian messages.
- `endpoints.ts`: add only what is missing: `GET /api/member/profile`, `GET /api/member/points` (+ `expiringSoon` not needed now),
  `POST /api/member/consents`, `GET /api/member/consent-policies` (response: array `{purpose, version, publishedAt}`),
  `POST /api/member/qr-token` (response `{token, expiresAt}`), `PUT /api/pos/orders/:orderId/customer`
  (body strict union: `{memberToken}` | `{whatsappNumber}` | `{customerProfileId: null}` to detach; response order customer summary),
  `GET /api/loyalty/anomalies` (cursor page, optional `kind`). Reuse existing schemas.
- Permissions: `crm.loyalty.manage`, `crm.loyalty.review`, `crm.loyalty.fulfil`, `crm.customer.pii.read`, `crm.feedback.manage`.
  Roles: owner + manager get all five except `crm.loyalty.fulfil` (cashier roles get it; owner/manager too). `marketing` gets
  `crm.loyalty.manage`, `crm.loyalty.review`. Check how a new permission reaches existing tenants' roles
  (grep `access-perm-backfill`, role template sync); if a DB backfill is required, STOP and report the exact need instead of writing a migration.
- Run `heavy pnpm --filter @starter/shared typecheck` and shared tests touching crm/access.

### L. Ledger core
`db/member-scope.ts`, `services/point-ledger.service.ts`. Outbox append: find the generic domain-event append used by
non-POS services (`services/core-outbox.ts:26 appendOutbox`, see how `accounting`/`crm-promo` emit) and use it.

### E. Earn, anti-fraud, nightly check
`services/loyalty-earn-consumer.ts`, `services/loyalty-earn-tier-step.ts`, `services/loyalty-earn-mission-step.ts`,
`services/loyalty-earn-referral-step.ts`, `services/loyalty-anomaly.service.ts`, `worker/loyalty-balance-check.job.ts`, `worker-main.ts`.
- Follow design §M6 exactly (steps 1-8, refund 1-5, void). Pattern: `accounting-auto-journal-consumer.ts:299-390`
  (savepoint per event via `tx.transaction`). Parse payloads with strict-enough zod (copy `orderPaidSchema` fields from
  `accounting-auto-journal-amounts.ts:162-195`, plus `businessDate`, `channel`, `cashierId`).
- `order.paid`: read `orders.customer_profile_id`, `customer_attached_by`; none -> return. Upsert record by `(tenant_id, order_id)`
  (existing -> return: replay). Lock profile. Load program (`loyalty_programs` row; missing or `is_active=false` ->
  `skipped`/`skipped_program_inactive`). Member check at `paidAt`: status `active` AND `whatsapp_verified_at` NOT NULL AND
  loyalty consent active -> else `blocked`/`blocked_not_member`. Self-serve (program `employee_self_serve_ban`): `cashierId`
  or `customer_attached_by` equals `profile.user_id`, or that staff user's verified WhatsApp digest equals `profile.whatsapp_hash`
  -> `blocked`/`blocked_self_serve` + anomaly `self_serve_blocked`. `eligible = max(0, gross - discount - paidPoints)`.
  `multiplier = await tierMultiplierBp(ctx)`; `points = pointsForSpend(programDto, eligible, multiplier)`.
  Daily cap: `SUM(booked_points)` of this profile's records on the same `business_date` (all outlets);
  `booked = min(points, cap - already)`; cut part -> `capped_points` + anomaly `daily_cap_hit`; `booked=0` -> state `capped`.
  Earn row: `expires_at = paidAt + expiry_months`, `source_type='order'`, `source_id=orderId`. Visit row (also when blocked
  self-serve or capped, NOT when skipped or blocked_not_member) + profile counters (`visits_count+1`, `lifetime_spend_idr+eligible`,
  `first_visit_at` if null, `last_visit_at`). Then `afterVisit` mission step, then referral step.
- `order.refunded` / `order.voided` (`voidedFinalOrder: true` only): design §M6 refund 1-5 and void paragraph.
  `posted = min(delta, points_balance)`; shortfall -> `reversal_shortfall_points` + anomaly `refund_after_redeem`.
- Step stubs: `EarnStepContext` type exported from `loyalty-earn-tier-step.ts`? No: export it from
  `services/loyalty-earn-consumer.ts`? That creates a cycle. Put `EarnStepContext` in `services/loyalty-earn-step-context.ts`
  (type only) and import it in the three step files.
- Wire `deliverLoyaltyEarnEvent` in `worker-main.ts` deliver chain right after `deliverAutoJournalEvent`, same `postsInventoryGl`
  (cloud-only) gate, with a `// legend-111j` comment.
- `worker/loyalty-balance-check.job.ts`: `runLoyaltyBalanceCheck(db, context, now)`: profiles where `points_balance <> SUM(points)`
  -> anomaly `balance_mismatch` (outlet null), at most once per profile per business day (Asia/Jakarta). Wire it in
  `worker-main.ts` relay sweeps following the existing once-per-day pattern of the nearest scheduled sweep (e.g.
  `generateScheduledChecklistRuns`), running after 02:00 Asia/Jakarta.

### M. Member API
`middleware/member.ts`, `routes/member.routes.ts`, `services/member-profile.service.ts`, `services/consent.service.ts`
(add only), `lib/member-qr-token.ts`, `routes/index.ts` (mount `memberRouter`, `loyaltyProgramRouter`, `posOrderCustomerRouter`
from slice S: import names fixed here).
- Chain design §M4. `requireMember({ allow?: "signup" | "pending" })` sets `req.member: MemberScope`; export `getMemberScope(req)`.
  No profile or `closed`: 404 `CUSTOMER_NOT_FOUND` (except allow `signup`: missing profile passes). Status not allowed: 403 `MEMBERSHIP_NOT_ACTIVE`.
- Routes: `GET /profile` (pending), `GET /points` (default), `POST /consents` (signup), `GET /consent-policies` (no requireMember),
  `POST /qr-token` (default). Member route module imports `withMemberScope`, never `withTenant`.
- Signup in `recordMemberConsent`: loyalty granted and no profile -> create profile (name = `user.name`, whatsapp hash/verified_at
  from `verifiedWhatsAppOfUser`, status `active` if verified else `pending_verification`, referral_code null), set the GUC to the
  new id, then insert consent (source `member_pwa`, `recorded_by` = user id, `subject_id` = profile id). Non-loyalty grant
  without profile -> 404 `CUSTOMER_NOT_FOUND`. Grant with version != active -> 409 `CONSENT_POLICY_OUTDATED`. Withdraw accepts any
  version. Withdraw loyalty -> `suspended`. Grant loyalty on `suspended` -> `active` if WhatsApp verified else `pending_verification`.
  `marketing` keeps `marketing_opt_in` in sync. Same advisory lock + idempotency as staff `recordConsent`; audit row.
- Tenant: `tenantContext({ required: true, resolveDomain })` like `/api/auth/login-challenges` (see `app.ts:283-305`).

### S. Staff API, attach, provisioning
`routes/loyalty-program.routes.ts`, `services/loyalty-program.service.ts`, `routes/pos-order-customer.routes.ts`,
`services/pos-order-customer.service.ts`, `services/loyalty-provisioning.service.ts`, `db/backfill-tenant-defaults.ts`,
`services/platform-org.service.ts` (one call only), and the QR order creation service (auto-attach only).
- `GET`/`PUT /api/loyalty/program` (`crm.loyalty.manage`, tenant-wide): GET without row returns defaults (§8: 10000 IDR = 1 pt,
  value 100, expiry 12, rolling 12, cap 1000, ban on, referral default, inactive) with `isActive` field added if the contract
  lacks it (report it). PUT upserts; a `point_value_idr` change after lock -> 409 (map the trigger error, code `POINT_VALUE_LOCKED`
  via HttpError). `GET /api/customers/:customerProfileId/points` (`crm.customer.view`). `GET /api/loyalty/anomalies` (`crm.loyalty.review`).
- `PUT /api/pos/orders/:orderId/customer`: outlet-scoped POS guard like other POS order routes (`routes/pos-order.routes.ts`).
  Order must be unpaid (status `draft|awaiting_payment|sent` and no completed payment). `memberToken` -> `verifyMemberQrToken`,
  via `member_qr`. `whatsappNumber` -> cap check first: `countPhoneLookups(actor, order.business_date) >= program.phone_lookup_daily_cap_per_cashier`
  (default 20 if no program) -> record `phone_lookup_cap_hit`, COMMIT, then 429 `PHONE_LOOKUP_CAP_REACHED`; else find active profile
  by `whatsAppDigest`, write `phone_lookup_attach` anomaly, via `phone_lookup`. Set `customer_profile_id`, `customer_attached_by` = staff
  user id, `customer_attached_via`, `customer_attached_at`. Profile must be `active` else 409 `MEMBERSHIP_NOT_ACTIVE`.
- QR auto-attach: when the QR order is created and the request has a session user with an `active` profile in that tenant,
  set `customer_profile_id`, `customer_attached_via='pwa_session'`, `customer_attached_by=NULL`, `customer_attached_at=now`.
- Provisioning: `provisionLoyaltyDefaults(tx, context)` inserts `consent_policy_versions` `2026-01` for `loyalty`, `marketing`, `ai`
  (text hash = sha256 of `"<purpose>:2026-01"`, `published_at` = '2026-01-01T00:00:00+07:00'), ON CONFLICT DO NOTHING. Call it from
  tenant creation (`platform-org.service.ts`, next to `provisionDefaultTaxConfig`) and from `backfill-tenant-defaults.ts` per tenant.
  No program row is created (program stays absent = inactive until PUT).

### T. Tests (test-writer, fail-first)
`src/test/member-ledger.test.ts`, `member-earn.test.ts`, `member-isolation.test.ts`, `member-consent.test.ts` per brief 290a
"Tes gagal-dulu", using the interfaces above and `test/floor-test-helpers.ts` / `test/helpers.ts` patterns. Drive the consumer through
`withTenant(db, ctx, tx => deliverLoyaltyEarnEvent(ctx, envelope, tx, now))` (pattern `test/accounting-auto-journal.test.ts:1089`).
Isolation test for every new tenant table (cross-tenant select empty). The QR-refund case: assert a `system:qr` refund cannot
follow `order.paid` for the same order (no orderId on `payment.refunded`), so write it as a test pinning that the consumer ignores
`payment.refunded` and document the reason in the test; the engineer reviews it.
