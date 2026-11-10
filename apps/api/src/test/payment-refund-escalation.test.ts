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
// - payout_stalled (legend-ix8i): written from the sub-brief rule. thresholdHours
//   in the event payload is the per-tenant payout_stalled_hours (same meaning as
//   for the other reasons), and `waitingSince` is the stall stamp. Stall tests
//   call escalateStaleRefunds directly so the payout sweep cannot move a row.
// - Evidence mapping (legend-ix8i): the brief calls it `mapRefundEvidence`; the
//   user-facing action is the ops retry that maps a fund to its source evidence
//   (retryRefundPayout with sourceEvidenceId). The retry also runs one payout
//   attempt, so the gateway is scripted to time out and the refund stays
//   approved; the next stall is then simulated by setting MANUAL_RECONCILIATION.
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
  retryRefundPayout,
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
const fundIds: string[] = [];
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
  /** last_payout_error for a non-polling approved refund (e.g. MANUAL_RECONCILIATION). */
  payoutError?: string;
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
      input.payoutError ?? (polling ? "provider_pending" : null),
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
  payout_stall_detected_at: Date | null;
};

async function refundRow(id: string): Promise<Row> {
  const { rows } = await owner.query<Row>(
    "SELECT status, amount_idr, escalated_at, escalation_reason, payout_stall_detected_at FROM payment_refunds WHERE id = $1",
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

/** Every column except the three escalation-owned ones (escalation pair + stall stamp). */
async function moneySnapshot(id: string): Promise<Record<string, unknown>> {
  const { rows } = await owner.query<{ snap: Record<string, unknown> }>(
    `SELECT to_jsonb(r) - 'escalated_at' - 'escalation_reason' - 'payout_stall_detected_at' AS snap
     FROM payment_refunds r WHERE id = $1`,
    [id],
  );
  return rows[0]!.snap;
}

async function backdateStall(id: string, hours: number) {
  await owner.query(
    "UPDATE payment_refunds SET payout_stall_detected_at = now() - ($2::int * interval '1 hour') WHERE id = $1",
    [id, hours],
  );
}

const escalate = () => escalateStaleRefunds(tenantWide, new Date(), 100);

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

async function evidenceMappedAudits(refundId: string) {
  const { rows } = await owner.query<{
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }>(
    `SELECT event->'maskedChanges'->'before' AS before,
            event->'maskedChanges'->'after' AS after
     FROM audit_logs
     WHERE tenant_id = $1 AND event->>'objectId' = $2
       AND event->>'action' = 'payment.refund_fund_evidence_mapped'
     ORDER BY created_at`,
    [tenantId, refundId],
  );
  return rows;
}

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
    "DELETE FROM payment_unallocated_funds WHERE id = ANY($1::uuid[])",
    [fundIds],
  );
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
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    opsUsers,
  ]);
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

const gatewayModes: [string, () => FakeRefundGateway | null, boolean][] = [
  ["no gateway installed", () => null, false],
  ["FakeRefundGateway installed", () => new FakeRefundGateway(), true],
];

describe.each(gatewayModes)(
  "legend-n9kn refund escalation (%s)",
  (_label, makeGateway, installed) => {
    // A refund that is "stalled" in this mode: with a gateway it needs a stuck-payout
    // error flag; without one an approved refund with no polls is enough.
    const stallError = installed ? "MANUAL_RECONCILIATION" : undefined;

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
      const escalated = await escalateStaleRefunds(tenantWide, new Date(), 100);

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

    it("legend-n9kn a pending refund that has an approval chain is escalated past the threshold and stays pending with its chain untouched", async () => {
      // legend-zi9o: the chain now opens when the refund is requested, so a
      // refund waiting in the inbox must still raise the alarm before it expires.
      const id = await seedRefund({ createdHoursAgo: 200, chain: true });
      const before = await snapshot(id);

      const result = await sweep();

      expect(result.escalated).toBe(1);
      const row = await refundRow(id);
      expect(row.escalated_at).not.toBeNull();
      expect(row.escalation_reason).toBe("pending_unapproved");
      expect(row.status).toBe("pending");
      // Everything but the two escalation columns is unchanged, chain id included.
      expect(await snapshot(id)).toEqual(before);
      expect(await audits(id)).toHaveLength(1);
      expect(await outboxRows(id)).toHaveLength(1);

      // Once only.
      expect((await sweep()).escalated).toBe(0);
      expect(await audits(id)).toHaveLength(1);
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
      expect((await refundRow(late)).escalation_reason).toBe(
        "provider_pending",
      );
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
      expect((await refundRow(id)).escalation_reason).toBe(
        "pending_unapproved",
      );
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
      // Found by its `before`, not by position: created_at can tie or step back.
      const secondAudit = (await audits(id)).find(
        (row) => row.before?.escalatedAt != null,
      )!;
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
      expect((await refundRow(id)).escalation_reason).toBe(
        "pending_unapproved",
      );
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

      expect((await refundRow(id)).escalation_reason).toBe(
        "pending_unapproved",
      );
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
      expect((await refundRow(id)).escalation_reason).toBe(
        "pending_unapproved",
      );
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

    // ---- legend-ix8i: third reason payout_stalled -------------------------------

    const stalledSeed = (extra: RefundSeed = {}): Promise<string> =>
      seedRefund({
        status: "approved",
        decidedHoursAgo: 1,
        polls: 0,
        payoutError: stallError,
        ...extra,
      });

    it
      .skipIf(!installed)
      .each([
        "MANUAL_RECONCILIATION",
        "PAYOUT_QUARANTINED",
        "EVIDENCE_MAPPING_REQUIRED",
      ])(
      "legend-ix8i with a gateway, an approved refund flagged %s is stamped first and escalates as payout_stalled 24 h later, once",
      async (flag) => {
        const id = await stalledSeed({ payoutError: flag });

        expect(await escalate()).toBe(0);
        const stamped = await refundRow(id);
        expect(stamped.payout_stall_detected_at).not.toBeNull();
        expect(stamped.escalated_at).toBeNull();
        expect(stamped.escalation_reason).toBeNull();
        expect(await audits(id)).toHaveLength(0);
        expect(await outboxRows(id)).toHaveLength(0);

        // Another sweep inside the 24 h window changes nothing, the clock is not restarted.
        expect(await escalate()).toBe(0);
        expect((await refundRow(id)).payout_stall_detected_at).toEqual(
          stamped.payout_stall_detected_at,
        );

        await backdateStall(id, 25);
        const stampAfterBackdate = (await refundRow(id))
          .payout_stall_detected_at;
        expect(await escalate()).toBe(1);
        const row = await refundRow(id);
        expect(row.escalation_reason).toBe("payout_stalled");
        expect(row.escalated_at).not.toBeNull();
        expect(row.status).toBe("approved");
        const auditRows = await audits(id);
        expect(auditRows).toHaveLength(1);
        expect(auditRows[0]!.actor).toBeNull();
        expect(auditRows[0]!.before).toHaveProperty("escalatedAt");
        expect(auditRows[0]!.after).toMatchObject({
          escalationReason: "payout_stalled",
          status: "approved",
        });
        const events = await outboxRows(id);
        expect(events).toHaveLength(1);
        expect(events[0]!.destination).toBe("notification");
        expect(events[0]!.event.payload).toMatchObject({
          refundId: id,
          outletId: outletA,
          reason: "payout_stalled",
          thresholdHours: 24,
        });
        expect(
          new Date(String(events[0]!.event.payload.waitingSince)).getTime(),
        ).toBe(stampAfterBackdate!.getTime());

        expect(await escalate()).toBe(0);
        expect(await escalate()).toBe(0);
        expect(await audits(id)).toHaveLength(1);
        expect(await outboxRows(id)).toHaveLength(1);
        expect((await refundRow(id)).escalated_at).toEqual(row.escalated_at);
      },
    );

    it.skipIf(!installed)(
      "legend-ix8i with a gateway, an approved refund with no error flag (normal payout backoff) or an unrelated error is never stamped or escalated",
      async () => {
        const calm = await stalledSeed({
          payoutError: undefined,
          decidedHoursAgo: 200,
        });
        const transient = await stalledSeed({
          payoutError: "PROVIDER_TIMEOUT",
          decidedHoursAgo: 200,
        });

        expect(await escalate()).toBe(0);
        expect(await escalate()).toBe(0);

        for (const id of [calm, transient]) {
          const row = await refundRow(id);
          expect(row.payout_stall_detected_at).toBeNull();
          expect(row.escalated_at).toBeNull();
          expect(await audits(id)).toHaveLength(0);
          expect(await outboxRows(id)).toHaveLength(0);
        }
      },
    );

    it.skipIf(installed)(
      "legend-ix8i without a gateway, an approved refund that was never polled is stamped, then escalates as payout_stalled after 24 h of stall; a polled one is not stalled",
      async () => {
        const stuck = await stalledSeed({ decidedHoursAgo: 2 });
        const polled = await seedRefund({
          status: "approved",
          decidedHoursAgo: 2,
          polls: 3,
        });

        expect(await escalate()).toBe(0);
        const stamped = await refundRow(stuck);
        expect(stamped.payout_stall_detected_at).not.toBeNull();
        expect(stamped.escalated_at).toBeNull();
        expect(await audits(stuck)).toHaveLength(0);
        expect((await refundRow(polled)).payout_stall_detected_at).toBeNull();

        await backdateStall(stuck, 25);
        expect(await escalate()).toBe(1);
        expect((await refundRow(stuck)).escalation_reason).toBe(
          "payout_stalled",
        );
        expect(await audits(stuck)).toHaveLength(1);
        const events = await outboxRows(stuck);
        expect(events).toHaveLength(1);
        expect(events[0]!.event.payload).toMatchObject({
          reason: "payout_stalled",
          thresholdHours: 24,
        });
        expect((await refundRow(polled)).escalated_at).toBeNull();

        expect(await escalate()).toBe(0);
        expect(await audits(stuck)).toHaveLength(1);
        expect(await outboxRows(stuck)).toHaveLength(1);
      },
    );

    it.skipIf(!installed)(
      "legend-ix8i with a gateway, clearing the error flag (a retry) resets the stall clock, so the old stamp never escalates and a new stall starts fresh",
      async () => {
        const id = await stalledSeed();
        expect(await escalate()).toBe(0);
        expect((await refundRow(id)).payout_stall_detected_at).not.toBeNull();
        await backdateStall(id, 30);

        await owner.query(
          "UPDATE payment_refunds SET last_payout_error = NULL WHERE id = $1",
          [id],
        );
        expect(await escalate()).toBe(0);
        const reset = await refundRow(id);
        expect(reset.payout_stall_detected_at).toBeNull();
        expect(reset.escalated_at).toBeNull();
        expect(await audits(id)).toHaveLength(0);

        // Stalls again: a fresh stamp, and no escalation off the old one.
        await owner.query(
          "UPDATE payment_refunds SET last_payout_error = 'PAYOUT_QUARANTINED' WHERE id = $1",
          [id],
        );
        expect(await escalate()).toBe(0);
        const restamped = await refundRow(id);
        expect(restamped.payout_stall_detected_at).not.toBeNull();
        expect(restamped.escalated_at).toBeNull();
        expect(
          Date.now() - restamped.payout_stall_detected_at!.getTime(),
        ).toBeLessThan(HOUR);
      },
    );

    it("legend-ix8i a stalled refund that starts polling the provider, or leaves approved, gets its stall stamp cleared and is not escalated as payout_stalled", async () => {
      const polling = await stalledSeed();
      const closed = await stalledSeed();
      expect(await escalate()).toBe(0);
      expect(
        (await refundRow(polling)).payout_stall_detected_at,
      ).not.toBeNull();
      expect((await refundRow(closed)).payout_stall_detected_at).not.toBeNull();
      await backdateStall(polling, 30);
      await backdateStall(closed, 30);

      await owner.query(
        `UPDATE payment_refunds
          SET payout_pending_polls = 3, payout_claimed_until = $2, payout_claim_token = $3
        WHERE id = $1`,
        [polling, new Date(Date.now() + 600 * HOUR), randomUUID()],
      );
      await owner.query(
        "UPDATE payment_refunds SET status = 'completed' WHERE id = $1",
        [closed],
      );

      expect(await escalate()).toBe(0);
      for (const id of [polling, closed]) {
        const row = await refundRow(id);
        expect(row.payout_stall_detected_at).toBeNull();
        expect(row.escalated_at).toBeNull();
        expect(await audits(id)).toHaveLength(0);
        expect(await outboxRows(id)).toHaveLength(0);
      }
    });

    it("legend-ix8i a per-tenant payout_stalled_hours of 2 is honoured, the 24 h default is not", async () => {
      const id = await stalledSeed();
      expect(await escalate()).toBe(0);
      await backdateStall(id, 3);
      // Default 24 h: 3 h of stall is not enough.
      expect(await escalate()).toBe(0);
      expect((await refundRow(id)).escalated_at).toBeNull();

      await owner.query(
        `INSERT INTO payment_refund_escalation_settings (tenant_id, payout_stalled_hours)
       VALUES ($1, 2)
       ON CONFLICT (tenant_id) DO UPDATE SET payout_stalled_hours = 2`,
        [tenantId],
      );
      await backdateStall(id, 1);
      expect(await escalate()).toBe(0);
      expect((await refundRow(id)).escalated_at).toBeNull();

      await backdateStall(id, 3);
      expect(await escalate()).toBe(1);
      expect((await refundRow(id)).escalation_reason).toBe("payout_stalled");
      const events = await outboxRows(id);
      expect(events).toHaveLength(1);
      expect(events[0]!.event.payload).toMatchObject({
        reason: "payout_stalled",
        thresholdHours: 2,
      });
    });

    it("legend-ix8i payout_stalled escalation writes only the stall stamp and the escalation pair; every money and payout column is unchanged", async () => {
      const id = await stalledSeed();
      // A prior attempt and an expired lease make the payout columns non-trivial.
      await owner.query(
        `UPDATE payment_refunds
          SET payout_attempts = 2, payout_claimed_until = $2, payout_claim_token = $3
        WHERE id = $1`,
        [id, new Date(Date.now() - 5 * HOUR), randomUUID()],
      );
      const before = await moneySnapshot(id);

      expect(await escalate()).toBe(0);
      expect(await moneySnapshot(id)).toEqual(before);

      await backdateStall(id, 25);
      expect(await escalate()).toBe(1);
      expect((await refundRow(id)).escalation_reason).toBe("payout_stalled");
      // status, amount_idr, updated_at, payout_attempts, payout_pending_polls,
      // lease, last_payout_error, provider_ref, decided_at, ...
      expect(await moneySnapshot(id)).toEqual(before);
      const row = await refundRow(id);
      expect(row.status).toBe("approved");
      expect(row.amount_idr).toBe("75000");
    });

    it("legend-ix8i a payout_stalled refund that later polls the provider for 73 h escalates once as provider_pending and never goes back to payout_stalled", async () => {
      const id = await stalledSeed();
      expect(await escalate()).toBe(0);
      await backdateStall(id, 25);
      expect(await escalate()).toBe(1);
      expect((await refundRow(id)).escalation_reason).toBe("payout_stalled");
      expect(await audits(id)).toHaveLength(1);

      await owner.query(
        `UPDATE payment_refunds
          SET decided_at = $2, payout_pending_polls = 3,
              payout_claimed_until = $3, payout_claim_token = $4
        WHERE id = $1`,
        [
          id,
          new Date(Date.now() - 73 * HOUR),
          new Date(Date.now() + 600 * HOUR),
          randomUUID(),
        ],
      );

      expect(await escalate()).toBe(1);
      const row = await refundRow(id);
      expect(row.escalation_reason).toBe("provider_pending");
      expect(row.payout_stall_detected_at).toBeNull();
      const auditRows = await audits(id);
      expect(auditRows).toHaveLength(2);
      // Found by its `before`, not by position: created_at can tie or step back.
      const followUp = auditRows.find((row) => row.before?.escalatedAt != null)!;
      expect(followUp.before).toHaveProperty("escalatedAt");
      expect(followUp.before?.escalatedAt).not.toBeNull();
      expect(followUp.after).toMatchObject({
        escalationReason: "provider_pending",
      });
      expect(await outboxRows(id)).toHaveLength(2);

      expect(await escalate()).toBe(0);
      expect(await escalate()).toBe(0);
      expect((await refundRow(id)).escalation_reason).toBe("provider_pending");
      expect(await audits(id)).toHaveLength(2);
      expect(await outboxRows(id)).toHaveLength(2);
    });

    it("legend-ix8i re-opening a stalled refund clears its stall stamp together with its escalation", async () => {
      const id = await stalledSeed({ payoutError: "PAYOUT_QUARANTINED" });
      expect(await escalate()).toBe(0);
      await backdateStall(id, 25);
      expect(await escalate()).toBe(1);
      const stalled = await refundRow(id);
      expect(stalled.escalation_reason).toBe("payout_stalled");
      expect(stalled.payout_stall_detected_at).not.toBeNull();

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
      expect(row.payout_stall_detected_at).toBeNull();
      expect(row.escalated_at).toBeNull();
      expect(row.escalation_reason).toBeNull();
    });

    /** An approved, never-polled fund refund whose payout waits for evidence mapping, approved by an ops user with supervisor authority. decided_at is now(): an older decision made the payout re-validation quarantine it (supervisor_required). */
    async function seedFundRefund(): Promise<{
      id: string;
      evidenceId: string;
    }> {
      const seed = await seedPaid();
      const evidence = await owner.query<{ id: string }>(
        "SELECT id FROM payment_evidence WHERE payment_intent_id = $1",
        [seed.intentId],
      );
      const fundId = randomUUID();
      fundIds.push(fundId);
      await owner.query(
        `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
       VALUES ($1, $2, $3, $4, NULL, 20000, 'overpayment')`,
        [fundId, tenantId, outletA, seed.intentId],
      );
      const id = randomUUID();
      refundIds.push(id);
      await owner.query(
        `INSERT INTO payment_refunds
         (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by,
          approved_by, decided_at, payout_attempts, last_payout_error, updated_at, unallocated_fund_id)
       VALUES ($1, $2, $3, $4, 20000, 'Kembalikan kelebihan bayar', 'approved', $5,
          $6, now(), 0, 'EVIDENCE_MAPPING_REQUIRED', now() - interval '2 hours', $7)`,
        [id, tenantId, outletA, seed.intentId, REQUESTER, opsUser, fundId],
      );
      return { id, evidenceId: evidence.rows[0]!.id };
    }

    const mapEvidence = (id: string, evidenceId: string) => {
      // The retry runs one payout attempt; a timeout leaves the refund approved.
      fake!.enqueue("throw");
      const retryKey = `esc-map-${randomUUID()}`;
      return retryRefundPayout(
        tenantWide,
        opsUser,
        { refundId: id, sourceEvidenceId: evidenceId },
        retryKey,
      );
    };

    it.skipIf(!installed)(
      "legend-ix8i mapping a stalled refund's evidence clears the payout_stalled flag; when it stalls again it escalates anew (2 audits, 2 notifications in total)",
      async () => {
        const { id, evidenceId } = await seedFundRefund();
        expect(await escalate()).toBe(0);
        await backdateStall(id, 25);
        expect(await escalate()).toBe(1);
        expect((await refundRow(id)).escalation_reason).toBe("payout_stalled");
        expect(await audits(id)).toHaveLength(1);
        expect(await outboxRows(id)).toHaveLength(1);

        await mapEvidence(id, evidenceId);
        const mapped = await refundRow(id);
        expect(mapped.status).toBe("approved");
        expect(mapped.escalated_at).toBeNull();
        expect(mapped.escalation_reason).toBeNull();
        expect(mapped.payout_stall_detected_at).toBeNull();
        const mappedAudits = await evidenceMappedAudits(id);
        expect(mappedAudits).toHaveLength(1);
        expect(mappedAudits[0]!.before?.escalationReason).toBe(
          "payout_stalled",
        );
        expect(mappedAudits[0]!.after?.escalationReason).toBeNull();

        // Nothing is stalled right after mapping, so the sweep escalates nothing.
        expect(await escalate()).toBe(0);
        expect((await refundRow(id)).escalated_at).toBeNull();
        expect(await audits(id)).toHaveLength(1);

        // The payout stalls again: new stamp, then a second escalation after 25 h.
        await owner.query(
          "UPDATE payment_refunds SET last_payout_error = 'MANUAL_RECONCILIATION' WHERE id = $1",
          [id],
        );
        expect(await escalate()).toBe(0);
        expect((await refundRow(id)).payout_stall_detected_at).not.toBeNull();
        expect((await refundRow(id)).escalated_at).toBeNull();
        await backdateStall(id, 25);
        expect(await escalate()).toBe(1);
        const again = await refundRow(id);
        expect(again.escalation_reason).toBe("payout_stalled");
        expect(again.escalated_at).not.toBeNull();
        expect(await audits(id)).toHaveLength(2);
        expect(await outboxRows(id)).toHaveLength(2);

        expect(await escalate()).toBe(0);
        expect(await audits(id)).toHaveLength(2);
        expect(await outboxRows(id)).toHaveLength(2);
      },
    );

    it.skipIf(!installed)(
      "legend-ix8i mapping a refund's evidence keeps an escalation of another reason (pending_unapproved) and only resets its stall clock",
      async () => {
        const { id, evidenceId } = await seedFundRefund();
        expect(await escalate()).toBe(0);
        expect((await refundRow(id)).payout_stall_detected_at).not.toBeNull();
        await owner.query(
          `UPDATE payment_refunds
            SET escalated_at = now() - interval '5 hours', escalation_reason = 'pending_unapproved'
          WHERE id = $1`,
          [id],
        );
        const escalatedAt = (await refundRow(id)).escalated_at;

        await mapEvidence(id, evidenceId);

        const row = await refundRow(id);
        expect(row.escalation_reason).toBe("pending_unapproved");
        expect(row.escalated_at).toEqual(escalatedAt);
        expect(row.payout_stall_detected_at).toBeNull();
        expect(row.status).toBe("approved");
        const mappedAudits = await evidenceMappedAudits(id);
        expect(mappedAudits).toHaveLength(1);
        expect(mappedAudits[0]!.before?.escalationReason).toBe(
          "pending_unapproved",
        );
        expect(mappedAudits[0]!.after?.escalationReason).toBe(
          "pending_unapproved",
        );
      },
    );
  },
);

describe("legend-n9kn notification recipients for payment.refund_escalated", () => {
  const createdUsers: string[] = [];
  const envelope = (reason = "pending_unapproved") =>
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
        reason,
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
    await owner.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [createdUsers],
    );
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
  it("legend-ix8i the payout_stalled alert reaches the outlet manager and finance, not a cashier, and the resolver does not throw", async () => {
    const manager = await userWith("outlet_manager", "outlet");
    const finance = await userWith("finance", "tenant");
    const cashier = await userWith("cashier", "outlet");

    const recipients = await withTenant(database, tenantWide, (tx) =>
      createNotificationRecipientResolver({ email: false, push: false })(
        tenantWide,
        envelope("payout_stalled"),
        tx,
      ),
    );

    const ids = recipients.map((recipient) => recipient.userId);
    expect(ids).toContain(manager);
    expect(ids).toContain(finance);
    expect(ids).not.toContain(cashier);
  });
});
