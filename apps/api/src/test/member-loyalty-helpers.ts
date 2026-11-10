// Shared fixtures for the legend-111j member / loyalty tests (member-ledger,
// member-earn, member-isolation, member-consent). Not a test file.
//
// Everything is seeded with raw SQL as the migration owner (inside a
// transaction that sets the tenant GUCs, because RLS is forced on the order
// tables); the code under test always runs as legend_app through `withTenant`.
// Column names follow db/schema/crm-member.ts and crm-ledger.ts.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import {
  createUlid,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverLoyaltyEarnEvent } from "../services/loyalty-earn-consumer.ts";
import type { Express } from "express";
import { agent, signUp } from "./helpers";
import { seededHostname, seededTenantId } from "./floor-test-helpers";

if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
  throw new Error("Requires the disposable test database");

export const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

/** Fixed "now" of the consumer; every business instant below is in the past. */
export const NOW = new Date("2026-11-08T03:00:00Z");
/** 2026-10-15 12:00 in Jakarta: business date 2026-10-15. */
export const DAY = "2026-10-15T05:00:00.000Z";
export const DATE = "2026-10-15";
export const NEXT_DAY = "2026-10-16T05:00:00.000Z";
export const NEXT_DATE = "2026-10-16";

export const short = () => randomUUID().slice(0, 6);
export const hex64 = () => randomBytes(32).toString("hex");

export type World = {
  tenantId: string;
  brandId: string;
  /** Two outlets of one legal entity. */
  outletA: string;
  outletB: string;
  context: ScopedTenantContext;
};

export function contextOf(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

/** Owner connection with the tenant GUCs set, for RLS-protected tables. */
export async function asTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A fresh tenant with one brand, one legal entity and two outlets. */
export async function createWorld(): Promise<World> {
  const tenantId = randomUUID();
  const brandId = randomUUID();
  const legalEntityId = randomUUID();
  const outletA = randomUUID();
  const outletB = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Member', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantId,
      `uji-mem-${tenantId.slice(0, 8)}`,
      JSON.stringify({ modules: ["loyalty"], integrationProviders: [] }),
      JSON.stringify({
        maxOutlets: 50,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
    [brandId, tenantId],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [legalEntityId, tenantId, `Entity ${short()}`],
  );
  for (const outletId of [outletA, outletB])
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Outlet Uji', 'Jl. Uji', 'Asia/Jakarta', '04:00', '{}', 'active')`,
      [
        outletId,
        tenantId,
        brandId,
        legalEntityId,
        `MB-${short()}`.toUpperCase(),
      ],
    );
  return {
    tenantId,
    brandId,
    outletA,
    outletB,
    context: contextOf(tenantId),
  };
}

// ---- seeding ----------------------------------------------------------------

export type ProgramOptions = {
  isActive?: boolean;
  earnSpendIdr?: number;
  earnPoints?: number;
  expiryMonths?: number;
  pointValueIdr?: number;
  /** null = no daily cap. */
  dailyCap?: number | null;
  selfServeBan?: boolean;
  phoneLookupCap?: number;
};

export async function seedProgram(
  tenantId: string,
  options: ProgramOptions = {},
): Promise<void> {
  await asTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO loyalty_programs
         (tenant_id, is_active, earn_spend_idr, earn_points, expiry_months, point_value_idr,
          daily_point_cap_per_customer, employee_self_serve_ban, phone_lookup_daily_cap_per_cashier)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id) DO UPDATE SET
         is_active = EXCLUDED.is_active,
         earn_spend_idr = EXCLUDED.earn_spend_idr,
         earn_points = EXCLUDED.earn_points,
         expiry_months = EXCLUDED.expiry_months,
         daily_point_cap_per_customer = EXCLUDED.daily_point_cap_per_customer,
         employee_self_serve_ban = EXCLUDED.employee_self_serve_ban,
         phone_lookup_daily_cap_per_cashier = EXCLUDED.phone_lookup_daily_cap_per_cashier`,
      [
        tenantId,
        options.isActive ?? true,
        options.earnSpendIdr ?? 10_000,
        options.earnPoints ?? 1,
        options.expiryMonths ?? 12,
        options.pointValueIdr ?? 100,
        options.dailyCap === undefined ? 1000 : options.dailyCap,
        options.selfServeBan ?? true,
        options.phoneLookupCap ?? 20,
      ],
    ),
  );
}

export type ProfileOptions = {
  id?: string;
  userId?: string | null;
  whatsappHash?: string | null;
  status?: "pending_verification" | "active" | "suspended" | "closed";
  /** Default: verified when status is active. */
  verified?: boolean;
  name?: string;
};

export type Profile = { id: string; userId: string; whatsappHash: string };

/** A profile (default: active, WhatsApp verified, with a loyalty consent). */
export async function seedProfile(
  tenantId: string,
  options: ProfileOptions = {},
): Promise<Profile> {
  const id = options.id ?? randomUUID();
  const userId = options.userId ?? randomUUID();
  const whatsappHash = options.whatsappHash ?? hex64();
  const status = options.status ?? "active";
  const verified = options.verified ?? status === "active";
  await asTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO customer_profiles
         (id, tenant_id, user_id, whatsapp_hash, name, membership_status, whatsapp_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        tenantId,
        userId,
        whatsappHash,
        options.name ?? `Member ${short()}`,
        status,
        verified ? "2026-01-02T00:00:00Z" : null,
      ],
    ),
  );
  return { id, userId, whatsappHash };
}

export async function seedConsent(
  tenantId: string,
  profileId: string,
  input: {
    purpose?: "loyalty" | "marketing" | "ai";
    decision?: "granted" | "withdrawn";
    recordedAt?: string;
    policyVersion?: string;
  } = {},
): Promise<void> {
  await asTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO consents (tenant_id, subject_id, purpose, policy_version, decision, source, recorded_by, recorded_at)
       VALUES ($1, $2, $3, $4, $5, 'member_pwa', 'seed', $6)`,
      [
        tenantId,
        profileId,
        input.purpose ?? "loyalty",
        input.policyVersion ?? "2026-01",
        input.decision ?? "granted",
        input.recordedAt ?? "2026-01-02T00:00:00Z",
      ],
    ),
  );
}

/** Active, verified member with an active loyalty consent (the earning case). */
export async function seedMember(
  tenantId: string,
  options: ProfileOptions = {},
): Promise<Profile> {
  const profile = await seedProfile(tenantId, options);
  await seedConsent(tenantId, profile.id);
  return profile;
}

export type OrderSeed = {
  orderUlid?: string;
  outletId: string;
  channel?: "pos" | "qr";
  profileId: string | null;
  attachedBy?: string | null;
  attachedVia?: "member_qr" | "phone_lookup" | "pwa_session" | "receipt_claim";
  grossSalesIdr?: number;
  discountIdr?: number;
  serviceChargeIdr?: number;
  pbjtIdr?: number;
  /** Prices include service and tax (harga nett). */
  nett?: boolean;
  cashierId?: string | null;
  status?: "draft" | "completed";
  businessDate?: string;
};

/** An `orders` row (and `pos_orders` for POS) with the member attribution. */
export async function seedOrder(
  tenantId: string,
  seed: OrderSeed,
): Promise<string> {
  const orderUlid = seed.orderUlid ?? createUlid();
  const orderId = ulidToUuid(orderUlid);
  const channel = seed.channel ?? "pos";
  const gross = seed.grossSalesIdr ?? 100_000;
  const discount = seed.discountIdr ?? 0;
  const service = seed.serviceChargeIdr ?? 0;
  const pbjt = seed.pbjtIdr ?? 0;
  const total = seed.nett
    ? gross - discount
    : gross - discount + service + pbjt;
  const attachedVia =
    seed.profileId === null
      ? null
      : (seed.attachedVia ?? (channel === "qr" ? "pwa_session" : "member_qr"));
  await asTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          prices_include_tax, status, business_date, placed_at,
          customer_profile_id, customer_attached_by, customer_attached_via, customer_attached_at)
       VALUES ($1, $2, $3, $4, $5, 'takeaway', 'pay_first', $6, $7, $8, $9, 0, $10,
               $11, $12, $13, now(), $14, $15, $16, $17)`,
      [
        orderId,
        tenantId,
        seed.outletId,
        `MB-${short()}`.toUpperCase(),
        channel,
        gross,
        discount,
        service,
        pbjt,
        total,
        seed.nett ?? false,
        seed.status ?? "completed",
        seed.businessDate ?? DATE,
        seed.profileId,
        seed.attachedBy ?? null,
        attachedVia,
        seed.profileId === null ? null : DAY,
      ],
    );
    if (channel === "pos")
      await client.query(
        `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, cashier_id, submitted_at, completed_at)
         VALUES ($1, $2, $3, 'pos', $4, now(), $5)`,
        [
          orderId,
          tenantId,
          seed.outletId,
          seed.cashierId ?? null,
          (seed.status ?? "completed") === "completed" ? DAY : null,
        ],
      );
  });
  return orderUlid;
}

/** Stamps a completed POS order as a training sale (the row is frozen, so bypass its trigger). */
export async function markTraining(
  tenantId: string,
  orderUlid: string,
): Promise<void> {
  await asTenant(tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "UPDATE pos_orders SET is_training = true WHERE tenant_id = $1 AND order_id = $2",
      [tenantId, ulidToUuid(orderUlid)],
    );
  });
}

// ---- synthetic events -------------------------------------------------------

function envelope(
  world: Pick<World, "tenantId">,
  input: {
    name: string;
    outletId: string;
    aggregateId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  },
): EventEnvelope {
  const id = createUlid();
  return eventEnvelopeSchema.parse({
    id,
    tenantId: world.tenantId,
    outletId: input.outletId,
    name: input.name,
    version: 1,
    aggregateType: "order",
    aggregateId: input.aggregateId,
    sequence: 1,
    occurredAt: input.occurredAt,
    actor: { type: "system" },
    idempotencyKey: `member-test-${id}`,
    payloadSchemaRef: `${input.name}.v1`,
    payload: input.payload,
  });
}

export type PaidInput = {
  orderUlid: string;
  outletId: string;
  channel?: "pos" | "qr";
  grossSalesIdr?: number;
  discountIdr?: number;
  serviceChargeIdr?: number;
  pbjtIdr?: number;
  paidPointsIdr?: number;
  cashierId?: string | null;
  paidAt?: string;
  businessDate?: string;
};

export function orderPaidEvent(
  world: Pick<World, "tenantId">,
  input: PaidInput,
): EventEnvelope {
  const gross = input.grossSalesIdr ?? 100_000;
  const discount = input.discountIdr ?? 0;
  const service = input.serviceChargeIdr ?? 0;
  const pbjt = input.pbjtIdr ?? 0;
  const points = input.paidPointsIdr ?? 0;
  const total = gross - discount + service + pbjt;
  const paidAt = input.paidAt ?? DAY;
  return envelope(world, {
    name: "order.paid",
    outletId: input.outletId,
    aggregateId: input.orderUlid,
    occurredAt: paidAt,
    payload: {
      orderId: input.orderUlid,
      outletId: input.outletId,
      businessDate: input.businessDate ?? DATE,
      channel: input.channel ?? "pos",
      serviceType: "takeaway",
      grossSalesIdr: gross,
      discountIdr: discount,
      serviceChargeIdr: service,
      pbjtIdr: pbjt,
      roundingIdr: 0,
      totalIdr: total,
      paidCashIdr: total - points,
      paidGatewayIdr: 0,
      paidEdcIdr: 0,
      paidPointsIdr: points,
      tenders: [{ method: "cash", amountIdr: total - points }],
      shiftId: null,
      cashierId: input.cashierId ?? null,
      deviceId: null,
      paidAt,
    },
  });
}

export function orderRefundedEvent(
  world: Pick<World, "tenantId">,
  input: {
    orderUlid: string;
    outletId: string;
    refundId?: string;
    grossSalesIdr: number;
    discountIdr?: number;
    refundPointsIdr?: number;
    refundedAt?: string;
  },
): EventEnvelope {
  const refundedAt = input.refundedAt ?? NEXT_DAY;
  return envelope(world, {
    name: "order.refunded",
    outletId: input.outletId,
    aggregateId: input.orderUlid,
    occurredAt: refundedAt,
    payload: {
      orderId: input.orderUlid,
      outletId: input.outletId,
      businessDate: NEXT_DATE,
      refundId: input.refundId ?? randomUUID(),
      amountIdr: input.grossSalesIdr,
      reason: "customer_request",
      reasonNote: "Pesanan salah",
      approvedBy: randomUUID(),
      overrideId: null,
      approvalRequestId: null,
      grossSalesIdr: input.grossSalesIdr,
      discountIdr: input.discountIdr ?? 0,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
      refundCashIdr: input.grossSalesIdr - (input.refundPointsIdr ?? 0),
      refundGatewayIdr: 0,
      refundEdcIdr: 0,
      refundPointsIdr: input.refundPointsIdr ?? 0,
      lines: [],
      refundedAt,
    },
  });
}

export function orderVoidedEvent(
  world: Pick<World, "tenantId">,
  input: {
    orderUlid: string;
    outletId: string;
    voidId: string | null;
    voidedFinalOrder: boolean;
    amountIdr?: number;
  },
): EventEnvelope {
  return envelope(world, {
    name: "order.voided",
    outletId: input.outletId,
    aggregateId: input.orderUlid,
    occurredAt: NEXT_DAY,
    payload: {
      orderId: input.orderUlid,
      outletId: input.outletId,
      businessDate: NEXT_DATE,
      amountIdr: input.amountIdr ?? 100_000,
      reason: "wrong_order",
      reasonNote: "Pesanan salah",
      approvedBy: randomUUID(),
      overrideId: null,
      approvalRequestId: null,
      voidedFinalOrder: input.voidedFinalOrder,
      voidId: input.voidId,
      receiptNumber: input.voidedFinalOrder ? "MB-0001" : null,
      voidedAt: NEXT_DAY,
    },
  });
}

/** The gateway refund event of a QR order: it carries no order id. */
export function paymentRefundedEvent(
  world: Pick<World, "tenantId">,
  outletId: string,
  amountIdr: number,
): EventEnvelope {
  const refundId = randomUUID();
  return eventEnvelopeSchema.parse({
    id: createUlid(),
    tenantId: world.tenantId,
    outletId,
    name: "payment.refunded",
    version: 1,
    aggregateType: "payment",
    aggregateId: refundId,
    sequence: 1,
    occurredAt: NEXT_DAY,
    actor: { type: "system" },
    idempotencyKey: `member-test-${refundId}`,
    payloadSchemaRef: "payment.refunded.v1",
    payload: { refundId, paymentIntentId: randomUUID(), amountIdr },
  });
}

/** Delivers through the consumer the way the worker does (savepoint-less here). */
export function deliver(
  world: Pick<World, "tenantId" | "context">,
  event: EventEnvelope,
): Promise<void> {
  return withTenant(db, world.context, (tx) =>
    deliverLoyaltyEarnEvent(world.context, event, tx, NOW),
  );
}

// ---- reads (owner, bypass nothing: GUCs set) ----------------------------------

export type LedgerRow = {
  id: string;
  type: string;
  points: string;
  source_type: string;
  source_id: string | null;
  reverses_entry_id: string | null;
  expires_at: Date | null;
  point_value_idr: string;
  liability_idr: string;
};

export async function ledgerOf(
  tenantId: string,
  profileId: string,
): Promise<LedgerRow[]> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<LedgerRow>(
      `SELECT id, type, points::text, source_type, source_id, reverses_entry_id, expires_at,
              point_value_idr::text, liability_idr::text
         FROM point_ledger WHERE tenant_id = $1 AND customer_profile_id = $2 ORDER BY posting_seq`,
      [tenantId, profileId],
    );
    return rows;
  });
}

export type ProfileRow = {
  points_balance: string;
  visits_count: number;
  lifetime_spend_idr: string;
  first_visit_at: Date | null;
  last_visit_at: Date | null;
  membership_status: string;
  marketing_opt_in: boolean;
  name: string;
  whatsapp_verified_at: Date | null;
};

export async function profileOf(
  tenantId: string,
  profileId: string,
): Promise<ProfileRow> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<ProfileRow>(
      `SELECT points_balance::text, visits_count, lifetime_spend_idr::text, first_visit_at, last_visit_at,
              membership_status, marketing_opt_in, name, whatsapp_verified_at
         FROM customer_profiles WHERE tenant_id = $1 AND id = $2`,
      [tenantId, profileId],
    );
    return rows[0]!;
  });
}

export const balanceOf = async (tenantId: string, profileId: string) =>
  Number((await profileOf(tenantId, profileId)).points_balance);

export type RecordRow = {
  state: string;
  outcome_reason: string | null;
  eligible_spend_idr: string;
  computed_points: string;
  capped_points: string;
  booked_points: string;
  refunded_eligible_idr: string;
  reversed_points: string;
  reversal_shortfall_points: string;
  earn_entry_id: string | null;
};

export async function recordOf(
  tenantId: string,
  orderUlid: string,
): Promise<RecordRow | null> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<RecordRow>(
      `SELECT state, outcome_reason, eligible_spend_idr::text, computed_points::text, capped_points::text,
              booked_points::text, refunded_eligible_idr::text, reversed_points::text,
              reversal_shortfall_points::text, earn_entry_id
         FROM point_earn_records WHERE tenant_id = $1 AND order_id = $2`,
      [tenantId, ulidToUuid(orderUlid)],
    );
    return rows[0] ?? null;
  });
}

export async function visitCount(
  tenantId: string,
  profileId: string,
): Promise<number> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM customer_visits WHERE tenant_id = $1 AND customer_profile_id = $2",
      [tenantId, profileId],
    );
    return Number(rows[0]!.n);
  });
}

export type AnomalyRow = {
  kind: string;
  outlet_id: string | null;
  customer_profile_id: string | null;
  order_id: string | null;
  actor_user_id: string | null;
};

export async function anomaliesOf(
  tenantId: string,
  kind?: string,
): Promise<AnomalyRow[]> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<AnomalyRow>(
      `SELECT kind, outlet_id, customer_profile_id, order_id, actor_user_id
         FROM loyalty_anomalies WHERE tenant_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY created_at`,
      [tenantId, kind ?? null],
    );
    return rows;
  });
}

export async function outboxEvents(
  tenantId: string,
  name: string,
  profileId: string,
): Promise<{ payload: Record<string, unknown> }[]> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ payload: Record<string, unknown> }>(
      `SELECT event->'payload' AS payload FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = $2 AND event->'payload'->>'customerProfileId' = $3
        ORDER BY created_at`,
      [tenantId, name, profileId],
    );
    return rows;
  });
}

/** Message of an error and every `cause` below it (Drizzle wraps pg errors). */
export function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (current instanceof Error) parts.push(current.message);
    else parts.push(String(current));
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

export async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return errorText(error);
  }
  throw new Error("Expected the statement to be rejected, but it succeeded");
}

// ---- member HTTP sessions in the seeded tenant -------------------------------

export const memberHeaders = { Host: seededHostname };

export type MemberUser = {
  client: ReturnType<typeof agent>;
  userId: string;
  name: string;
  whatsappHash: string;
};

/** A real Better Auth account; optionally with a verified WhatsApp identity and a profile. */
export async function newMemberUser(
  app: Express,
  options: {
    name?: string;
    verifiedWhatsapp?: boolean;
    profile?: false | NonNullable<ProfileOptions["status"]>;
    /** Active loyalty consent for the seeded profile (default true). */
    consent?: boolean;
  } = {},
): Promise<MemberUser & { profileId: string | null }> {
  const client = agent(app);
  const name = options.name ?? `Member ${short()}`;
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const whatsappHash = hex64();
  if (options.verifiedWhatsapp)
    await owner.query(
      `INSERT INTO user_identities (user_id, type, value_hash, verified_at)
       VALUES ($1, 'whatsapp', $2, now())`,
      [userId, whatsappHash],
    );
  let profileId: string | null = null;
  if (options.profile) {
    const profile = await seedProfile(seededTenantId, {
      userId,
      name,
      status: options.profile,
      whatsappHash: options.verifiedWhatsapp ? whatsappHash : hex64(),
      verified: options.verifiedWhatsapp ?? options.profile === "active",
    });
    profileId = profile.id;
    if (options.consent ?? true) await seedConsent(seededTenantId, profile.id);
  }
  return { client, userId, name, whatsappHash, profileId };
}

/** The published `2026-01` policy versions of the seeded tenant (provisioning data). */
export async function ensureConsentPolicies(): Promise<void> {
  await asTenant(seededTenantId, async (client) => {
    for (const purpose of ["loyalty", "marketing", "ai"])
      await client.query(
        `INSERT INTO consent_policy_versions (tenant_id, purpose, version, text_hash, published_at)
         VALUES ($1, $2, '2026-01', $3, '2026-01-01T00:00:00+07:00')
         ON CONFLICT (tenant_id, purpose, version) DO NOTHING`,
        [seededTenantId, purpose, hex64()],
      );
  });
}
