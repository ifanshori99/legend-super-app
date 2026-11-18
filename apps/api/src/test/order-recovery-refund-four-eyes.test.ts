// legend-94q2l slice T2: four-eyes of the gateway payout of a refund that the
// failed-item recovery (ORD-09) opened, and the accounting payout guard of the
// QR sale. Written from the brief docs/briefs/94q2l-impl-brief.md before the
// implementation exists (slices I3 and I4), so the file starts red.
//
// Part 1 (seeded tenant, real Express app, Better Auth, RLS on; only the refund
// provider is a fake). A refund filed by the recovery has requested_by
// `system:recovery` and `order_issue_id` set. Its parties are the approver of the
// ORD-09 approval (`order_issues.approved_by`) and the resolver / approver read
// from the admin idempotency row `order-recovery-refund:<issueId>`. None of them
// may approve its payout; a third person with `payment.reconcile` (Finance) may.
// Part 2 (fresh tenant per case, `deliverAutoJournalEvent`). The `qrSales` guard
// of a payout subtracts what a recovery refund released from the QR sale only
// once that refund's `order.refunded` journal is posted; while it waits in the
// outbox the payout parks retryable (backing pending).
//
// Assumptions where the brief is not exact:
// - The refund and its idempotency row are seeded by SQL (the consumer is T1's
//   job) and the chain is opened the way creation does it
//   (`openRefundChainAtRequest`). The seeded order is not pinned to the intent
//   (`orders.payment_intent_id` NULL), so the QR sale hold (slice I3) cannot
//   interfere with the party rules under test.
// - A refused approval answers a 4xx carrying `APPROVER_IS_REQUESTER`, the same
//   code as the POS refund parties (pos-refund-gateway-autofile.test.ts).
// - Fail closed: a `system:recovery` refund whose parties cannot be read (no
//   order_issue_id, or no idempotency row) is refused for everyone, even a
//   third person.
// - A party who decides the last (or any) level of a multi-level chain makes the
//   refund end `failed` with failure_reason `approver_unauthorized`, as for POS.
// - Guard cases: QR pay_first order of 100k + 10k PBJT (total 110k, no deposit)
//   paid by one intent of 110k; the recovery refund is 44k (line 40k + 4k PBJT).
//   A payout whose refund row carries the issue's id and whose `order.refunded`
//   journal is posted posts; with that journal still in the outbox it parks
//   `AUTO_JOURNAL_RECEIPT_PENDING` retryable (same code as the POS-refund
//   backing in accounting-auto-journal.test.ts AJ-HXPD5-04); with it parked
//   non-retryable the payout parks `POSTING_AMOUNTS_MISMATCH` non-retryable.
//   The `order.refunded` payload has `refundId = orderIssueId`, so its journal
//   key is `aj:order-refund:<issueId>`.
// - Rows whose foreign keys point at users or menu items that the test does not
//   need (order_items, order_issues) are inserted with
//   session_replication_role = replica, as other suites do.
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { createApp } from "../app";
import { db } from "../db";
import { paymentRefunds } from "../db/schema/index";
import { withTenant } from "../db/tenant";
import {
  deliverAutoJournalEvent,
  retryParkedAutoJournals,
  type AutoJournalResult,
} from "../services/accounting-auto-journal-consumer";
import { setAuditWriter } from "../services/audit-writer";
import { coreAuditWriter } from "../services/core-audit-writer";
import { outletContext } from "../services/device-pin-support";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import { settleRefundFromChain } from "../services/payment-refund.service";
import {
  handleRefundApprovalResolved,
  openRefundChainAtRequest,
  runRefundPayout,
} from "../services/payment-refund.service";
import { decideApprovalRequest } from "../services/platform-approval.service";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import { FakeRefundGateway } from "./refund-fake-gateway";
import { owner, seededOutletA, seededTenantId } from "./floor-test-helpers";

afterAll(async () => {
  await owner.end();
});

// ============================================================================
// Part 1: four-eyes of the payout
// ============================================================================

const ADMIN = "/api/payments/admin";
const BUSINESS_DATE = "2031-03-17";
const REFUND_AMOUNT = 44_000;

type Client = ReturnType<typeof agent>;

async function asOwner<T>(
  run: (client: PoolClient) => Promise<T>,
  { replica = false }: { replica?: boolean } = {},
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (replica)
      await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
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

const app = createApp();
const key = (prefix = "rfe") => `${prefix}-${randomUUID()}`;

const sessionTenant = () =>
  establishTenantContext({
    tenantId: tenantIdSchema.parse(seededTenantId),
    brandId: null,
    source: "session",
  });
const scope = () =>
  establishScopedTenantContext(sessionTenant(), { kind: "tenant" });
const workerContext = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "job",
    }),
    { kind: "tenant" },
  );

// Four Finance + outlet-supervisor users: [0] approved ORD-09, [1] resolved the
// issue, [2] and [3] took no part.
const userIds: string[] = [];
const clients: Client[] = [];
const ord09Approver = () => userIds[0]!;
const resolver = () => userIds[1]!;
const thirdPerson = () => clients[2]!;
const thirdId = () => userIds[2]!;
const fourthId = () => userIds[3]!;
let financeRoleId = "";
let savedPolicies: Record<string, unknown>[] = [];
const intentIds: string[] = [];
const linkIds: string[] = [];
const orderUuids: string[] = [];
const issueIds: string[] = [];
/** Idempotency keys a re-file wrote (`order-recovery-refund:<issue>:<failed refund>`). */
const refiledKeys: string[] = [];

type Seeded = { refundId: string; issueId: string; intentId: string };

/**
 * A pending `system:recovery` refund of a paid intent, as the recovery consumer
 * files it, with its approval chain open. `withIssue` / `withKey` drop the
 * issue link or the idempotency row, to model unreadable parties.
 */
async function recoveryRefund(
  options: { withIssue?: boolean; withKey?: boolean } = {},
): Promise<Seeded> {
  const { withIssue = true, withKey = true } = options;
  const orderUuid = randomUUID();
  const itemUuid = randomUUID();
  const issueId = randomUUID();
  const linkId = randomUUID();
  const intentId = randomUUID();
  const refundId = randomUUID();
  orderUuids.push(orderUuid);
  issueIds.push(issueId);
  linkIds.push(linkId);
  intentIds.push(intentId);
  await asOwner(
    async (client) => {
      await client.query(
        `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
           subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
           prices_include_tax, status, business_date, placed_at, fired_at, deposit_applied_idr)
         VALUES ($1, $2, $3, $4, 'qr', 'takeaway', 'pay_first', 100000, 0, 0, 10000, 0, 110000,
           false, 'sent', $5, now(), now(), 0)`,
        [
          orderUuid,
          seededTenantId,
          seededOutletA,
          `RFE-${randomUUID().slice(0, 8)}`,
          BUSINESS_DATE,
        ],
      );
      await client.query(
        `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
           quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
           fire_status, status, reserved_business_date)
         VALUES ($1, $2, $3, $4, $5, NULL, 'Roti Bakar', 1, 40000, 0, 40000, '[]'::jsonb,
           'fired', 'served', $6)`,
        [
          itemUuid,
          seededTenantId,
          seededOutletA,
          orderUuid,
          randomUUID(),
          BUSINESS_DATE,
        ],
      );
      await client.query(
        `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
           reason_note, reported_by, resolution, approved_by, cost_idr, status, idempotency_key, resolved_at)
         VALUES ($1, $2, $3, $4, $5, 'unfulfillable', 'out_of_stock', 'Roti habis, refund manual disetujui',
           $6, 'manual_refund', $7, 0, 'resolved', $8, now())`,
        [
          issueId,
          seededTenantId,
          seededOutletA,
          orderUuid,
          itemUuid,
          resolver(),
          ord09Approver(),
          `rfe-seed-${randomUUID()}`,
        ],
      );
      await client.query(
        `INSERT INTO payment_links
           (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
         VALUES ($1, $2, $3, $4, $5, 110000, 110000, 110000, 'recovery-four-eyes-test')`,
        [
          linkId,
          seededTenantId,
          seededOutletA,
          randomBytes(32).toString("hex"),
          `RFE-${linkId.slice(0, 8)}`,
        ],
      );
      await client.query(
        `INSERT INTO payment_intents
           (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
            idempotency_key, status, instructions, expires_at, paid_at, provider_ref)
         VALUES ($1, $2, $3, $4, 'qris', 'doit', 110000, $5, 'paid',
                 '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
                 now() + interval '1 hour', now(), $6)`,
        [
          intentId,
          seededTenantId,
          seededOutletA,
          linkId,
          `rfe-pay-${intentId}`,
          `ref-${intentId.slice(0, 8)}`,
        ],
      );
      await client.query(
        `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
         VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', 110000, now())`,
        [seededTenantId, seededOutletA, intentId, `evidence-${intentId}`],
      );
      // 1131: the order pays through this intent (the order budget reads paid
      // from the order's own intent; an unlinked intent pays nothing).
      await client.query(
        "UPDATE orders SET payment_intent_id = $1 WHERE tenant_id = $2 AND id = $3",
        [intentId, seededTenantId, orderUuid],
      );
      await client.query(
        `INSERT INTO payment_refunds
           (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by, order_issue_id)
         VALUES ($1, $2, $3, $4, $5, 'Refund item gagal (ORD-09)', 'pending', 'system:recovery', $6)`,
        [
          refundId,
          seededTenantId,
          seededOutletA,
          intentId,
          REFUND_AMOUNT,
          withIssue ? issueId : null,
        ],
      );
    },
    { replica: true },
  );
  if (withKey)
    await owner.query(
      `INSERT INTO payment_admin_idempotency (tenant_id, key, fingerprint, response)
       VALUES ($1, $2, $3, $4)`,
      [
        seededTenantId,
        `order-recovery-refund:${issueId}`,
        randomBytes(32).toString("hex"),
        JSON.stringify({
          refundId,
          resolvedBy: resolver(),
          approvedBy: ord09Approver(),
        }),
      ],
    );
  // Creation opens the chain of a system refund (requester: the system user).
  const context = outletContext(sessionTenant(), seededOutletA);
  await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, context.tenant.tenantId),
          eq(paymentRefunds.id, refundId),
        ),
      );
    if (!row) throw new Error("refund row missing");
    return openRefundChainAtRequest(tx, context, row, new Date());
  });
  return { refundId, issueId, intentId };
}

const approve = (refundId: string, as: Client) =>
  as
    .post(`${ADMIN}/refunds/${refundId}/approve`)
    .set(originHeader)
    .send({ idempotencyKey: key("apr") })
    .then((response) => response);

async function refundState(refundId: string) {
  const { rows } = await owner.query<{
    status: string;
    failure_reason: string | null;
    approval_chain_id: string | null;
  }>(
    "SELECT status, failure_reason, approval_chain_id FROM payment_refunds WHERE id = $1",
    [refundId],
  );
  return rows[0]!;
}

async function expectRefused(refundId: string, as: Client, code?: string) {
  const fake = new FakeRefundGateway();
  setPaymentRefundGateway(fake);
  try {
    const response = await approve(refundId, as);
    expect(response.status, JSON.stringify(response.body)).toBeGreaterThan(399);
    if (code) expect(JSON.stringify(response.body)).toContain(code);
  } finally {
    setPaymentRefundGateway(null);
  }
  expect(fake.executionCount).toBe(0);
  expect((await refundState(refundId)).status).toBe("pending");
}

describe("legend-94q2l T2 four-eyes: the payout of a recovery refund", () => {
  beforeAll(async () => {
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error("Requires the disposable test database");
    const roleId = async (templateKey: string) =>
      (
        await owner.query<{ id: string }>(
          "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
          [seededTenantId, templateKey],
        )
      ).rows[0]!.id;
    financeRoleId = await roleId("finance");
    const supervisorRoleId = await roleId("supervisor");
    for (const label of [
      "Recovery ORD-09 Approver",
      "Recovery Resolver",
      "Recovery Third Finance",
      "Recovery Fourth Finance",
    ]) {
      const client = agent(app);
      const email = await signUp(client, label);
      const session = await client.get("/api/auth/get-session");
      const userId = session.body.user.id as string;
      await verifySessionMfa(email);
      await owner.query(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
        [seededTenantId, userId, financeRoleId],
      );
      await owner.query(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
        [seededTenantId, userId, supervisorRoleId, seededOutletA],
      );
      userIds.push(userId);
      clients.push(client);
    }
    savedPolicies = (
      await owner.query(
        "SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
        [seededTenantId],
      )
    ).rows;
    await setLevels(1);
  });

  afterAll(async () => {
    setPaymentRefundGateway(null);
    const { rows: refunds } = await owner.query<{ id: string }>(
      "SELECT id FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
    await owner.query(
      "DELETE FROM approval_requests WHERE object_type = 'payment_refund' AND object_id = ANY($1::text[])",
      [refunds.map((r) => r.id)],
    );
    await owner.query(
      "DELETE FROM payment_admin_idempotency WHERE tenant_id = $1 AND key LIKE 'order-recovery-refund:%' AND key = ANY($2::text[])",
      [
        seededTenantId,
        issueIds.flatMap((id) => [
          `order-recovery-refund:${id}`,
          ...refiledKeys.filter((key) =>
            key.startsWith(`order-recovery-refund:${id}:`),
          ),
        ]),
      ],
    );
    await asOwner(
      async (client) => {
        await client.query(
          "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
          [intentIds],
        );
        await client.query(
          "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
          [intentIds],
        );
        await client.query(
          "DELETE FROM order_issues WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
          [seededTenantId, issueIds],
        );
        await client.query(
          "DELETE FROM order_items WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])",
          [seededTenantId, orderUuids],
        );
        await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
          orderUuids,
        ]);
        await client.query(
          "DELETE FROM payment_intents WHERE tenant_id = $1 AND id = ANY($2)",
          [seededTenantId, intentIds],
        );
        await client.query(
          "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2)",
          [seededTenantId, linkIds],
        );
      },
      { replica: true },
    );
    // ORD-09 chains seeded by FE-2b (the issue rows are gone: no FK holds them).
    for (const op of ["level > 1", "level = 1"])
      await owner.query(
        `DELETE FROM approval_requests
         WHERE tenant_id = $1 AND object_type = 'order_issue'
           AND object_id = ANY($2::text[]) AND ${op}`,
        [seededTenantId, issueIds],
      );
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [seededTenantId],
    );
    for (const row of savedPolicies)
      await owner.query(
        `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          row.id,
          row.tenant_id,
          row.action_type,
          row.threshold_idr,
          row.approver_role_id,
          row.levels,
          row.requires_distinct_actor,
        ],
      );
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [seededTenantId, userIds],
    );
  });

  /** One refund policy of `levels` Finance levels for every amount. */
  async function setLevels(levels: number) {
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [seededTenantId],
    );
    for (let level = 1; level <= levels; level += 1)
      await owner.query(
        `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
         VALUES ($1, 'refund', NULL, $2, $3, true)`,
        [seededTenantId, financeRoleId, level],
      );
  }

  describe("approving the payout through the admin route", () => {
    it("FE-1 the person who resolved the issue cannot approve the payout", async () => {
      const { refundId } = await recoveryRefund();
      await expectRefused(refundId, clients[1]!, "APPROVER_IS_REQUESTER");
    });

    it("FE-2 the approver of the ORD-09 approval cannot approve the payout", async () => {
      const { refundId } = await recoveryRefund();
      await expectRefused(refundId, clients[0]!, "APPROVER_IS_REQUESTER");
    });

    it("FE-2b a level-1 decider of a two-level ORD-09 chain cannot approve the payout; a person outside the chain can", async () => {
      const { refundId, issueId } = await recoveryRefund();
      // ORD-09 chain of the issue: level 1 decided by [2], level 2 (the last,
      // = order_issues.approved_by) by [0]. The issue links to the last level.
      const level1 = randomUUID();
      const level2 = randomUUID();
      const insertLevel = (id: string, level: number, decidedBy: string) =>
        owner.query(
          `INSERT INTO approval_requests
             (id, tenant_id, outlet_id, chain_id, source_module, action_type, object_type, object_id,
              requested_by, source, level, required_levels, required_steps, status,
              request_reason, decided_by, decided_at, reason, deadline_at, created_at)
           VALUES ($1, $2, $3, $4, 'order-recovery', 'refund', 'order_issue', $5,
                   $6, 'user', $7, 2, '[]'::jsonb, 'approved',
                   'Refund manual item gagal', $8, now(), 'Sesuai bukti item gagal.',
                   now() + interval '1 day', now())`,
          [
            id,
            seededTenantId,
            seededOutletA,
            level1,
            issueId,
            resolver(),
            level,
            decidedBy,
          ],
        );
      await insertLevel(level1, 1, thirdId());
      await insertLevel(level2, 2, ord09Approver());
      await owner.query(
        "UPDATE order_issues SET approval_request_id = $1 WHERE tenant_id = $2 AND id = $3",
        [level2, seededTenantId, issueId],
      );

      await expectRefused(refundId, thirdPerson(), "APPROVER_IS_REQUESTER");

      const fake = new FakeRefundGateway();
      setPaymentRefundGateway(fake);
      try {
        const ok = await approve(refundId, clients[3]!);
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      } finally {
        setPaymentRefundGateway(null);
      }
      expect(fake.executionCount).toBe(1);
    });

    it("FE-3 a third person with payment.reconcile approves it and the guest is paid once", async () => {
      const { refundId } = await recoveryRefund();
      const fake = new FakeRefundGateway();
      setPaymentRefundGateway(fake);
      try {
        const ok = await approve(refundId, thirdPerson());
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(["approved", "completed"]).toContain(ok.body.data.status);
        // A second approval never pays a second time.
        await approve(refundId, thirdPerson());
      } finally {
        setPaymentRefundGateway(null);
      }
      expect(fake.executionCount).toBe(1);
      expect(fake.calls.every((call) => call.amountIdr === REFUND_AMOUNT)).toBe(
        true,
      );
    });

    it("FE-4 after a party is refused, a third person still approves the same refund", async () => {
      const { refundId } = await recoveryRefund();
      await expectRefused(refundId, clients[1]!, "APPROVER_IS_REQUESTER");

      const fake = new FakeRefundGateway();
      setPaymentRefundGateway(fake);
      try {
        const ok = await approve(refundId, thirdPerson());
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      } finally {
        setPaymentRefundGateway(null);
      }
      expect(fake.executionCount).toBe(1);
    });

    it("FE-5 fail closed: a recovery refund with no readable issue is refused for a third person too", async () => {
      const { refundId } = await recoveryRefund({ withIssue: false });
      await expectRefused(refundId, thirdPerson());
    });

    it("FE-6 fail closed: a recovery refund whose idempotency row is missing is refused for a third person too", async () => {
      const { refundId } = await recoveryRefund({ withKey: false });
      await expectRefused(refundId, thirdPerson());
    });
  });

  describe("deciding through the approvals inbox and the chain settle", () => {
    beforeAll(() => setLevels(2));
    afterAll(() => setLevels(1));

    async function requestsOf(refundId: string) {
      const { rows } = await owner.query<{
        id: string;
        level: number;
        status: string;
      }>(
        `SELECT id, level, status FROM approval_requests
         WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2
         ORDER BY level`,
        [seededTenantId, refundId],
      );
      return rows;
    }

    const decide = (actorId: string, requestId: string) =>
      decideApprovalRequest(
        sessionTenant(),
        actorId,
        requestId,
        { decision: "approved", reason: "Sesuai bukti pengembalian." },
        { mfaVerified: true, idempotencyKey: null },
      );

    /** The one approval.resolved event of the refund's chain, as the worker gets it. */
    async function resolvedEvent(refundId: string) {
      const chainId = (await refundState(refundId)).approval_chain_id;
      expect(chainId).not.toBeNull();
      const { rows } = await owner.query<{ event: unknown }>(
        `SELECT event FROM domain_event_outbox
         WHERE tenant_id = $1 AND destination = 'cloud-sync'
           AND event->>'name' = 'approval.resolved'
           AND event->'payload'->>'chainId' = $2`,
        [seededTenantId, chainId],
      );
      expect(rows).toHaveLength(1);
      return eventEnvelopeSchema.parse(rows[0]!.event);
    }

    async function filedTwoLevel() {
      const seeded = await recoveryRefund();
      const [first] = await requestsOf(seeded.refundId);
      expect(first).toMatchObject({ level: 1, status: "pending" });
      return { ...seeded, firstId: first!.id };
    }

    async function secondLevelId(refundId: string) {
      const second = (await requestsOf(refundId))[1];
      expect(second).toMatchObject({ level: 2, status: "pending" });
      return second!.id;
    }

    it("FE-7 the ORD-09 approver deciding level 1 fails the refund: never paid", async () => {
      const { refundId, firstId } = await filedTwoLevel();
      await decide(ord09Approver(), firstId);
      await decide(thirdId(), await secondLevelId(refundId));

      const fake = new FakeRefundGateway();
      await handleRefundApprovalResolved(
        workerContext(),
        await resolvedEvent(refundId),
      );
      setPaymentRefundGateway(fake);
      try {
        await runRefundPayout(scope(), refundId);
      } finally {
        setPaymentRefundGateway(null);
      }

      expect(await refundState(refundId)).toMatchObject({
        status: "failed",
        failure_reason: "approver_unauthorized",
      });
      expect(fake.executionCount).toBe(0);
    });

    it("FE-8 the resolver deciding the last level fails the refund; redelivery does not throw", async () => {
      const { refundId, firstId } = await filedTwoLevel();
      await decide(thirdId(), firstId);
      await decide(resolver(), await secondLevelId(refundId));
      const event = await resolvedEvent(refundId);

      await expect(
        handleRefundApprovalResolved(workerContext(), event),
      ).resolves.toBeUndefined();
      expect(await refundState(refundId)).toMatchObject({
        status: "failed",
        failure_reason: "approver_unauthorized",
      });
      await expect(
        handleRefundApprovalResolved(workerContext(), event),
      ).resolves.toBeUndefined();
      expect((await refundState(refundId)).status).toBe("failed");
    });

    it("FE-9 a clean chain of two people outside the recovery is paid once", async () => {
      const { refundId, firstId } = await filedTwoLevel();
      await decide(thirdId(), firstId);
      await decide(fourthId(), await secondLevelId(refundId));
      await handleRefundApprovalResolved(
        workerContext(),
        await resolvedEvent(refundId),
      );

      const fake = new FakeRefundGateway();
      setPaymentRefundGateway(fake);
      try {
        await runRefundPayout(scope(), refundId);
        await runRefundPayout(scope(), refundId);
      } finally {
        setPaymentRefundGateway(null);
      }

      expect(["approved", "completed"]).toContain(
        (await refundState(refundId)).status,
      );
      expect(fake.executionCount).toBe(1);
      expect(fake.calls.every((call) => call.amountIdr === REFUND_AMOUNT)).toBe(
        true,
      );
    });
  });
  describe("re-filed refund (after approval_expired)", () => {
    it("FE-6 the resolver and the ORD-09 approver cannot approve the re-filed refund; a third person can", async () => {
      const { refundId, issueId } = await recoveryRefund();
      await owner.query(
        "UPDATE approval_requests SET status = 'expired' WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2",
        [seededTenantId, refundId],
      );
      const failed = await settleRefundFromChain(scope(), refundId);
      expect(failed.status).toBe("failed");
      expect(failed.failureReason).toBe("approval_expired");
      refiledKeys.push(`order-recovery-refund:${issueId}:${refundId}`);

      const { rows } = await owner.query<{ id: string; amount_idr: string }>(
        `SELECT id, amount_idr::text FROM payment_refunds
          WHERE tenant_id = $1 AND order_issue_id = $2 AND status <> 'failed'`,
        [seededTenantId, issueId],
      );
      expect(rows).toHaveLength(1);
      const refiledId = rows[0]!.id;
      expect(refiledId).not.toBe(refundId);
      expect(Number(rows[0]!.amount_idr)).toBe(REFUND_AMOUNT);

      await expectRefused(refiledId, clients[1]!, "APPROVER_IS_REQUESTER");
      await expectRefused(refiledId, clients[0]!, "APPROVER_IS_REQUESTER");

      const fake = new FakeRefundGateway();
      setPaymentRefundGateway(fake);
      try {
        const ok = await approve(refiledId, thirdPerson());
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      } finally {
        setPaymentRefundGateway(null);
      }
      expect(fake.executionCount).toBe(1);
      expect(fake.calls.every((call) => call.amountIdr === REFUND_AMOUNT)).toBe(
        true,
      );
    });
  });
});

// ============================================================================
// Part 2: the qrSales guard of the payout journal
// ============================================================================

const NOW = new Date("2026-11-08T03:00:00Z");
const SWEEP_AT = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
/** 2026-10-15 12:00 in Jakarta; the order fires and the money arrives here. */
const DAY = "2026-10-15T05:00:00.000Z";
/** The recovery refunds (order.refunded) are dated before the payouts. */
const T_RECOVERY = "2026-10-15T08:00:00.000Z";
const REFUND_DAY = "2026-10-16T05:00:00.000Z";
const LATER = "2026-10-16T07:00:00.000Z";

const FLAGS_ON = JSON.stringify({
  modules: ["accounting"],
  integrationProviders: [],
});

type Role =
  | "gateway_clearing"
  | "tax_payable_pbjt"
  | "customer_deposit"
  | "sales_revenue";

const CHART: [Role, string, string, string, string][] = [
  [
    "gateway_clearing",
    "1201",
    "Kliring Payment Gateway",
    "asset",
    "current_asset",
  ],
  ["tax_payable_pbjt", "2104", "Utang PBJT", "liability", "current_liability"],
  [
    "customer_deposit",
    "2107",
    "Uang Muka Pelanggan",
    "liability",
    "current_liability",
  ],
  ["sales_revenue", "4101", "Penjualan", "revenue", "revenue"],
];

type Tenant = { id: string; brandId: string };
type World = {
  tenant: Tenant;
  entity: string;
  outletId: string;
  accounts: Record<Role, string>;
};

const short = () => randomUUID().slice(0, 6);

function contextOf(tenant: Tenant): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.id),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

async function asTenant<T>(
  tenant: Tenant,
  run: (client: PoolClient) => Promise<T>,
  { replica = false }: { replica?: boolean } = {},
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (replica)
      await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
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

async function makeTenant(): Promise<Tenant> {
  const id = randomUUID();
  const brandId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Refund Pemulihan', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `uji-rr-${id.slice(0, 8)}`,
      FLAGS_ON,
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
    [brandId, id],
  );
  return { id, brandId };
}

async function makeWorld(tenant: Tenant): Promise<World> {
  const entity = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenant.id, `Entity RR ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet RR', 'Jl. RR', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      outletId,
      tenant.id,
      tenant.brandId,
      entity,
      `RR-${short()}`.toUpperCase(),
    ],
  );
  const accounts = {} as Record<Role, string>;
  for (const [role, code, name, type, group] of CHART) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenant.id, entity, code, name, type, group],
    );
    accounts[role] = rows[0]!.id;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenant.id, entity, role, accounts[role]],
    );
  }
  for (const period of ["2026-09", "2026-10", "2026-11"])
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenant.id, entity, period],
    );
  return { tenant, entity, outletId, accounts };
}

// ---- seeding ----------------------------------------------------------------

/** A paid 110k gateway intent on its own link, with its evidence. */
async function seedPaidIntent(world: World, amountIdr: number) {
  const linkId = randomUUID();
  const intentId = randomUUID();
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'seed')`,
    [
      linkId,
      world.tenant.id,
      world.outletId,
      randomBytes(32).toString("hex"),
      `RR-${linkId.slice(0, 8)}`,
      amountIdr,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key,
        status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', $7,
             '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [
      intentId,
      world.tenant.id,
      world.outletId,
      linkId,
      amountIdr,
      `rr-${intentId}`,
      DAY,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, $6)`,
    [
      world.tenant.id,
      world.outletId,
      intentId,
      `rr-ref-${intentId}`,
      amountIdr,
      DAY,
    ],
  );
  return { linkId, intentId };
}

/** A fired QR pay-first order of 100k + 10k PBJT (due 110k), pinned to the intent. */
async function seedQrOrder(
  world: World,
  linkId: string,
  intentId: string,
): Promise<{ orderUlid: string; orderUuid: string }> {
  const orderUlid = createUlid();
  const orderUuid = ulidToUuid(orderUlid);
  await asTenant(world.tenant, (client) =>
    client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          prices_include_tax, status, business_date, placed_at, fired_at,
          deposit_applied_idr, payment_link_id, payment_link_token_sealed, payment_intent_id)
       VALUES ($1, $2, $3, $4, 'qr', 'takeaway', 'pay_first', 100000, 0, 0, 10000, 0, 110000,
               false, 'sent', '2026-10-15', now(), $5, 0, $6, 'sealed', $7)`,
      [
        orderUuid,
        world.tenant.id,
        world.outletId,
        `QR-${short()}`,
        DAY,
        linkId,
        intentId,
      ],
    ),
  );
  return { orderUlid, orderUuid };
}

/** A resolved ORD-09 failed-item issue of the order (user and menu FKs skipped). */
async function seedIssue(world: World, orderUuid: string): Promise<string> {
  const itemId = randomUUID();
  const issueId = randomUUID();
  await asTenant(
    world.tenant,
    async (client) => {
      await client.query(
        `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
           quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
           fire_status, status, reserved_business_date)
         VALUES ($1, $2, $3, $4, $5, NULL, 'Roti Bakar', 1, 40000, 0, 40000, '[]'::jsonb,
           'fired', 'served', '2026-10-15')`,
        [itemId, world.tenant.id, world.outletId, orderUuid, randomUUID()],
      );
      await client.query(
        `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
           reason_note, reported_by, resolution, approved_by, cost_idr, status, idempotency_key, resolved_at)
         VALUES ($1, $2, $3, $4, $5, 'unfulfillable', 'out_of_stock', 'Roti habis, refund manual disetujui',
           $6, 'manual_refund', $7, 0, 'resolved', $8, now())`,
        [
          issueId,
          world.tenant.id,
          world.outletId,
          orderUuid,
          itemId,
          randomUUID(),
          randomUUID(),
          `rr-${randomUUID()}`,
        ],
      );
    },
    { replica: true },
  );
  return issueId;
}

/**
 * A completed gateway payout of the intent. With `issueId` it is the refund the
 * recovery filed for that issue (requested_by `system:recovery`); without, a
 * manual admin refund.
 */
async function seedPayout(
  world: World,
  intentId: string,
  amountIdr: number,
  issueId: string | null,
  completedAt: string = REFUND_DAY,
): Promise<string> {
  const refundId = randomUUID();
  await asTenant(world.tenant, (client) =>
    client.query(
      `INSERT INTO payment_refunds
         (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
          requested_by, approved_by, decided_at, completed_at, order_issue_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7, 'approver', $8, $8, $9,
               $8::timestamptz - interval '1 minute')`,
      [
        refundId,
        world.tenant.id,
        world.outletId,
        intentId,
        amountIdr,
        issueId ? "Refund item gagal (ORD-09)" : "Pengembalian dana",
        issueId ? "system:recovery" : "requester",
        completedAt,
        issueId,
      ],
    ),
  );
  return refundId;
}

// ---- events -----------------------------------------------------------------

function envelope(
  world: World,
  input: {
    name: string;
    aggregateType: "payment" | "order";
    aggregateId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  },
): EventEnvelope {
  const id = createUlid();
  return eventEnvelopeSchema.parse({
    id,
    tenantId: world.tenant.id,
    outletId: world.outletId,
    name: input.name,
    version: 1,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    sequence: 1,
    occurredAt: input.occurredAt,
    actor: { type: "system" },
    idempotencyKey: `rr-test-${id}`,
    payloadSchemaRef: `${input.name}.v1`,
    payload: input.payload,
  });
}

function paymentPaid(world: World, intentId: string, receivedIdr: number) {
  return envelope(world, {
    name: "payment.paid",
    aggregateType: "payment",
    aggregateId: intentId,
    occurredAt: DAY,
    payload: {
      intentId,
      method: "qris",
      provider: "doit",
      receivedIdr,
      paidAt: DAY,
      late: false,
    },
  });
}

/** The order.paid a fired QR order emits: 100k + 10k PBJT, all by the gateway. */
function qrOrderPaid(world: World, orderUlid: string) {
  return envelope(world, {
    name: "order.paid",
    aggregateType: "order",
    aggregateId: orderUlid,
    occurredAt: DAY,
    payload: {
      orderId: orderUlid,
      outletId: world.outletId,
      businessDate: "2026-10-15",
      channel: "qr",
      serviceType: "takeaway",
      grossSalesIdr: 100_000,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: 10_000,
      roundingIdr: 0,
      totalIdr: 110_000,
      paidCashIdr: 0,
      paidGatewayIdr: 110_000,
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      paidDepositIdr: 0,
      tenders: [{ method: "qris", amountIdr: 110_000 }],
      shiftId: null,
      cashierId: null,
      deviceId: null,
      paidAt: DAY,
    },
  });
}

function paymentRefunded(
  world: World,
  refundId: string,
  intentId: string,
  amountIdr: number,
  occurredAt: string = REFUND_DAY,
) {
  return envelope(world, {
    name: "payment.refunded",
    aggregateType: "payment",
    aggregateId: refundId,
    occurredAt,
    payload: { refundId, paymentIntentId: intentId, amountIdr },
  });
}

/**
 * The order.refunded the recovery writes for an issue: refundId is the issue id,
 * the whole refund goes back over the gateway. `grossIdr` + `pbjtIdr` is the
 * amount; a `grossIdr` that does not match the line makes the journal park.
 */
function recoveryRefunded(
  world: World,
  orderUlid: string,
  issueId: string,
  split: { grossIdr: number; pbjtIdr: number; lineIdr: number },
) {
  return envelope(world, {
    name: "order.refunded",
    aggregateType: "order",
    aggregateId: orderUlid,
    occurredAt: T_RECOVERY,
    payload: {
      orderId: orderUlid,
      outletId: world.outletId,
      businessDate: "2026-10-15",
      refundId: issueId,
      amountIdr: split.grossIdr + split.pbjtIdr,
      reason: "other",
      reasonNote: "Roti habis, refund manual disetujui",
      approvedBy: randomUUID(),
      overrideId: null,
      approvalRequestId: null,
      grossSalesIdr: split.grossIdr,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: split.pbjtIdr,
      refundCashIdr: 0,
      refundGatewayIdr: split.lineIdr,
      refundEdcIdr: 0,
      refundPointsIdr: 0,
      lines: [{ method: "qris", amountIdr: split.lineIdr }],
      refundedAt: T_RECOVERY,
    },
  });
}

/** An event as a pending outbox row ("emitted but not consumed yet"). */
async function seedOutboxEvent(
  world: World,
  event: EventEnvelope,
  aggregateUuid: string,
): Promise<string> {
  const outboxId = randomUUID();
  await owner.query(
    `INSERT INTO domain_event_outbox
       (tenant_id, id, outlet_id, event_id, aggregate_type, aggregate_id, sequence, event, destination, status)
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7, 'cloud-sync', 'pending')`,
    [
      world.tenant.id,
      outboxId,
      world.outletId,
      randomUUID(),
      event.aggregateType,
      aggregateUuid,
      JSON.stringify(event),
    ],
  );
  return outboxId;
}

async function markDelivered(world: World, outboxId: string): Promise<void> {
  await owner.query(
    "UPDATE domain_event_outbox SET status = 'delivered', delivered_at = now() WHERE tenant_id = $1 AND id = $2",
    [world.tenant.id, outboxId],
  );
}

function deliver(
  tenant: Tenant,
  event: EventEnvelope,
): Promise<AutoJournalResult> {
  const context = contextOf(tenant);
  return withTenant(db, context, (tx) =>
    deliverAutoJournalEvent(context, event, tx, NOW),
  );
}

async function post(world: World, event: EventEnvelope) {
  const result = await deliver(world.tenant, event);
  expect(result.status).toBe("posted");
  return result;
}

async function balanceOf(world: World, role: Role): Promise<number> {
  const { rows } = await owner.query<{ balance: string | null }>(
    `SELECT sum(debit_idr - credit_idr)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [world.tenant.id, world.accounts[role]],
  );
  return Number(rows[0]!.balance ?? 0);
}

async function journalCount(world: World): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1",
    [world.tenant.id],
  );
  return Number(rows[0]!.n);
}

async function parkedOf(tenant: Tenant, idempotencyKey: string) {
  const { rows } = await owner.query<{
    error_code: string;
    retryable: boolean;
  }>(
    "SELECT error_code, retryable FROM auto_journal_parked WHERE tenant_id = $1 AND idempotency_key = $2",
    [tenant.id, idempotencyKey],
  );
  return rows;
}

const AMOUNTS_MISMATCH = {
  status: "parked",
  code: "POSTING_AMOUNTS_MISMATCH",
  retryable: false,
} as const;
const BACKING_PENDING = {
  status: "parked",
  code: "AUTO_JOURNAL_RECEIPT_PENDING",
  retryable: true,
} as const;

/** The recovery refund of 44k = line 40k + PBJT 4k; ok = its journal balances. */
const FORTY_FOUR = { grossIdr: 40_000, pbjtIdr: 4_000, lineIdr: 44_000 };
const TWENTY_TWO = { grossIdr: 20_000, pbjtIdr: 2_000, lineIdr: 22_000 };

describe("legend-94q2l T2 the qrSales guard counts a recovery refund only once its order.refunded journal is posted", () => {
  beforeAll(() => {
    setAuditWriter(coreAuditWriter);
  });
  afterAll(() => {
    setAuditWriter(null);
  });

  /** Receipt 110k and the QR sale of 110k are posted; nothing refunded yet. */
  async function sold(tenant?: Tenant) {
    const world = await makeWorld(tenant ?? (await makeTenant()));
    const { linkId, intentId } = await seedPaidIntent(world, 110_000);
    const { orderUlid, orderUuid } = await seedQrOrder(world, linkId, intentId);
    await post(world, paymentPaid(world, intentId, 110_000));
    await post(world, qrOrderPaid(world, orderUlid));
    return { world, intentId, orderUlid, orderUuid };
  }

  it("RG-1 control: a manual payout of 44k over a fully held sale parks mismatch", async () => {
    const { world, intentId } = await sold();
    const refundId = await seedPayout(world, intentId, 44_000, null);

    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, intentId, 44_000),
      ),
    ).toEqual(AMOUNTS_MISMATCH);
    // receipt + sale only
    expect(await journalCount(world)).toBe(2);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("RG-2 the order.refunded journal of the issue is posted: the 44k payout of that refund posts; customer_deposit nets to 0", async () => {
    const { world, intentId, orderUlid, orderUuid } = await sold();
    const issueId = await seedIssue(world, orderUuid);
    // Production files the payment refund row (order_issue_id = issue) in the
    // same transaction that appends order.refunded, so the row exists before
    // the refund journal is posted; the gateway split reads the intent from it.
    const refundId = await seedPayout(world, intentId, 44_000, issueId);
    await post(world, recoveryRefunded(world, orderUlid, issueId, FORTY_FOUR));

    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, intentId, 44_000),
      ),
    ).toMatchObject({ status: "posted" });
    // receipt + sale + recovery refund + payout
    expect(await journalCount(world)).toBe(4);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("RG-3 the order.refunded journal still waits in the outbox: the payout parks retryable; once it posts the sweep posts the payout", async () => {
    const tenant = await makeTenant();
    const { world, intentId, orderUlid, orderUuid } = await sold(tenant);
    const issueId = await seedIssue(world, orderUuid);
    const refundEvent = recoveryRefunded(world, orderUlid, issueId, FORTY_FOUR);
    const outboxId = await seedOutboxEvent(world, refundEvent, orderUuid);
    const refundId = await seedPayout(world, intentId, 44_000, issueId);
    const payoutKey = `aj:payout:${refundId}`;

    expect(
      await deliver(tenant, paymentRefunded(world, refundId, intentId, 44_000)),
    ).toEqual(BACKING_PENDING);
    expect(await journalCount(world)).toBe(2);
    expect(await parkedOf(tenant, payoutKey)).toEqual([
      expect.objectContaining({ retryable: true }),
    ]);

    await markDelivered(world, outboxId);
    await post(world, refundEvent);
    expect(await retryParkedAutoJournals(contextOf(tenant), SWEEP_AT)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    expect(await parkedOf(tenant, payoutKey)).toHaveLength(0);
    // receipt + sale + recovery refund + payout
    expect(await journalCount(world)).toBe(4);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("RG-4 the order.refunded journal parked non-retryable never frees the sale: the payout parks mismatch and customer_deposit stays at 0", async () => {
    const { world, intentId, orderUlid, orderUuid } = await sold();
    const issueId = await seedIssue(world, orderUuid);
    // Gross 45k + PBJT 4k does not match the 44k line: the journal parks for good.
    expect(
      await deliver(
        world.tenant,
        recoveryRefunded(world, orderUlid, issueId, {
          grossIdr: 45_000,
          pbjtIdr: 4_000,
          lineIdr: 44_000,
        }),
      ),
    ).toMatchObject({ status: "parked", retryable: false });
    const refundId = await seedPayout(world, intentId, 44_000, issueId);

    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, intentId, 44_000),
      ),
    ).toEqual(AMOUNTS_MISMATCH);
    // receipt + sale only
    expect(await journalCount(world)).toBe(2);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("RG-5 two issues on one order: the payout of the posted one posts, the payout of the one still in the outbox parks retryable", async () => {
    const tenant = await makeTenant();
    const { world, intentId, orderUlid, orderUuid } = await sold(tenant);
    const postedIssue = await seedIssue(world, orderUuid);
    const waitingIssue = await seedIssue(world, orderUuid);
    await post(
      world,
      recoveryRefunded(world, orderUlid, postedIssue, FORTY_FOUR),
    );
    await seedOutboxEvent(
      world,
      recoveryRefunded(world, orderUlid, waitingIssue, TWENTY_TWO),
      orderUuid,
    );
    const postedRefund = await seedPayout(world, intentId, 44_000, postedIssue);
    const waitingRefund = await seedPayout(
      world,
      intentId,
      22_000,
      waitingIssue,
      LATER,
    );

    expect(
      await deliver(
        tenant,
        paymentRefunded(world, postedRefund, intentId, 44_000),
      ),
    ).toMatchObject({ status: "posted" });
    expect(
      await deliver(
        tenant,
        paymentRefunded(world, waitingRefund, intentId, 22_000, LATER),
      ),
    ).toEqual(BACKING_PENDING);
    // receipt + sale + one recovery refund + one payout
    expect(await journalCount(world)).toBe(4);
  });
  // R4: `releasedOf` is bounded in time like `posRefundsAt(bound)`: a recovery
  // refund completed after the payout under judgement does not free the sale.
  it("RG-6 a recovery refund completed AFTER the payout does not reduce the hold: the earlier manual payout parks mismatch", async () => {
    const { world, intentId, orderUlid, orderUuid } = await sold();
    const issueId = await seedIssue(world, orderUuid);
    await post(world, recoveryRefunded(world, orderUlid, issueId, TWENTY_TWO));
    // The recovery refund pays out later (LATER) than the manual one (REFUND_DAY).
    await seedPayout(world, intentId, 22_000, issueId, LATER);
    const manual = await seedPayout(world, intentId, 22_000, null, REFUND_DAY);

    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, manual, intentId, 22_000),
      ),
    ).toEqual(AMOUNTS_MISMATCH);
    // receipt + sale + the recovery refund's own journal; the payout parked
    expect(await journalCount(world)).toBe(3);
  });

  it("RG-7 control: a recovery refund filed BEFORE the payout does reduce the hold: the manual payout posts", async () => {
    const { world, intentId, orderUlid, orderUuid } = await sold();
    const issueId = await seedIssue(world, orderUuid);
    await post(world, recoveryRefunded(world, orderUlid, issueId, TWENTY_TWO));
    // Filed before the manual payout and still waiting (its own payout is not
    // among the completed ones, so it does not use up the room it released).
    const recoveryRefund = await seedPayout(
      world,
      intentId,
      22_000,
      issueId,
      T_RECOVERY,
    );
    await owner.query(
      `UPDATE payment_refunds
          SET status = 'pending', completed_at = NULL, decided_at = NULL, approved_by = NULL
        WHERE tenant_id = $1 AND id = $2`,
      [world.tenant.id, recoveryRefund],
    );
    const manual = await seedPayout(world, intentId, 22_000, null, REFUND_DAY);

    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, manual, intentId, 22_000),
      ),
    ).toMatchObject({ status: "posted" });
    expect(await journalCount(world)).toBe(4);
  });
});
