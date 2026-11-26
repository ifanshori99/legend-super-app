// 1269 E4 (legend-osqou.25): the EDC ledger an outlet runs on its edge is
// mirrored in the cloud's `edc_transactions` through the real link receive
// path. Money rule: one edge charge is one cloud row, whatever the replays or
// the order; what the charge is (amount, bill, terminal) never changes; one
// slip is one charge across the tenant; no card number is ever stored.
//
// Assumptions (also reported):
//  - the edge emits the full row state after each change (edge/edc/events.ts);
//    events are built here in that shape.
//  - random order is exercised by calling the ingest directly: the link
//    itself only applies the next aggregate sequence (conflict.ts).
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { edcTransactionEventPayloadSchema } from "@starter/shared/edc/events";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import {
  registerEdgeDeferredFallback,
  registerPosDeferredEdgeApplier,
} from "../edge/deferred-event-applier.ts";
import {
  ingestEdgeEdcEvent,
  registerEdcLedgerEdgeApplier,
} from "../edge/edc-ledger-applier.ts";
import type { EdgeApplyMeta } from "../edge/ports.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const actor = randomUUID();
const tenantId = randomUUID();
const outletA = randomUUID();
const brandId = randomUUID();
const bcaTerminal = randomUUID();
const mandiriTerminal = randomUUID();
const PAN = "4111111111111111";
let node: AuthenticatedEdgeNode;

const scopeOf = (outletIds: string[]): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    {
      kind: "outlets",
      outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
    },
  );

async function q<T extends object>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await client.query<T>(text, params);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function n(text: string, params: unknown[] = []): Promise<number> {
  const rows = await q<{ n: number }>(text, params);
  return Number(rows[0]!.n);
}

async function createFixture() {
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant EDC Edge', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tenantId,
      `edc-edge-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brandId, tenantId, `edc-edge-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'EDE-01', 'EDE-01', 'Jl. Uji', '{}', 'active')`,
    [outletA, tenantId, brandId, entity],
  );
  for (const [id, bank, tid] of [
    [bcaTerminal, "bca", "TID-EB"],
    [mandiriTerminal, "mandiri", "TID-EM"],
  ] as const)
    await q(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, $4, $5, $5, 'Test EDC', 'lan', '10.0.0.8',
               ARRAY['card','qris'], 'active')`,
      [id, tenantId, outletA, bank, tid],
    );
}

let clock = Date.parse("2026-11-26T09:00:00.000Z");
type Payload = Record<string, unknown>;

function envelope(
  name: string,
  aggregateId: string,
  sequence: number,
  payload: Payload,
): EventEnvelope {
  clock += 1_000;
  return {
    id: createUlid(clock),
    tenantId: tenantId as EventEnvelope["tenantId"],
    outletId: outletA as EventEnvelope["outletId"],
    name,
    version: 1,
    aggregateType: "edc_transaction",
    aggregateId,
    sequence,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${name}:${aggregateId}:${sequence}`,
    payloadSchemaRef: `${name}.v1`,
    payload: payload as EventEnvelope["payload"],
  } as EventEnvelope;
}

type Spec = {
  terminalId?: string;
  bank?: string;
  amountIdr?: number;
  mode?: "ecr" | "standalone";
  rrn?: string | null;
};

let referenceSeq = 0;
/** One edge charge: its payload at each status, as the edge emits it. */
function charge(spec: Spec = {}) {
  const id = randomUUID();
  referenceSeq += 1;
  const base: Payload = {
    transactionId: id,
    tenantId,
    outletId: outletA,
    terminalId: spec.terminalId ?? bcaTerminal,
    bank: spec.bank ?? "bca",
    reference: `P261126-${String(referenceSeq).padStart(4, "0")}`,
    amountIdr: spec.amountIdr ?? 75000,
    status: "pending",
    trace: `T${randomBytes(4).toString("hex").toUpperCase()}`,
    approvalCode: null,
    maskedPan: null,
    needsReconciliation: false,
    method: "card",
    type: "sale",
    mode: spec.mode ?? "ecr",
    rrn: null,
    completedAt: null,
  };
  const rrn =
    spec.rrn === undefined ? `RRN${randomBytes(4).toString("hex")}` : spec.rrn;
  const done = (status: string, extra: Payload = {}): Payload => ({
    ...base,
    status,
    completedAt: new Date(clock + 500).toISOString(),
    ...extra,
  });
  return {
    id,
    base,
    created: (extra: Payload = {}) =>
      envelope("edc_transaction.created", id, 1, { ...base, ...extra }),
    approved: (sequence = 2, extra: Payload = {}) =>
      envelope(
        "edc_transaction.approved",
        id,
        sequence,
        done("approved", {
          approvalCode: "A12345",
          maskedPan: "411111******1111",
          rrn,
          ...extra,
        }),
      ),
    declined: (sequence = 2, extra: Payload = {}) =>
      envelope(
        "edc_transaction.declined",
        id,
        sequence,
        done("declined", extra),
      ),
    flagged: (sequence: number, extra: Payload = {}) =>
      envelope(
        "edc_transaction.flagged",
        id,
        sequence,
        done("approved", {
          approvalCode: "A12345",
          maskedPan: "411111******1111",
          rrn,
          needsReconciliation: true,
          ...extra,
        }),
      ),
  };
}

function store() {
  return createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "cloud_to_edge",
  });
}

async function deliver(events: EventEnvelope[]) {
  const link = store();
  const from = await link.lastReceivedInbound();
  await link.applyInbound({
    fromSeq: from,
    toSeq: from + events.length,
    events: events.map((event, index) => ({
      linkSeq: from + index + 1,
      event,
    })),
  });
}

/** The same events again, as if the link replayed them from scratch. */
async function redeliver(events: EventEnvelope[]) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    for (const table of [
      "edge_link_slots",
      "edge_inbound_events",
      "edge_received_events",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND event_id = ANY($2::uuid[])`,
        [tenantId, events.map((event) => ulidToUuid(event.id))],
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await deliver(events);
}

/** The ingest alone, in its own transaction (any order, no link rule). */
async function ingestDirect(event: EventEnvelope) {
  const meta: EdgeApplyMeta = {
    edgeNodeId: node.scope.edgeNodeId,
    direction: "edge_to_cloud",
    kind: "transaction_event",
    context: node.context,
  };
  return withTenant(db, node.context, (tx) =>
    ingestEdgeEdcEvent(tx as EdgeTx, event, meta),
  );
}

type EdcRow = {
  status: string;
  amount_idr: string;
  rrn: string | null;
  approval_code: string | null;
  masked_pan: string | null;
  needs_reconciliation: boolean;
  mode: string;
  terminal_id: string;
  idempotency_key: string;
};

async function rowsOf(id: string): Promise<EdcRow[]> {
  return q<EdcRow>(
    `SELECT status, amount_idr::text, rrn, approval_code, masked_pan, needs_reconciliation,
            mode, terminal_id, idempotency_key
       FROM edc_transactions WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
}

async function ledger(id: string) {
  const [row] = await q<{
    state: string;
    reason: string | null;
    sequence: number;
  }>(
    `SELECT state, reason, sequence FROM edge_edc_ingests
      WHERE tenant_id = $1 AND transaction_id = $2`,
    [tenantId, id],
  );
  return row;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await createFixture();
  const registered = await registerEdgeNode(scopeOf([outletA]), actor, {
    outletId: outletA,
    role: "primary",
    label: "Utama EDC Edge",
  });
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  node = authenticated;
});

beforeEach(() => {
  resetEdgeApplierRegistryForTests();
  registerPosDeferredEdgeApplier();
  registerEdcLedgerEdgeApplier();
  registerEdgeDeferredFallback();
});

afterAll(async () => {
  resetEdgeApplierRegistryForTests();
  setAuditWriter(null);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    for (const table of [
      "edge_edc_ingests",
      "edc_transactions",
      "payment_edc_terminals",
      "edge_deferred_events",
      "domain_event_outbox",
      "notification_outbox",
      "edge_link_slots",
      "edge_inbound_events",
      "edge_received_events",
      "edge_sync_conflicts",
      "edge_outbound_queue",
      "sync_cursors",
      "edge_nodes",
      "audit_logs",
      "outlets",
      "legal_entities",
      "brands",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        tenantId,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
});

describe("1269 E4 edge EDC ledger mirrored in the cloud", () => {
  it("mirrors an approved edge charge once, through the link, with nothing on the outbox", async () => {
    const c = charge();
    await deliver([c.created(), c.approved()]);
    const rows = await rowsOf(c.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "approved",
      amount_idr: "75000",
      approval_code: "A12345",
      masked_pan: "411111******1111",
      needs_reconciliation: false,
      mode: "ecr",
      terminal_id: bcaTerminal,
      idempotency_key: `edge:${c.id}`,
    });
    expect(rows[0]!.rrn).toMatch(/^RRN/);
    expect(await ledger(c.id)).toEqual({
      state: "ingested",
      reason: null,
      sequence: 2,
    });
    // Parked as deferred, never as unclassified (no alarm per event).
    expect(
      await n(
        `SELECT count(*)::int AS n FROM edge_deferred_events
          WHERE tenant_id = $1 AND aggregate_id = $2 AND parked_reason = 'deferred'`,
        [tenantId, c.id],
      ),
    ).toBe(2);
    expect(
      await n(
        `SELECT count(*)::int AS n FROM domain_event_outbox
          WHERE tenant_id = $1 AND aggregate_id = $2`,
        [tenantId, c.id],
      ),
    ).toBe(0);
  });

  it("a replay twice through the link changes nothing", async () => {
    const c = charge();
    const events = [c.created(), c.approved(), c.flagged(3)];
    await deliver(events);
    const before = await q<{ updated_at: string }>(
      "SELECT updated_at::text FROM edc_transactions WHERE tenant_id = $1 AND id = $2",
      [tenantId, c.id],
    );
    await redeliver(events);
    await redeliver(events);
    expect(await rowsOf(c.id)).toHaveLength(1);
    expect(
      await q<{ updated_at: string }>(
        "SELECT updated_at::text FROM edc_transactions WHERE tenant_id = $1 AND id = $2",
        [tenantId, c.id],
      ),
    ).toEqual(before);
    expect((await rowsOf(c.id))[0]!.needs_reconciliation).toBe(true);
    expect(await ledger(c.id)).toMatchObject({
      state: "ingested",
      sequence: 3,
    });
  });

  it("in any arrival order the result is one row in the newest state", async () => {
    const orders = [
      [0, 1, 2],
      [2, 1, 0],
      [1, 0, 2],
      [2, 0, 1],
      [0, 2, 1],
      [1, 2, 0],
    ];
    for (const order of orders) {
      const c = charge();
      const events = [c.created(), c.approved(), c.flagged(3)];
      for (const index of order) await ingestDirect(events[index]!);
      // And everything once more, shuffled again.
      for (const index of [...order].reverse())
        await ingestDirect(events[index]!);
      const rows = await rowsOf(c.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "approved",
        needs_reconciliation: true,
        amount_idr: "75000",
      });
      expect(await ledger(c.id)).toMatchObject({
        state: "ingested",
        sequence: 3,
      });
    }
  });

  it("refuses a changed amount (nominal locked) and stays refused", async () => {
    const c = charge();
    await deliver([c.created()]);
    await deliver([c.approved(2, { amountIdr: 70000 })]);
    expect(await rowsOf(c.id)).toEqual([
      expect.objectContaining({ status: "pending", amount_idr: "75000" }),
    ]);
    expect(await ledger(c.id)).toMatchObject({
      state: "refused",
      reason: "charge_changed",
    });
    // A later, consistent event never revives it: finance decides.
    await deliver([c.flagged(3)]);
    expect((await rowsOf(c.id))[0]!.status).toBe("pending");
    expect(await ledger(c.id)).toMatchObject({
      state: "refused",
      reason: "charge_changed",
    });
  });

  it("refuses a slip another charge of the tenant holds, across banks", async () => {
    const first = charge({ mode: "standalone", rrn: "RRN-778899" });
    await deliver([first.created(), first.approved()]);
    expect((await rowsOf(first.id))[0]!.status).toBe("approved");
    const second = charge({
      mode: "standalone",
      rrn: "rrn778899",
      terminalId: mandiriTerminal,
      bank: "mandiri",
    });
    await deliver([second.created(), second.approved()]);
    // Pending (no slip yet) is mirrored; the approval with the used slip is not.
    expect((await rowsOf(second.id))[0]!.status).toBe("pending");
    expect(await ledger(second.id)).toMatchObject({
      state: "refused",
      reason: "slip_used",
    });
    expect(
      await n(
        `SELECT count(*)::int AS n FROM edc_transactions
          WHERE tenant_id = $1 AND upper(replace(rrn, '-', '')) = 'RRN778899'`,
        [tenantId],
      ),
    ).toBe(1);
  });

  it("refuses a second approved charge for one bill", async () => {
    const first = charge();
    await deliver([first.created(), first.approved()]);
    const second = charge();
    const sameBill = {
      reference: first.base.reference,
    };
    await deliver([second.created(sameBill), second.approved(2, sameBill)]);
    expect((await rowsOf(second.id))[0]!.status).toBe("pending");
    expect(await ledger(second.id)).toMatchObject({
      state: "refused",
      reason: "reference_approved_twice",
    });
  });

  it("never turns a decline into an approval (late approval)", async () => {
    const c = charge();
    await deliver([c.created(), c.declined()]);
    await deliver([c.approved(3)]);
    expect((await rowsOf(c.id))[0]!.status).toBe("declined");
    expect(await ledger(c.id)).toMatchObject({
      state: "refused",
      reason: "late_approval",
    });
  });

  it("follows the edge resolve of a flagged approval into a decline", async () => {
    const c = charge();
    await deliver([c.created(), c.flagged(2), c.declined(3)]);
    expect((await rowsOf(c.id))[0]).toMatchObject({
      status: "declined",
      needs_reconciliation: false,
    });
    expect(await ledger(c.id)).toMatchObject({ state: "ingested" });
  });

  it("never overwrites a row the cloud changed itself", async () => {
    const c = charge();
    await deliver([c.created(), c.flagged(2)]);
    await q(
      `UPDATE edc_transactions SET needs_reconciliation = false
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, c.id],
    );
    await deliver([c.declined(3)]);
    expect((await rowsOf(c.id))[0]!.status).toBe("approved");
    expect(await ledger(c.id)).toMatchObject({
      state: "refused",
      reason: "cloud_changed",
    });
  });

  it("stores no card number anywhere, and books nothing for it", async () => {
    const c = charge({ rrn: PAN });
    await deliver([c.created(), c.approved()]);
    // The approval carried the card number: refused, never mirrored.
    expect((await rowsOf(c.id))[0]!.status).toBe("pending");
    expect(await ledger(c.id)).toMatchObject({
      state: "refused",
      reason: "card_number",
    });
    for (const [table, column] of [
      ["edge_deferred_events", "envelope"],
      ["edge_sync_conflicts", "event"],
      ["edc_transactions", "rrn"],
      ["edge_edc_ingests", "reason"],
    ] as const)
      expect(
        await n(
          `SELECT count(*)::int AS n FROM ${table}
            WHERE tenant_id = $1 AND ${column}::text LIKE '%' || $2 || '%'`,
          [tenantId, PAN],
        ),
        table,
      ).toBe(0);
    // A split form in another field is caught too.
    const split = charge();
    await deliver([split.created({ approvalCode: "4111 1111 1111 1111" })]);
    expect(await rowsOf(split.id)).toHaveLength(0);
    expect(await ledger(split.id)).toMatchObject({ reason: "card_number" });
    expect(
      await n(
        `SELECT count(*)::int AS n FROM edge_deferred_events
          WHERE tenant_id = $1 AND envelope::text LIKE '%4111 1111%'`,
        [tenantId],
      ),
    ).toBe(0);
  });

  it("refuses an event written before E4 (no mirror fields)", async () => {
    const c = charge();
    const legacy = { ...c.base } as Payload;
    for (const key of ["method", "type", "mode", "rrn", "completedAt"])
      delete legacy[key];
    await deliver([envelope("edc_transaction.created", c.id, 1, legacy)]);
    expect(await rowsOf(c.id)).toHaveLength(0);
    expect(await ledger(c.id)).toMatchObject({
      state: "refused",
      reason: "legacy_payload",
    });
  });

  it("refuses a terminal of another bank than the event says", async () => {
    const c = charge({ terminalId: mandiriTerminal, bank: "bca" });
    await deliver([c.created()]);
    expect(await rowsOf(c.id)).toHaveLength(0);
    expect(await ledger(c.id)).toMatchObject({
      state: "refused",
      reason: "terminal_mismatch",
    });
  });

  it("the payload contract admits no card-number-like RRN", () => {
    const c = charge();
    const ok = { ...c.base, rrn: "RRN-123456" };
    expect(edcTransactionEventPayloadSchema.safeParse(ok).success).toBe(true);
    for (const rrn of [PAN, "4111-1111-1111-1111"])
      expect(
        edcTransactionEventPayloadSchema.safeParse({ ...ok, rrn }).success,
      ).toBe(false);
  });
});
