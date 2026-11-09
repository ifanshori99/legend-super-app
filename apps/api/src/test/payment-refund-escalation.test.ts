// Acceptance tests for refund escalation (bead legend-n9kn), written against
// docs brief "Section E" and the Goal/Invariants of the refund-escalation
// brief, not against the service code. A refund that waits too long is never
// auto-cancelled or auto-paid: past a per-tenant age threshold it is marked
// escalated once per reason, audited, notified through the outbox, and nothing
// else on the row changes.
//
// Real services and PostgreSQL. Every scenario runs twice: with no refund
// gateway installed and with FakeRefundGateway (escalation runs either way).
//
// Assumptions where the brief is not exact:
// - Audit action: the brief says "payment.refund.escalated (match existing
//   naming)"; existing actions mix dots and underscores
//   (payment.refund_payout_quarantined). Any audit action for the refund that
//   matches `payment.refund%escalated` is accepted.
// - Approved refunds that are polling are seeded with a future payout lease and
//   a fresh updated_at, so the payout sweep in the same run does not touch them
//   and "money columns unchanged" stays assertable through `sweepApproved...`.
//   (Escalation must ignore the lease: the brief lists no lease condition.)
// - Recipient rule: users with `outlet_manager` (outlet scope) and `finance`
//   (tenant scope) both receive the alert; a cashier does not.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createUlid, type ScopedTenantContext } from "@starter/shared/core";
import { eventEnvelopeSchema, eventFixture } from "@starter/shared/events";
import * as schema from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import { listRefunds } from "../services/payment-admin.service";
import {
  escalateStaleRefunds,
  reopenQuarantinedRefund,
  sweepApprovedRefundPayouts,
} from "../services/payment-refund.service";
import { createNotificationRecipientResolver } from "../worker/notification-adapters.ts";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  type IsolatedTenant,
} from "./floor-test-helpers";
import { FakeRefundGateway } from "./refund-fake-gateway";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(appPool, { schema });

const contextOf = (id: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId: id, brandId: null, source: "job" }),
    { kind: "tenant" },
  );
const tenantWide = contextOf(tenantId);

const HOUR = 3_600_000;
const REQUESTER = randomUUID();
const APPROVER = randomUUID();
const ESCALATED_EVENT = "payment.refund_escalated";

type Seeded = { tenantId: string; outletId: string; intentId: string };
const refundIds: string[] = [];
const intents: string[] = [];
const links: string[] = [];
let other: IsolatedTenant;
let otherSeed: Seeded;
let fake: FakeRefundGateway | null = null;

/** A settled bill: link + paid intent + one evidence row. */
async function seedPaid(
  forTenant: string = tenantId,
  forOutlet: string = outletA,
  amountIdr = 100_000,
): Promise<Seeded> {
  const linkId = randomUUID();
  const intentId = randomUUID();
  links.push(linkId);
  intents.push(intentId);
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'system:escalation-test')`,
    [
      linkId,
      forTenant,
      forOutlet,
      randomBytes(32).toString("hex"),
      `ESC-${linkId.slice(0, 8)}`,
      amountIdr,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [intentId, forTenant, forOutlet, linkId, amountIdr, `esc-${intentId}`],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [forTenant, forOutlet, intentId, `evidence-${intentId}`, amountIdr],
  );
  return { tenantId: forTenant, outletId: forOutlet, intentId };
}

type RefundSeed = {
  status?: "pending" | "approved" | "completed" | "failed";
  /** Age of created_at in hours. */
  createdHoursAgo?: number;
  /** Age of decided_at in hours (approved refunds). */
  decidedHoursAgo?: number;
  chain?: boolean;
  polls?: number;
  seed?: Seeded;
};

async function seedRefund(input: RefundSeed = {}): Promise<string> {
  const seed = input.seed ?? (await seedPaid());
  const status = input.status ?? "pending";
  const now = Date.now();
  const refundId = randomUUID();
  refundIds.push(refundId);
  const decided = status === "pending" ? null : (input.decidedHoursAgo ?? 1);
  // UUID actors: the admin refund view parses requestedBy/approvedBy as UUIDs.
  const approved = status === "pending" ? null : APPROVER;
  const polling = status === "approved" && (input.polls ?? 0) > 0;
  await owner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by,
        approved_by, decided_at, approval_chain_id, payout_pending_polls, payout_attempts,
        payout_claimed_until, payout_claim_token, last_payout_error, provider_ref,
        created_at, updated_at, failure_reason)
     VALUES ($1, $2, $3, $4, 75000, 'Pengembalian uji', $5, $18,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17)`,
    [
      refundId,
      seed.tenantId,
      seed.outletId,
      seed.intentId,
      status,
      approved,
      decided === null ? null : new Date(now - decided * HOUR),
      input.chain ? randomUUID() : null,
      input.polls ?? 0,
      polling ? 2 : 0,
      polling ? new Date(now + 10 * 60 * HOUR) : null,
      polling ? randomUUID() : null,
      polling ? "provider_pending" : null,
      polling ? `prov-${refundId.slice(0, 8)}` : null,
      new Date(now - (input.createdHoursAgo ?? 0) * HOUR),
      // Fresh and distinctive: the payout backoff reads it; escalation must not move it.
      new Date(now - 90_000),
      status === "failed" ? "rejected" : null,
      REQUESTER,
    ],
  );
  return refundId;
}

type Row = {
  status: string;
  amount_idr: string;
  escalated_at: Date | null;
  escalation_reason: string | null;
};

async function refundRow(id: string): Promise<Row> {
  const { rows } = await owner.query<Row>(
    "SELECT status, amount_idr, escalated_at, escalation_reason FROM payment_refunds WHERE id = $1",
    [id],
  );
  if (!rows[0]) throw new Error("refund row missing");
  return rows[0];
}

/** Every column except the two escalation columns, as JSON. */
async function snapshot(id: string): Promise<Record<string, unknown>> {
  const { rows } = await owner.query<{ snap: Record<string, unknown> }>(
    `SELECT to_jsonb(r) - 'escalated_at' - 'escalation_reason' AS snap
     FROM payment_refunds r WHERE id = $1`,
    [id],
  );
  return rows[0]!.snap;
}

async function audits(refundId: string, forTenant: string = tenantId) {
  const { rows } = await owner.query<{
    action: string;
    actor: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }>(
    `SELECT event->>'action' AS action, event->>'actorId' AS actor,
            event->'maskedChanges'->'before' AS before,
            event->'maskedChanges'->'after' AS after
     FROM audit_logs
     WHERE tenant_id = $1 AND event->>'objectId' = $2
       AND event->>'action' LIKE 'payment.refund%escalated'
     ORDER BY created_at`,
    [forTenant, refundId],
  );
  return rows;
}

async function outboxRows(refundId: string, forTenant: string = tenantId) {
  const { rows } = await owner.query<{
    destination: string;
    event: { payload: Record<string, unknown> };
  }>(
    `SELECT destination, event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = $2 AND event->>'aggregateId' = $3`,
    [forTenant, ESCALATED_EVENT, refundId],
  );
  return rows;
}

const sweep = () => sweepApprovedRefundPayouts(tenantWide, new Date(), 100);

async function purgeAudits(ids: string[]) {
  if (ids.length === 0) return;
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only",
    );
    await client.query(
      "DELETE FROM audit_logs WHERE event->>'objectId' = ANY($1::text[])",
      [ids],
    );
    await client.query(
      "ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only",
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function cleanRows() {
  await owner.query(
    "DELETE FROM domain_event_outbox WHERE aggregate_id = ANY($1::uuid[])",
    [refundIds],
  );
  await owner.query("DELETE FROM payment_refunds WHERE id = ANY($1::uuid[])", [
    refundIds,
  ]);
  await owner.query(
    "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
    [intents],
  );
  await owner.query("DELETE FROM payment_intents WHERE id = ANY($1::uuid[])", [
    intents,
  ]);
  await owner.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
    links,
  ]);
}

// An ops user for the reopen and list scenarios: finance (tenant scope, holds
// payment.reconcile) plus supervisor (outlet scope, holds the refund approval
// permission). Never the requester of any seeded refund ('system:requester').
let opsUser: string;
const opsUsers: string[] = [];

async function createOpsUser(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Esc ops', $2, true)`,
    [id, `${id}@example.test`],
  );
  opsUsers.push(id);
  for (const [templateKey, scopeType, scopeId] of [
    ["finance", "tenant", null],
    ["supervisor", "outlet", outletA],
  ] as const) {
    const role = await owner.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
      [tenantId, templateKey],
    );
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
      [tenantId, id, role.rows[0]!.id, scopeType, scopeId],
    );
  }
  return id;
}

beforeAll(async () => {
  opsUser = await createOpsUser();
  other = await createIsolatedTenant(`esc-${randomUUID().slice(0, 8)}`);
  otherSeed = await seedPaid(other.tenantId, other.outletId);
});

afterAll(async () => {
  await owner.query(
    "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
    [opsUsers],
  );
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [opsUsers]);
  await owner.query(
    "DELETE FROM payment_refund_escalation_settings WHERE tenant_id = ANY($1::uuid[])",
    [[tenantId, other.tenantId]],
  );
  await purgeAudits(refundIds);
  await cleanRows();
  await dropIsolatedTenant(other);
  await owner.end();
  await appPool.end();
});

describe.each([
  ["no gateway installed", () => null],
  ["FakeRefundGateway installed", () => new FakeRefundGateway()],
])("legend-n9kn refund escalation (%s)", (_label, makeGateway) => {
  beforeEach(() => {
    fake = makeGateway();
    setPaymentRefundGateway(fake);
  });
  afterEach(async () => {
    setPaymentRefundGateway(null);
    await owner.query(
      "DELETE FROM payment_refund_escalation_settings WHERE tenant_id = $1",
      [tenantId],
    );
    // Rows are removed per test so a stale refund never leaks into a later sweep.
    await owner.query(
      "DELETE FROM domain_event_outbox WHERE aggregate_id = ANY($1::uuid[])",
      [refundIds],
    );
    await owner.query(
      "DELETE FROM payment_refunds WHERE id = ANY($1::uuid[]) AND tenant_id = $2",
      [refundIds, tenantId],
    );
  });

  it("legend-n9kn a pending refund under the 24 h default is not escalated and its row is untouched", async () => {
    const id = await seedRefund({ createdHoursAgo: 23 });
    const before = await snapshot(id);

    const result = await sweep();

    expect(result.escalated).toBe(0);
    const row = await refundRow(id);
    expect(row.escalated_at).toBeNull();
    expect(row.escalation_reason).toBeNull();
    expect(await snapshot(id)).toEqual(before);
    expect(await audits(id)).toHaveLength(0);
    expect(await outboxRows(id)).toHaveLength(0);
  });

  it("legend-n9kn a pending refund past 24 h is escalated once: one audit row and one notification event, even after repeated sweeps", async () => {
    const id = await seedRefund({ createdHoursAgo: 25 });

    const first = await sweep();
    expect(first.escalated).toBe(1);
    const row = await refundRow(id);
    expect(row.escalation_reason).toBe("pending_unapproved");
    expect(row.escalated_at).not.toBeNull();
    expect(row.status).toBe("pending");

    const auditRows = await audits(id);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.actor).toBeNull();
    expect(auditRows[0]!.after).toMatchObject({
      escalationReason: "pending_unapproved",
      status: "pending",
    });
    const events = await outboxRows(id);
    expect(events).toHaveLength(1);
    expect(events[0]!.destination).toBe("notification");
    expect(events[0]!.event.payload).toMatchObject({
      refundId: id,
      outletId: outletA,
      reason: "pending_unapproved",
      thresholdHours: 24,
    });

    const second = await sweep();
    const third = await sweep();
    expect(second.escalated).toBe(0);
    expect(third.escalated).toBe(0);
    expect(await audits(id)).toHaveLength(1);
    expect(await outboxRows(id)).toHaveLength(1);
    expect((await refundRow(id)).escalated_at).toEqual(row.escalated_at);
  });

  it("legend-n9kn escalation changes only the two escalation columns (money safety)", async () => {
    const pending = await seedRefund({ createdHoursAgo: 30 });
    const polling = await seedRefund({
      status: "approved",
      decidedHoursAgo: 80,
      polls: 4,
    });
    const before = {
      pending: await snapshot(pending),
      polling: await snapshot(polling),
    };

    // Called directly so a payout run cannot be what changed a column.
    const escalated = await escalateStaleRefunds(
      tenantWide,
      new Date(),
      100,
    );

    expect(escalated).toBeGreaterThanOrEqual(2);
    expect((await refundRow(pending)).escalation_reason).toBe(
      "pending_unapproved",
    );
    expect((await refundRow(polling)).escalation_reason).toBe(
      "provider_pending",
    );
    // status, amount_idr, updated_at, attempts, polls, lease, error, provider_ref,
    // decided_at, approved_by, failure_reason: the whole row bar the two columns.
    expect(await snapshot(pending)).toEqual(before.pending);
    expect(await snapshot(polling)).toEqual(before.polling);
  });

  it("legend-n9kn a pending refund that has an approval chain is never escalated", async () => {
    const id = await seedRefund({ createdHoursAgo: 200, chain: true });
    const before = await snapshot(id);

    const result = await sweep();

    expect(result.escalated).toBe(0);
    expect((await refundRow(id)).escalated_at).toBeNull();
    expect(await snapshot(id)).toEqual(before);
    expect(await audits(id)).toHaveLength(0);
    expect(await outboxRows(id)).toHaveLength(0);
  });

  it("legend-n9kn completed and failed refunds are never escalated", async () => {
    const completed = await seedRefund({
      status: "completed",
      createdHoursAgo: 500,
      decidedHoursAgo: 400,
    });
    const failed = await seedRefund({
      status: "failed",
      createdHoursAgo: 500,
      decidedHoursAgo: 400,
    });

    const result = await sweep();

    expect(result.escalated).toBe(0);
    expect((await refundRow(completed)).escalated_at).toBeNull();
    expect((await refundRow(failed)).escalated_at).toBeNull();
  });

  it("legend-n9kn an approved refund still polling the provider escalates as provider_pending after 72 h, not before", async () => {
    const late = await seedRefund({
      status: "approved",
      decidedHoursAgo: 73,
      polls: 3,
    });
    const early = await seedRefund({
      status: "approved",
      decidedHoursAgo: 71,
      polls: 3,
    });
    // Old enough, but the provider has never been polled: not "provider pending".
    const unpolled = await seedRefund({
      status: "approved",
      decidedHoursAgo: 200,
      polls: 0,
    });

    const result = await sweep();

    expect(result.escalated).toBe(1);
    expect((await refundRow(late)).escalation_reason).toBe("provider_pending");
    expect((await refundRow(early)).escalated_at).toBeNull();
    expect((await refundRow(unpolled)).escalated_at).toBeNull();
    const events = await outboxRows(late);
    expect(events).toHaveLength(1);
    expect(events[0]!.event.payload).toMatchObject({
      reason: "provider_pending",
      thresholdHours: 72,
    });
    expect(await audits(late)).toHaveLength(1);
    expect(await audits(early)).toHaveLength(0);

    await sweep();
    expect(await audits(late)).toHaveLength(1);
    expect(await outboxRows(late)).toHaveLength(1);
  });

  it("legend-n9kn a refund escalated while pending escalates once more as provider_pending when it later stalls at the provider", async () => {
    const id = await seedRefund({ createdHoursAgo: 100 });
    expect((await sweep()).escalated).toBe(1);
    expect((await refundRow(id)).escalation_reason).toBe("pending_unapproved");
    expect(await audits(id)).toHaveLength(1);

    // Approved afterwards and stuck polling the provider for 73 h.
    await owner.query(
      `UPDATE payment_refunds
          SET status = 'approved', approved_by = '${APPROVER}',
              decided_at = $2, payout_pending_polls = 3,
              payout_claimed_until = $3, payout_claim_token = $4
        WHERE id = $1`,
      [
        id,
        new Date(Date.now() - 73 * HOUR),
        new Date(Date.now() + 600 * HOUR),
        randomUUID(),
      ],
    );

    expect((await sweep()).escalated).toBe(1);
    const row = await refundRow(id);
    expect(row.escalation_reason).toBe("provider_pending");
    expect(row.status).toBe("approved");
    expect(await audits(id)).toHaveLength(2);
    expect(await outboxRows(id)).toHaveLength(2);
    // The second audit records the earlier escalation it follows. Assumption:
    // `before` carries the previous `escalatedAt` (the brief asks for a trail).
    const secondAudit = (await audits(id))[1]!;
    expect(secondAudit.before).toHaveProperty("escalatedAt");
    expect(secondAudit.before?.escalatedAt).not.toBeNull();
    expect(secondAudit.after).toMatchObject({
      escalationReason: "provider_pending",
    });

    expect((await sweep()).escalated).toBe(0);
    expect(await audits(id)).toHaveLength(2);
    expect(await outboxRows(id)).toHaveLength(2);
  });

  it("legend-n9kn a per-tenant threshold applies: 3 h old escalates at 2 h, not at the default", async () => {
    const id = await seedRefund({ createdHoursAgo: 3 });
    expect((await sweep()).escalated).toBe(0);
    expect((await refundRow(id)).escalated_at).toBeNull();

    await owner.query(
      `INSERT INTO payment_refund_escalation_settings (tenant_id, pending_unapproved_hours)
       VALUES ($1, 2)
       ON CONFLICT (tenant_id) DO UPDATE SET pending_unapproved_hours = 2`,
      [tenantId],
    );

    expect((await sweep()).escalated).toBe(1);
    expect((await refundRow(id)).escalation_reason).toBe("pending_unapproved");
    const events = await outboxRows(id);
    expect(events).toHaveLength(1);
    expect(events[0]!.event.payload).toMatchObject({ thresholdHours: 2 });
  });

  it("legend-n9kn a sweep of one tenant never touches another tenant's stale refund", async () => {
    const mine = await seedRefund({ createdHoursAgo: 30 });
    const theirs = await seedRefund({
      createdHoursAgo: 30,
      seed: otherSeed,
    });
    const theirsBefore = await snapshot(theirs);

    expect((await sweep()).escalated).toBe(1);
    expect((await refundRow(mine)).escalation_reason).toBe(
      "pending_unapproved",
    );
    expect((await refundRow(theirs)).escalated_at).toBeNull();
    expect(await snapshot(theirs)).toEqual(theirsBefore);
    expect(await audits(theirs, other.tenantId)).toHaveLength(0);
    expect(await outboxRows(theirs, other.tenantId)).toHaveLength(0);

    // Positive control: their own sweep escalates theirs, and mine stays at one audit.
    const own = await escalateStaleRefunds(contextOf(other.tenantId));
    expect(own).toBe(1);
    expect((await refundRow(theirs)).escalation_reason).toBe(
      "pending_unapproved",
    );
    expect(await audits(mine)).toHaveLength(1);
    await owner.query(
      "DELETE FROM domain_event_outbox WHERE aggregate_id = $1::uuid",
      [theirs],
    );
    await owner.query("DELETE FROM payment_refunds WHERE id = $1", [theirs]);
  });

  it("legend-n9kn two concurrent escalation runs write exactly one audit row and one notification event", async () => {
    const id = await seedRefund({ createdHoursAgo: 40 });

    await Promise.all([
      escalateStaleRefunds(tenantWide, new Date(), 100),
      escalateStaleRefunds(tenantWide, new Date(), 100),
    ]);

    expect((await refundRow(id)).escalation_reason).toBe("pending_unapproved");
    expect(await audits(id)).toHaveLength(1);
    expect(await outboxRows(id)).toHaveLength(1);
  });

  it("legend-n9kn re-opening an escalated quarantined refund clears its escalation so the new wait can escalate again", async () => {
    const id = await seedRefund({ createdHoursAgo: 100 });
    expect((await sweep()).escalated).toBe(1);
    expect((await refundRow(id)).escalated_at).not.toBeNull();

    // Assumption: a refund can only be re-opened while never sent (no attempts,
    // polls or provider ref), so it is moved into the quarantined state here
    // while keeping its escalation columns.
    await owner.query(
      `UPDATE payment_refunds
          SET status = 'approved', approved_by = '${APPROVER}',
              decided_at = now() - interval '1 hour',
              last_payout_error = 'PAYOUT_QUARANTINED'
        WHERE id = $1`,
      [id],
    );

    const reopenKey = `esc-reopen-${randomUUID()}`;
    const view = await reopenQuarantinedRefund(
      tenantWide,
      opsUser,
      { refundId: id },
      {
        idempotencyKey: reopenKey,
        note: "Persetujuan lama tidak sah, diputuskan ops.",
      },
      reopenKey,
      { mfaVerified: true },
    );
    expect(view.status).toBe("pending");
    const row = await refundRow(id);
    expect(row.status).toBe("pending");
    expect(row.escalated_at).toBeNull();
    expect(row.escalation_reason).toBeNull();

    // Still old and unapproved: it escalates again, with a second audit and event.
    expect((await sweep()).escalated).toBeGreaterThanOrEqual(1);
    expect((await refundRow(id)).escalation_reason).toBe("pending_unapproved");
    expect(await audits(id)).toHaveLength(2);
    expect(await outboxRows(id)).toHaveLength(2);
  });

  it("legend-n9kn the refund list filtered to escalated shows only open (pending or approved) escalated refunds", async () => {
    const pending = await seedRefund({ createdHoursAgo: 30 });
    const approved = await seedRefund({
      status: "approved",
      decidedHoursAgo: 80,
      polls: 4,
    });
    const completed = await seedRefund({ createdHoursAgo: 31 });
    const failed = await seedRefund({ createdHoursAgo: 32 });
    const calm = await seedRefund({ createdHoursAgo: 1 });
    expect((await sweep()).escalated).toBeGreaterThanOrEqual(3);
    // Closed afterwards: escalated once, no one needs to act any more.
    await owner.query(
      `UPDATE payment_refunds SET status = 'completed', approved_by = '${APPROVER}', decided_at = now() WHERE id = $1`,
      [completed],
    );
    await owner.query(
      "UPDATE payment_refunds SET status = 'failed', failure_reason = 'rejected' WHERE id = $1",
      [failed],
    );

    const escalated = await listRefunds(tenantWide, opsUser, {
      outletId: outletA,
      escalated: "true",
      limit: 100,
    });
    const ids = escalated.data.map((refund) => refund.id);
    expect(ids).toContain(pending);
    expect(ids).toContain(approved);
    expect(ids).not.toContain(completed);
    expect(ids).not.toContain(failed);
    expect(ids).not.toContain(calm);
    for (const refund of escalated.data)
      expect(["pending", "approved"]).toContain(refund.status);

    const calmOnly = await listRefunds(tenantWide, opsUser, {
      outletId: outletA,
      escalated: "false",
      limit: 100,
    });
    const calmIds = calmOnly.data.map((refund) => refund.id);
    expect(calmIds).toContain(calm);
    expect(calmIds).not.toContain(pending);
  });
});

describe("legend-n9kn notification recipients for payment.refund_escalated", () => {
  const createdUsers: string[] = [];
  const envelope = () =>
    eventEnvelopeSchema.parse({
      ...eventFixture,
      id: createUlid(),
      tenantId,
      outletId: outletA,
      name: ESCALATED_EVENT,
      aggregateType: "payment",
      aggregateId: randomUUID(),
      idempotencyKey: `${ESCALATED_EVENT}-${randomUUID()}`,
      payloadSchemaRef: `${ESCALATED_EVENT}.v1`,
      payload: {
        refundId: randomUUID(),
        outletId: outletA,
        amountIdr: 75_000,
        reason: "pending_unapproved",
        waitingSince: new Date(Date.now() - 30 * HOUR).toISOString(),
        thresholdHours: 24,
        escalatedAt: new Date().toISOString(),
      },
    });

  async function userWith(
    templateKey: string,
    scopeType: "tenant" | "outlet",
  ): Promise<string> {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)`,
      [id, `Esc ${templateKey}`, `${id}@example.test`],
    );
    createdUsers.push(id);
    const role = await owner.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
      [tenantId, templateKey],
    );
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
      [
        tenantId,
        id,
        role.rows[0]!.id,
        scopeType,
        scopeType === "outlet" ? outletA : null,
      ],
    );
    return id;
  }

  afterAll(async () => {
    await owner.query("DELETE FROM role_assignments WHERE user_id = ANY($1::text[])", [
      createdUsers,
    ]);
    await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
      createdUsers,
    ]);
  });

  it("legend-n9kn the alert reaches the outlet manager and finance, not a cashier, and the resolver does not throw", async () => {
    const manager = await userWith("outlet_manager", "outlet");
    const finance = await userWith("finance", "tenant");
    const cashier = await userWith("cashier", "outlet");

    const recipients = await withTenant(database, tenantWide, (tx) =>
      createNotificationRecipientResolver({ email: false, push: false })(
        tenantWide,
        envelope(),
        tx,
      ),
    );

    const ids = recipients.map((recipient) => recipient.userId);
    expect(recipients.length).toBeGreaterThan(0);
    expect(ids).toContain(manager);
    expect(ids).toContain(finance);
    expect(ids).not.toContain(cashier);
  });
});
