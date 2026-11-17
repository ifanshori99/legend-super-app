// legend-1029 legend-of9kp (money, tier S): the refund follow-up list
// (GET /api/payments/admin/refunds/follow-ups, "failed system refunds whose
// money the guest is still owed") and the alarm `payment.refund_followup_required`
// must also cover PARKED money (a payment_unallocated_funds row; its refund is
// tied by payment_refunds.unallocated_fund_id). Today the list hides every
// refund with a fund id, so a parked fund whose automatic refunds ran out
// (legend-9pz0m: 3 failed approval_expired) or were decided by a person is
// invisible to staff, and the alarm text says "Ajukan refund baru ... di layar
// refund", which does not apply to a fund (a refund is filed per payment).
// Written from the brief and the sibling tests (system-refund-followup.test.ts,
// qr-va-1029-9pz0m-parked-refile.test.ts), not from the implementation.
//
// Ids (the legend-of9kp brief has no feature ids; scenarios are numbered):
//   of9kp-1 spent fund listed with fundId / remainingIdr / attempts / refile_limit
//   of9kp-2 fund refund decided by a person or the provider is listed with its reason
//   of9kp-3 closed funds are not listed (resolution, live refund, completed refund)
//   of9kp-4 a refund that is not of a fund is listed as before, fundId null
//   of9kp-5 another tenant / another outlet never sees the fund
//   of9kp-6 alarm text: parked fund vs. non-fund
//
// Assumptions (spec silent, the brief decides only the shape)
// - The list item carries `fundId` (uuid string) for a fund refund and
//   `fundId: null` for any other. `remainingIdr` of a fund item is the fund
//   amount (money still owed), `attempts` the failed refunds of that fund.
// - One item per fund, and it is the fund's LAST failed refund (as an intent
//   shows only its last failed system refund); the test only requires that
//   `id` is one of the fund's failed refunds.
// - `rejected` -> `person_rejection` (an approver said no). The refund here is
//   marked failed/rejected directly in the DB (as 9pz0m does), so the test
//   accepts person_rejection or failure_needs_person for it, and requires
//   failure_needs_person for provider_declined.
// - Parked-fund alarm: a notification to the outlet supervisor whose text does
//   NOT contain "Ajukan refund baru", mentions the parked fund ("dana" and
//   "parkir") and the amount formatted for Indonesia (e.g. 27.500). The
//   non-fund alarm keeps its old text: it still says "Ajukan refund baru" and
//   names the amount.
// - Only the follow-up moment raises the alarm (not a re-filed failure).
//
// Run: LEGEND_TEST_FILES="src/test/qr-va-1029-of9kp-followup-list.test.ts" pnpm test
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import type { PaymentChannel } from "@starter/shared/payment";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { settleRefundFromChain } from "../services/payment-refund.service.ts";
import { confirmPayment } from "../services/payment.service.ts";
import {
  asOwnerTenant,
  createBreakfastWorld,
  dropBreakfastWorld,
  endPools,
  installGateway,
  linkedOf,
  newMember,
  memberApi,
  placePaidOrder,
  refundDetailsOf,
  removeGateway,
  seedTicket,
  type BreakfastWorld,
} from "./facility-breakfast-helpers.ts";
import { owner, seededTenantId } from "./floor-test-helpers.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  holdFixture,
  resetHoldPorts,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const ADMIN = "/api/payments/admin";
const FOLLOW_UPS = `${ADMIN}/refunds/follow-ups`;
/** MAX_SYSTEM_REFUND_REFILE_ATTEMPTS (brief 850 / 1029). */
const MAX_ATTEMPTS = 3;
const FOLLOWUP_ACTION = "payment.refund_followup_required";
const BNI: PaymentChannel = { code: "bni", name: "BNI" };

let app: Express;
/** The tenant under test (parked funds). */
let fx: HoldFixture;
/** A second, unrelated tenant: must never see the first one's funds. */
let other: HoldFixture;
let reader: ReturnType<typeof agent>;
let otherReader: ReturnType<typeof agent>;

/** A finance user (tenant scope) of a tenant: may read the follow-up list. */
async function makeFinanceReader(tenantId: string, financeRoleId: string) {
  const client = agent(app);
  const email = await signUp(client, "Followup Finance");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await verifySessionMfa(email);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by, assigned_at)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2, now() - interval '1 hour')`,
    [tenantId, userId, financeRoleId],
  );
  return client;
}

async function copyRole(tenantId: string, templateKey: string) {
  return (
    await owner.query<{ id: string }>(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       SELECT gen_random_uuid(), $1, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
         FROM roles WHERE tenant_id = $2 AND template_key = $3
       RETURNING id`,
      [tenantId, seededTenantId, templateKey],
    )
  ).rows[0]!.id;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  // The other tenant first: fixtures set process-wide ports and the LAST one
  // built wins.
  other = await holdFixture("qr-va-1029-of9kp-other");
  fx = await holdFixture("qr-va-1029-of9kp-parked");
  enableVaBank(fx.gateway);
  const port = fx.gateway as unknown as {
    channels(
      context: ScopedTenantContext,
      method?: string,
    ): Promise<PaymentChannel[]>;
  };
  port.channels = async (_context, method) =>
    method === "va" ? [{ code: "bmri", name: "Mandiri" }, BNI] : [];
  setPaymentGateway(fx.gateway);

  // One-level refund policy so every system refund opens an approval request
  // that the tests then let expire; the fixture's staff user is the outlet
  // supervisor who receives the alarm.
  const financeRole = await copyRole(fx.tenant.tenantId, "finance");
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', NULL, $2, 1)`,
    [fx.tenant.tenantId, financeRole],
  );
  const supervisorRole = await copyRole(fx.tenant.tenantId, "supervisor");
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by, assigned_at)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2, now() - interval '1 hour')`,
    [fx.tenant.tenantId, fx.staff.userId, supervisorRole, fx.tenant.outletId],
  );
  reader = await makeFinanceReader(fx.tenant.tenantId, financeRole);
  otherReader = await makeFinanceReader(
    other.tenant.tenantId,
    await copyRole(other.tenant.tenantId, "finance"),
  );
});
afterAll(async () => {
  resetHoldPorts();
  await endPools();
});

// ------------------------------------------------------------------- fixtures

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;
type Code = { id: string; ref: string; amount: number };
type Bill = { guest: Guest; orderId: string; linkId: string; a: Code };

function payRequest(guest: Guest, orderId: string, bankCode: "bmri" | "bni") {
  return fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method: "va",
    bankCode,
    idempotencyKey: randomUUID(),
  });
}

async function codeOf(id: string): Promise<Code & { linkId: string }> {
  const { rows } = await owner.query<{
    amount: number;
    provider_ref: string;
    payment_link_id: string;
  }>(
    `SELECT amount_idr::int AS amount, provider_ref,
            payment_link_id::text AS payment_link_id
       FROM payment_intents WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, id],
  );
  return {
    id,
    ref: rows[0]!.provider_ref,
    amount: rows[0]!.amount,
    linkId: rows[0]!.payment_link_id,
  };
}

async function billWithCodeA(): Promise<Bill> {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  const created = await payRequest(guest, order.id, "bmri");
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const a = await codeOf(created.body.data.id as string);
  fx.gateway.script(a.id, { rawStatus: "01" });
  return { guest, orderId: order.id, linkId: a.linkId, a };
}

async function swapToB(b: Bill): Promise<Code> {
  const res = await payRequest(b.guest, b.orderId, "bni");
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.data.id, "a NEW code B").not.toBe(b.a.id);
  return codeOf(res.body.data.id as string);
}

async function webhook(code: Code) {
  try {
    await confirmPayment(
      fx.context,
      code.id,
      {
        source: "verified_webhook",
        method: "va",
        amountIdr: code.amount,
        providerRef: code.ref,
        at: new Date().toISOString(),
      },
      { type: "system" },
      new Date(),
    );
  } catch {
    /* refused on a dead code: parked, asserted by the caller */
  }
}

type Envelope = ReturnType<typeof eventEnvelopeSchema.parse>;

async function eventsOf(intentIds: string[]): Promise<Envelope[]> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id=$1
        AND event->'payload'->>'intentId' = ANY($2::text[])
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, intentIds],
  );
  return rows.map((r) => eventEnvelopeSchema.parse(r.event));
}

async function consumeAll(intentIds: string[]) {
  for (const event of await eventsOf(intentIds))
    await withTenant(db, fx.context, (tx) =>
      deliverOrderPaymentEvent(fx.context, event, tx, new Date()),
    );
}

type Parked = { bill: Bill; b: Code; fundId: string; amount: number };

/** A swaps to B, B pays the bill, A is paid late: A's money is parked, refund 1 opened. */
async function parkedFundWithRefund(): Promise<Parked> {
  const bill = await billWithCodeA();
  const b = await swapToB(bill);
  fx.gateway.script(b.id, { status: "paid" });
  await webhook(b);
  await consumeAll([bill.a.id, b.id]);
  await webhook(bill.a);
  await consumeAll([bill.a.id, b.id]);
  const funds = await unallocatedFunds(fx, bill.a.id);
  expect(funds.map((f) => f.amountIdr)).toEqual([bill.a.amount]);
  const parked = { bill, b, fundId: funds[0]!.id, amount: bill.a.amount };
  expect(await refundsOfFund(parked.fundId)).toHaveLength(1);
  return parked;
}

type RefundRow = {
  id: string;
  amount: number;
  status: string;
  failure_reason: string | null;
};

async function refundsOfFund(fundId: string): Promise<RefundRow[]> {
  const { rows } = await owner.query<RefundRow>(
    `SELECT id::text AS id, amount_idr::int AS amount, status, failure_reason
       FROM payment_refunds
      WHERE tenant_id=$1 AND unallocated_fund_id=$2::uuid
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, fundId],
  );
  return rows;
}
const liveOf = (rows: RefundRow[]) => rows.filter((r) => r.status !== "failed");

/** The refund fails without a person: its approval request expires. */
async function expireRefund(refundId: string) {
  await owner.query(
    "UPDATE approval_requests SET status = 'expired' WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2",
    [fx.tenant.tenantId, refundId],
  );
  const failed = await settleRefundFromChain(fx.context, refundId);
  expect(failed.status).toBe("failed");
}

/** Spend the whole bound: three failures, no fourth refund. Returns the failed ids. */
async function spendBound(p: Parked): Promise<string[]> {
  const ids: string[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const live = liveOf(await refundsOfFund(p.fundId));
    expect(live, `a live refund for attempt ${attempt}`).toHaveLength(1);
    ids.push(live[0]!.id);
    await expireRefund(live[0]!.id);
  }
  const rows = await refundsOfFund(p.fundId);
  expect(rows).toHaveLength(MAX_ATTEMPTS);
  expect(rows.every((r) => r.status === "failed")).toBe(true);
  return ids;
}

/** The refund fails the way a person (rejected) or the provider decided it. */
async function failRefundAs(refundId: string, reason: string) {
  await owner.query(
    "UPDATE payment_refunds SET status = 'failed', failure_reason = $3 WHERE tenant_id = $1 AND id = $2",
    [fx.tenant.tenantId, refundId, reason],
  );
}

async function supervisorAlarms() {
  const { rows } = await owner.query<{ title: string; body: string }>(
    `SELECT title, body FROM notifications
      WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at, id`,
    [fx.tenant.tenantId, fx.staff.userId],
  );
  return rows;
}

async function auditRows(refundId: string) {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM audit_logs
      WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'action' = $3`,
    [fx.tenant.tenantId, refundId, FOLLOWUP_ACTION],
  );
  return rows;
}

// ------------------------------------------------------------ the list over HTTP

type FollowUp = {
  id: string;
  paymentIntentId: string;
  fundId?: string | null;
  remainingIdr: number;
  attempts: number;
  blockedReason: string;
};

async function followUps(
  client: ReturnType<typeof agent>,
  host: string,
  query = "?limit=100",
): Promise<FollowUp[]> {
  const response = await client
    .get(`${FOLLOW_UPS}${query}`)
    .set({ Host: host })
    .set(originHeader);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as FollowUp[];
}
const listOfFx = (query?: string) =>
  followUps(reader, fx.tenant.hostname, query);
const itemsOfFund = async (fundId: string) =>
  (await listOfFx()).filter((item) => item.fundId === fundId);

// ------------------------------------------------------------------------ tests

describe("legend-of9kp of9kp-1 a parked fund whose refunds ran out is a follow-up", () => {
  beforeEach(() => {
    setPaymentGateway(fx.gateway);
  });

  it("of9kp-1 three failed approval_expired refunds: the fund is listed once with fundId, the whole amount, 3 attempts and refile_limit", async () => {
    const p = await parkedFundWithRefund();
    expect(
      await itemsOfFund(p.fundId),
      "a fund still being re-filed is not a follow-up yet",
    ).toHaveLength(0);

    const failedIds = await spendBound(p);

    const items = await itemsOfFund(p.fundId);
    expect(
      items,
      "the spent fund is missing from the follow-up list",
    ).toHaveLength(1);
    expect(items[0]).toMatchObject({
      fundId: p.fundId,
      paymentIntentId: p.bill.a.id,
      remainingIdr: p.amount,
      attempts: MAX_ATTEMPTS,
      blockedReason: "refile_limit",
    });
    expect(failedIds).toContain(items[0]!.id);
  });
});

describe("legend-of9kp of9kp-2 a fund refund decided by a person or the provider is a follow-up", () => {
  beforeEach(() => {
    setPaymentGateway(fx.gateway);
  });

  it("of9kp-2 rejected: the fund is listed with the whole amount, 1 attempt and a person-decided reason", async () => {
    const p = await parkedFundWithRefund();
    const [first] = await refundsOfFund(p.fundId);
    await failRefundAs(first!.id, "rejected");

    const items = await itemsOfFund(p.fundId);
    expect(
      items,
      "a rejected fund refund is missing from the list",
    ).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: first!.id,
      fundId: p.fundId,
      paymentIntentId: p.bill.a.id,
      remainingIdr: p.amount,
      attempts: 1,
    });
    expect(["person_rejection", "failure_needs_person"]).toContain(
      items[0]!.blockedReason,
    );
  });

  it("of9kp-2 provider_declined: the fund is listed with failure_needs_person", async () => {
    const p = await parkedFundWithRefund();
    const [first] = await refundsOfFund(p.fundId);
    await failRefundAs(first!.id, "provider_declined");

    const items = await itemsOfFund(p.fundId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: first!.id,
      fundId: p.fundId,
      remainingIdr: p.amount,
      attempts: 1,
      blockedReason: "failure_needs_person",
    });
  });
});

describe("legend-of9kp of9kp-3 a closed fund is not a follow-up", () => {
  beforeEach(() => {
    setPaymentGateway(fx.gateway);
  });

  it("of9kp-3 a fund with a resolution drops out of the list", async () => {
    const p = await parkedFundWithRefund();
    await spendBound(p);
    expect(
      await itemsOfFund(p.fundId),
      "listed before it is resolved",
    ).toHaveLength(1);

    await owner.query(
      "UPDATE payment_unallocated_funds SET resolution = 'credit', resolved_by = 'tester', resolved_at = now() WHERE tenant_id = $1 AND id = $2",
      [fx.tenant.tenantId, p.fundId],
    );
    expect(
      await itemsOfFund(p.fundId),
      "a resolved fund must not be listed",
    ).toHaveLength(0);
  });

  it("of9kp-3 a fund with a live refund (re-filed, pending) is not listed; a failed one beside it is", async () => {
    const live = await parkedFundWithRefund();
    const [liveFirst] = await refundsOfFund(live.fundId);
    await expireRefund(liveFirst!.id);
    const rows = await refundsOfFund(live.fundId);
    expect(liveOf(rows), "re-filed, so one live refund").toHaveLength(1);
    expect(
      await itemsOfFund(live.fundId),
      "a fund with a live refund must not be listed",
    ).toHaveLength(0);

    // Control: a sibling fund with only a failed refund IS listed, so the list
    // is not simply empty.
    const dead = await parkedFundWithRefund();
    const [deadFirst] = await refundsOfFund(dead.fundId);
    await failRefundAs(deadFirst!.id, "rejected");
    expect(await itemsOfFund(dead.fundId)).toHaveLength(1);
    expect(await itemsOfFund(live.fundId)).toHaveLength(0);
  });

  it("of9kp-3 a fund whose refund completed is not listed", async () => {
    const p = await parkedFundWithRefund();
    const ids = await spendBound(p);
    expect(await itemsOfFund(p.fundId)).toHaveLength(1);

    // The last refund went through after all (a person paid it out manually).
    await owner.query(
      "UPDATE payment_refunds SET status = 'completed', failure_reason = NULL, completed_at = now() WHERE tenant_id = $1 AND id = $2",
      [fx.tenant.tenantId, ids[MAX_ATTEMPTS - 1]],
    );
    expect(
      await itemsOfFund(p.fundId),
      "a fund refunded in full must not be listed",
    ).toHaveLength(0);
  });
});

describe("legend-of9kp of9kp-5 tenants and outlets are isolated", () => {
  beforeEach(() => {
    setPaymentGateway(fx.gateway);
  });

  it("of9kp-5 another tenant's reader never sees the fund; a foreign outlet filter hides it, the own outlet shows it", async () => {
    const p = await parkedFundWithRefund();
    const [first] = await refundsOfFund(p.fundId);
    await failRefundAs(first!.id, "rejected");
    expect(await itemsOfFund(p.fundId)).toHaveLength(1);

    const foreign = await followUps(otherReader, other.tenant.hostname);
    expect(
      foreign.filter(
        (item) => item.fundId === p.fundId || item.id === first!.id,
      ),
      "another tenant sees this tenant's parked fund",
    ).toHaveLength(0);

    const ownOutlet = await listOfFx(
      `?limit=100&outletId=${fx.tenant.outletId}`,
    );
    expect(ownOutlet.filter((item) => item.fundId === p.fundId)).toHaveLength(
      1,
    );
    // An outlet the reader has no role in is refused outright (403): the
    // fund of this outlet is not served under it.
    const otherOutlet = await reader
      .get(`${FOLLOW_UPS}?limit=100&outletId=${randomUUID()}`)
      .set({ Host: fx.tenant.hostname })
      .set(originHeader);
    expect(otherOutlet.status).toBe(403);
    expect(JSON.stringify(otherOutlet.body)).not.toContain(p.fundId);
  });
});

describe("legend-of9kp of9kp-6 alarm for a spent parked fund", () => {
  beforeEach(() => {
    setPaymentGateway(fx.gateway);
  });

  it("of9kp-6 the supervisor alarm names the parked fund and the amount and does not tell staff to file a new refund", async () => {
    const p = await parkedFundWithRefund();
    const before = (await supervisorAlarms()).length;

    const ids = await spendBound(p);

    expect(await auditRows(ids[MAX_ATTEMPTS - 1]!)).toHaveLength(1);
    const alarms = (await supervisorAlarms()).slice(before);
    expect(alarms, "one alarm for the spent fund").toHaveLength(1);
    const text = `${alarms[0]!.title} ${alarms[0]!.body}`;
    expect(text, "wrong advice for a parked fund").not.toMatch(
      /ajukan refund baru/i,
    );
    expect(text).toMatch(/dana/i);
    expect(text).toMatch(/parkir/i);
    expect(text, "the amount is missing").toContain(
      Number(p.amount).toLocaleString("id-ID"),
    );
  });
});

// ------------------------------------------- refunds that are not of a fund

describe("legend-of9kp of9kp-4 / of9kp-6 a refund of a payment (not a fund) stays as before", () => {
  let world: BreakfastWorld;
  let approverUserId: string;
  let worldReader: ReturnType<typeof agent>;

  beforeAll(async () => {
    installGateway();
    world = await createBreakfastWorld(app);
    const financeRole = await copyRole(world.tenant.tenantId, "finance");
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'refund', NULL, $2, 1)`,
      [world.tenant.tenantId, financeRole],
    );
    worldReader = await makeFinanceReader(world.tenant.tenantId, financeRole);
    // The reader is also the outlet supervisor who receives the alarm.
    const session = await worldReader.get("/api/auth/get-session");
    approverUserId = session.body.user.id as string;
    const supervisorRole = await copyRole(world.tenant.tenantId, "supervisor");
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by, assigned_at)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2, now() - interval '1 hour')`,
      [
        world.tenant.tenantId,
        approverUserId,
        supervisorRole,
        world.tenant.outletId,
      ],
    );
  });
  afterAll(async () => {
    setPaymentRefundGateway(null);
    removeGateway();
    await dropBreakfastWorld(world);
  });

  it("of9kp-4 / of9kp-6 a spent cancel refund is listed with fundId null, its amount, 3 attempts, refile_limit; the alarm keeps its old advice and amount", async () => {
    const member = await newMember(world);
    const ticketId = await seedTicket(world, member);
    const paid = await placePaidOrder(world, member, ticketId);
    const paidIdr = (await linkedOf(world, paid.order.id)).paid;
    const api = memberApi(world, member);
    const cancel = await api.cancel(ticketId, paid.order.id, randomUUID());
    expect(cancel.status, JSON.stringify(cancel.body)).toBeLessThan(300);

    const alarmsBefore = (
      await owner.query(
        "SELECT 1 FROM notifications WHERE tenant_id = $1 AND user_id = $2",
        [world.tenant.tenantId, approverUserId],
      )
    ).rowCount!;

    const failedIds: string[] = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const rows = await refundDetailsOf(world, paid.intentId);
      const live = rows.filter((r) => r.status !== "failed");
      expect(live, `a live refund for attempt ${attempt}`).toHaveLength(1);
      failedIds.push(live[0]!.id);
      await asOwnerTenant(world.tenant.tenantId, (client) =>
        client.query(
          "UPDATE approval_requests SET status = 'expired' WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2",
          [world.tenant.tenantId, live[0]!.id],
        ),
      );
      const failed = await settleRefundFromChain(world.context, live[0]!.id);
      expect(failed.status).toBe("failed");
    }

    const response = await worldReader
      .get(`${FOLLOW_UPS}?limit=100`)
      .set(world.headers)
      .set(originHeader);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const items = (response.body.data as FollowUp[]).filter(
      (item) => item.paymentIntentId === paid.intentId,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: failedIds[MAX_ATTEMPTS - 1],
      remainingIdr: paidIdr,
      attempts: MAX_ATTEMPTS,
      blockedReason: "refile_limit",
    });
    // The new field is present and explicitly null for a refund of a payment.
    expect(items[0]!.fundId, "fundId must be null, not missing").toBeNull();

    const { rows: alarms } = await owner.query<{ title: string; body: string }>(
      "SELECT title, body FROM notifications WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at, id",
      [world.tenant.tenantId, approverUserId],
    );
    const fresh = alarms.slice(alarmsBefore);
    expect(fresh, "one alarm").toHaveLength(1);
    // Old text, unchanged for refunds that are not of a fund.
    expect(fresh[0]!.body).toMatch(/ajukan refund baru/i);
    expect(fresh[0]!.body).toContain(Number(paidIdr).toLocaleString("id-ID"));
    expect(fresh[0]!.body).not.toMatch(/parkir/i);
  });
});
