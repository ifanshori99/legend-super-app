// Write-off of a receipt number on a run that belongs to an edge (bead
// legend-drzaf; builds on legend-0hzqw write-off, legend-yd0h8 edge high-water
// and legend-jcby0 write-off pull to the edge).
//
// Problem: a run bound to an edge (`edge_node_id` set by the cloud claim) keeps
// `last_number` = 0 on the cloud for ever (the edge numbers it; legend-ol6v is
// not built). The cloud only knows the highest number the edge reported
// (`receipt_sequences.edge_reported_number`, the high-water of `receiptRuns`).
// The write-off service and the 0156 trigger compared with `last_number` only,
// so every number of an edge run was refused and never reached the edge.
//
// Contract (docs/briefs/sub-writeoff-edge-runs.md): the limit is
// GREATEST(last_number, edge_reported_number). A number above it is refused
// (CONFLICT "Nomor struk di luar rentang yang sudah terbit."); a number with a
// receipt on the cloud or one already written off stays refused.
//
// Assumptions:
//  - The real `writeOffReceiptNumber` is called (not SQL), with the user id of
//    a signed-up member as the owner; the HTTP route (owner template, MFA) is
//    covered by pos-receipt-writeoff.test.ts. "201" = the service returns the
//    write-off object (id, prefix, sequenceNumber, number).
//  - Same simulation as pos-receipt-restore-detect.test.ts (helpers copied, not
//    edited): the cloud and every "edge database" share one PostgreSQL
//    database, an edge database is an edge OUTLET, and a cloud page is shipped
//    to the edge outlet by rewriting ids and outlet. The edge numbers through
//    the real `allocateReceipt` in edge mode and reports through the real pull.
//  - The cloud `last_number` of the bound run is never touched by SQL: the
//    high-water only comes from the edge pull (`edge_reported_number`),
//    asserted as a precondition in every case.
//  - A number with a cloud receipt on an edge-BOUND run cannot exist: the
//    claim retires a run that has receipts and binds the next prefix, and the
//    receipt trigger refuses a receipt above the cloud `last_number`. Case 2
//    therefore checks the receipt refusal on the retired cloud run (P1, last
//    2, edge high-water 0: not widened either) next to the bound run (P2).
//  - Case 4 loses number 3 on the edge by consuming it without a receipt
//    (owner SQL raises the edge run's local `last_number`, like a printer
//    crash after the number was taken); a receipt cannot be deleted
//    (append-only). The edge gap port then lists 3 as missing.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/pos-receipt-writeoff-edge-run.test.ts" pnpm test

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  encodeReceiptRunReport,
  type DeviceReceiptSequenceBinding,
  type DeviceSyncPage,
  type ReceiptRunReport,
} from "@starter/shared/edge";
import { formatReceiptNumber, type PosReceipt } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { enrollDevice } from "../services/device.service.ts";
import {
  deviceSyncQuerySchema,
  listDeviceRecordsSince,
  pullDeviceRegistry,
} from "../services/edge-device-sync.ts";
import { setPosReceiptPort } from "../services/pos-order-ports.ts";
import {
  allocateReceipt,
  createPosReceiptPort,
  receiptGapsForOutletFast,
} from "../services/pos-receipt.service.ts";
import { writeOffReceiptNumber } from "../services/pos-receipt-writeoff.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;
const REASON = "Struk hilang bersama printer yang rusak";
const OUT_OF_RANGE = "Nomor struk di luar rentang yang sudah terbit.";

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  cashierRole: randomUUID(),
};

let tenant: IsolatedTenant;
let headers: { Host: string };
let cashier: { client: ReturnType<typeof agent>; userId: string };
const actor = randomUUID();
const cloudState = getEdgeRuntimeState();

// ---- Fixtures (copied from pos-receipt-restore-detect.test.ts) --------------

async function asOwnerTenant<T>(
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

function tenantContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

const scoped = (
  source: "session" | "device",
  outletId: string,
): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source,
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );
const cloudScope = (outletId: string) => scoped("session", outletId);
const edgeScope = (outletId: string) => scoped("device", outletId);

/** An outlet with its own price list: first receipt there is always #1. */
async function freshOutlet(): Promise<string> {
  const outletId = randomUUID();
  const priceListId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Cafe Uji', 'Jl. Uji 1', 'Asia/Jakarta', $6, 'active')`,
    [
      outletId,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `W${outletId.slice(0, 8)}`.toUpperCase(),
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [priceListId, tenant.tenantId, outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, priceListId, ids.kopi, KOPI_IDR],
    );
  });
  return outletId;
}

async function draftOrder(outletId: string): Promise<string> {
  const created = await cashier.client
    .post(`/api/outlets/${encodeURIComponent(outletId)}/pos/orders`)
    .set(headers)
    .set(originHeader)
    .send({
      idempotencyKey: randomUUID(),
      channel: "pos",
      serviceType: "takeaway",
      items: [{ menuItemId: ids.kopi, quantity: 1, modifierIds: [] }],
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}

type ServiceTx = Parameters<typeof allocateReceipt>[0];

function inTx<T>(
  run: (tx: ServiceTx, context: ScopedTenantContext) => Promise<T>,
  context = tenantContext(tenant.tenantId),
): Promise<T> {
  return withTenant(db, context, (tx) => run(tx as ServiceTx, context));
}

function allocate(
  outletId: string,
  orderId: string,
  deviceId: string,
): Promise<PosReceipt> {
  return inTx((tx, context) =>
    allocateReceipt(tx, context, {
      orderId,
      outletId,
      deviceId,
      at: new Date(),
    }),
  );
}

/** Runs `run` with edge mode on and always restores the previous state. */
async function inEdgeMode<T>(run: () => Promise<T>): Promise<T> {
  const previous = getEdgeRuntimeState();
  setEdgeRuntimeStateForTests({ ...previous, edgeMode: true });
  try {
    return await run();
  } finally {
    setEdgeRuntimeStateForTests(previous);
  }
}

type Binding = DeviceReceiptSequenceBinding;

async function enrollPos(outletId: string): Promise<string> {
  const { device } = await enrollDevice(cloudScope(outletId), actor, {
    outletId,
    type: "pos",
    label: `Perangkat ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  return device.id;
}

// ---- Setup ------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const app = createApp();
  setAuditWriter(coreAuditWriter);
  setPosReceiptPort(createPosReceiptPort());
  tenant = await createIsolatedTenant(`rwe-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Kasir Write-off Edge', false, NULL, $3, false, '["tenant","outlet"]')`,
    [
      ids.cashierRole,
      tenant.tenantId,
      JSON.stringify(["order.view", "pos.sale.create"]),
    ],
  );
  const client = agent(app);
  await signUp(client, "Kasir Write-off Edge");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, ids.cashierRole],
  );
  cashier = { client, userId };
  await asOwnerTenant(tenant.tenantId, async (c) => {
    await c.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Write-off Edge Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await c.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await c.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
    await c.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-RWE', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
  });
}, 120_000);

afterEach(() => {
  setEdgeRuntimeStateForTests(cloudState);
  vi.restoreAllMocks();
});

afterAll(async () => {
  setEdgeRuntimeStateForTests(cloudState);
  setAuditWriter(null);
  setPosReceiptPort(null);
  // Final orders and receipts are append-only: the tenant stays in the
  // disposable database with a valid creator.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ---- Run rows ---------------------------------------------------------------

type RunRow = {
  id: string;
  prefix: string;
  last_number: number;
  device_id: string;
  edge_node_id: string | null;
  edge_instance_id: string | null;
  edge_reported_number: number;
  retired_at: Date | null;
};

/** The run `prefix` of an outlet, with the binding and high-water columns. */
async function runOf(outletId: string, prefix = "P1"): Promise<RunRow> {
  const { rows } = await owner.query<RunRow>(
    `SELECT id, prefix, last_number, device_id, edge_node_id, edge_instance_id,
            edge_reported_number, retired_at
       FROM receipt_sequences
      WHERE tenant_id = $1 AND outlet_id = $2 AND prefix = $3`,
    [tenant.tenantId, outletId, prefix],
  );
  if (!rows[0]) throw new Error(`No run ${prefix} on outlet ${outletId}`);
  return rows[0];
}

type StoredWriteoff = {
  id: string;
  sequence_id: string;
  prefix: string;
  sequence_number: number;
};

async function writeoffRows(outletId: string): Promise<StoredWriteoff[]> {
  const { rows } = await owner.query<StoredWriteoff>(
    `SELECT id, sequence_id, prefix, sequence_number
       FROM receipt_number_writeoffs
      WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY prefix, sequence_number`,
    [tenant.tenantId, outletId],
  );
  return rows;
}

/** The real write-off service, as the route calls it (owner = a real user). */
function writeOff(outletId: string, sequenceNumber: number, prefix = "P1") {
  return writeOffReceiptNumber(
    tenantContext(tenant.tenantId),
    { userId: userIdSchema.parse(cashier.userId) },
    outletIdSchema.parse(outletId),
    { prefix, sequenceNumber, reason: REASON } as never,
  );
}

// ---- Simulated cloud + edge (copied from pos-receipt-restore-detect) ---------

async function insertNode(outletId: string): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash)
       VALUES ($1, $2, $3, 'primary', 'active', 'Server lokal', $4)`,
      [id, tenant.tenantId, outletId, "a".repeat(64)],
    ),
  );
  return id;
}

/** Stable edge-side id per (edge outlet, cloud id); see `shipTo`. */
const shippedIds = new Map<string, string>();

/**
 * What an edge database applies: the cloud page with each sequence and
 * write-off moved to the edge's own outlet and given another (stable) id.
 * Device records stay behind. A write-off keeps pointing at its run: the id
 * of the run on the edge is the one `shipTo` gave the sequence.
 */
function shipTo(page: DeviceSyncPage, edgeOutletId: string): unknown {
  const edgeIdOf = (cloudId: string): string => {
    const key = `${edgeOutletId}:${cloudId}`;
    const known = shippedIds.get(key);
    if (known !== undefined) return known;
    const id = randomUUID();
    shippedIds.set(key, id);
    return id;
  };
  const raw = page as DeviceSyncPage & {
    receiptWriteoffs?: Array<Record<string, unknown> & { id: string }>;
  };
  const { receiptWriteoffs, ...rest } = raw;
  return {
    ...rest,
    data: [],
    receiptSequences: (page.receiptSequences ?? []).map((s) => ({
      ...s,
      id: edgeIdOf(s.id),
      outletId: edgeOutletId,
    })),
    ...(receiptWriteoffs
      ? {
          receiptWriteoffs: receiptWriteoffs.map((w) => ({
            ...w,
            id: edgeIdOf(w.id),
            sequenceId: edgeIdOf(w.sequenceId as string),
            outletId: edgeOutletId,
          })),
        }
      : {}),
  };
}

async function localEdgeNode(
  edgeOutletId: string,
  own: Binding,
): Promise<void> {
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash, instance_id)
       VALUES ($1, $2, $3, 'primary', 'active', 'Server lokal', $4, $5)
       ON CONFLICT (id) DO UPDATE SET instance_id = EXCLUDED.instance_id`,
      [
        own.edgeNodeId,
        tenant.tenantId,
        edgeOutletId,
        "b".repeat(64),
        own.edgeInstanceId,
      ],
    ),
  );
}

let lastCloudNow = 0;
/** Strictly increasing cloud arrival time, 10 min ahead of the real clock. */
function nextCloudNow(): Date {
  lastCloudNow = Math.max(Date.now() + 10 * 60_000, lastCloudNow + 1);
  return new Date(lastCloudNow);
}

/** The cloud answering one device-records pull of node N, instance I. */
function cloudPull(
  cloudOutletId: string,
  own: Binding,
  options: {
    report?: ReceiptRunReport;
    since?: string | null;
    withWriteoffs?: boolean;
  } = {},
): Promise<DeviceSyncPage> {
  const query = deviceSyncQuerySchema.parse({
    limit: 100,
    receiptSequences: "1",
    ...(options.withWriteoffs ? { receiptWriteoffs: "1" } : {}),
    edgeInstance: own.edgeInstanceId,
    ...(options.since ? { since: options.since } : {}),
    ...(options.report
      ? { receiptRuns: encodeReceiptRunReport(options.report) }
      : {}),
  });
  return listDeviceRecordsSince(
    {
      tenantId: tenant.tenantId as TenantId,
      outletId: outletIdSchema.parse(cloudOutletId),
      edgeNodeId: own.edgeNodeId,
    },
    query,
    { now: nextCloudNow(), settleMs: 0 },
  );
}

/**
 * The edge database `edgeOutletId` pulls from the cloud outlet through
 * `pullDeviceRegistry` (it computes and sends its own `receiptRuns`).
 */
async function edgePull(
  edgeOutletId: string,
  cloudOutletId: string,
  own: Binding,
  withWriteoffs = false,
) {
  await localEdgeNode(edgeOutletId, own);
  return inEdgeMode(() =>
    pullDeviceRegistry({
      context: edgeScope(edgeOutletId),
      role: "primary",
      binding: own,
      fetchPage: async (
        since: string | null,
        receiptRuns?: ReceiptRunReport,
      ) => {
        // The cloud answers in cloud mode, whatever the calling edge's mode.
        const edgeState = getEdgeRuntimeState();
        setEdgeRuntimeStateForTests(cloudState);
        try {
          const page = await cloudPull(cloudOutletId, own, {
            since,
            withWriteoffs,
            report: receiptRuns,
          });
          return shipTo(page, edgeOutletId);
        } finally {
          setEdgeRuntimeStateForTests(edgeState);
        }
      },
    }),
  );
}

async function edgeSell(outletId: string, deviceId: string): Promise<string> {
  const orderId = await draftOrder(outletId);
  const receipt = await inEdgeMode(() => allocate(outletId, orderId, deviceId));
  return receipt.number;
}

/**
 * A cloud outlet with one pos device and a primary node, an edge database
 * (outlet) bound to a run through the first pull, `sold` receipts printed on
 * the edge and one more pull that reports them: the cloud run is bound to the
 * edge, its `last_number` is 0 and its high-water is `sold`. The run is P1.
 * With `cloudSold` > 0 the cloud printed that many receipts of P1 first (real
 * allocation in cloud mode): the claim then retires P1 (it has receipts) and
 * binds P2 to the edge, so the bound run is `boundPrefix` = P2.
 */
async function boundRunWithHighWater(sold: number, cloudSold = 0) {
  const cloudOutletId = await freshOutlet();
  const deviceId = await enrollPos(cloudOutletId);
  for (let i = 1; i <= cloudSold; i += 1) {
    const receipt = await allocate(
      cloudOutletId,
      await draftOrder(cloudOutletId),
      deviceId,
    );
    expect(receipt.number).toBe(formatReceiptNumber("P1", i));
  }
  const boundPrefix = cloudSold > 0 ? "P2" : "P1";
  const nodeId = await insertNode(cloudOutletId);
  const own: Binding = { edgeNodeId: nodeId, edgeInstanceId: randomUUID() };
  const edgeOutletId = await freshOutlet();
  await edgePull(edgeOutletId, cloudOutletId, own);
  for (let i = 1; i <= sold; i += 1)
    expect(await edgeSell(edgeOutletId, deviceId)).toBe(
      formatReceiptNumber(boundPrefix, i),
    );
  await edgePull(edgeOutletId, cloudOutletId, own);
  // Precondition: bound to the edge, the cloud counter did not move.
  expect(await runOf(cloudOutletId, boundPrefix)).toMatchObject({
    last_number: 0,
    edge_reported_number: sold,
    edge_node_id: nodeId,
    edge_instance_id: own.edgeInstanceId,
    device_id: deviceId,
    retired_at: null,
  });
  return { cloudOutletId, edgeOutletId, deviceId, own, boundPrefix };
}

/** Owner SQL insert straight into the table: the trigger is the only guard. */
function insertWriteoffRow(
  outletId: string,
  sequenceId: string,
  sequenceNumber: number,
) {
  return asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO receipt_number_writeoffs
         (id, tenant_id, outlet_id, sequence_id, prefix, sequence_number, reason, written_off_by)
       VALUES ($1, $2, $3, $4, 'P1', $5, $6, $7)`,
      [
        randomUUID(),
        tenant.tenantId,
        outletId,
        sequenceId,
        sequenceNumber,
        REASON,
        cashier.userId,
      ],
    ),
  );
}

/** Runs of the outlet that miss ordinals (what the outlet gap port reports). */
function outletGaps(outletId: string) {
  const context = tenantContext(tenant.tenantId);
  return withTenant(db, context, (tx) =>
    receiptGapsForOutletFast(tx as never, context, outletId),
  );
}

// ---- Cases ---------------------------------------------------------------------

describe("drzaf-1 an edge-bound run can be written off up to the number the edge reported", () => {
  it("POS-06 EDG-02 edge reported 5 (cloud last_number 0): write-off of 3 succeeds, 6 is refused as out of range", async () => {
    const { cloudOutletId } = await boundRunWithHighWater(5);

    const created = await writeOff(cloudOutletId, 3);
    expect(created).toMatchObject({
      outletId: cloudOutletId,
      prefix: "P1",
      sequenceNumber: 3,
      number: "P1-000003",
      reason: REASON,
    });
    expect(await writeoffRows(cloudOutletId)).toEqual([
      expect.objectContaining({ prefix: "P1", sequence_number: 3 }),
    ]);

    await expect(writeOff(cloudOutletId, 6)).rejects.toMatchObject({
      code: "CONFLICT",
      message: OUT_OF_RANGE,
    });
    // Nothing was stored for the refused number, the cloud counter is intact.
    expect(await writeoffRows(cloudOutletId)).toHaveLength(1);
    expect(await runOf(cloudOutletId)).toMatchObject({ last_number: 0 });
  });

  it("POS-06 EDG-02 the high-water itself (5) is in range", async () => {
    const { cloudOutletId } = await boundRunWithHighWater(5);
    await expect(writeOff(cloudOutletId, 5)).resolves.toMatchObject({
      number: "P1-000005",
    });
  });
});

describe("drzaf-2 the other refusals stay", () => {
  it("POS-06 a number with a receipt on the cloud stays refused and a retired cloud run is not widened by the edge's high-water", async () => {
    // The cloud printed P1-000001 and P1-000002; the edge claim retires P1
    // (it has receipts) and binds P2, where the edge prints 3 receipts.
    const { cloudOutletId, boundPrefix } = await boundRunWithHighWater(3, 2);
    expect(boundPrefix).toBe("P2");
    expect(await runOf(cloudOutletId, "P1")).toMatchObject({
      last_number: 2,
      edge_reported_number: 0,
    });

    await expect(writeOff(cloudOutletId, 2, "P1")).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Nomor struk ini sudah punya struk.",
    });
    await expect(writeOff(cloudOutletId, 3, "P1")).rejects.toMatchObject({
      code: "CONFLICT",
      message: OUT_OF_RANGE,
    });
    expect(await writeoffRows(cloudOutletId)).toEqual([]);

    // The bound run is written off up to its high-water, not beyond.
    await expect(writeOff(cloudOutletId, 2, "P2")).resolves.toMatchObject({
      number: "P2-000002",
    });
    await expect(writeOff(cloudOutletId, 4, "P2")).rejects.toMatchObject({
      code: "CONFLICT",
      message: OUT_OF_RANGE,
    });
  });

  it("POS-06 writing off the same number twice is refused the second time", async () => {
    const { cloudOutletId } = await boundRunWithHighWater(5);
    await writeOff(cloudOutletId, 4);

    await expect(writeOff(cloudOutletId, 4)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Nomor struk ini sudah di-write-off.",
    });
    expect(await writeoffRows(cloudOutletId)).toHaveLength(1);
  });
});

describe("drzaf-3 the database trigger is the backstop for the same limit", () => {
  it("POS-06 owner SQL insert above the high-water (6) is refused with 23514, a number up to the high-water is accepted", async () => {
    const { cloudOutletId } = await boundRunWithHighWater(5);
    const run = await runOf(cloudOutletId);

    await expect(
      insertWriteoffRow(cloudOutletId, run.id, 6),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await writeoffRows(cloudOutletId)).toEqual([]);

    await insertWriteoffRow(cloudOutletId, run.id, 5);
    await insertWriteoffRow(cloudOutletId, run.id, 3);
    expect(
      (await writeoffRows(cloudOutletId)).map((w) => w.sequence_number),
    ).toEqual([3, 5]);
  });
});

describe("drzaf-4 the write-off reaches the edge run and closes its gap", () => {
  it("POS-06 EDG-02 edge lost number 3 (consumed without receipt), the cloud writes it off after the edge reported 5: the pull copies it and the edge gap is gone", async () => {
    const cloudOutletId = await freshOutlet();
    const deviceId = await enrollPos(cloudOutletId);
    const nodeId = await insertNode(cloudOutletId);
    const own: Binding = { edgeNodeId: nodeId, edgeInstanceId: randomUUID() };
    const edgeOutletId = await freshOutlet();
    await edgePull(edgeOutletId, cloudOutletId, own);

    expect(await edgeSell(edgeOutletId, deviceId)).toBe("P1-000001");
    expect(await edgeSell(edgeOutletId, deviceId)).toBe("P1-000002");
    // Number 3 is taken on the edge and its receipt never committed.
    await owner.query(
      `UPDATE receipt_sequences SET last_number = 3
        WHERE tenant_id = $1 AND outlet_id = $2 AND prefix = 'P1'`,
      [tenant.tenantId, edgeOutletId],
    );
    expect(await edgeSell(edgeOutletId, deviceId)).toBe("P1-000004");
    expect(await edgeSell(edgeOutletId, deviceId)).toBe("P1-000005");
    await edgePull(edgeOutletId, cloudOutletId, own, true);

    expect(await runOf(cloudOutletId)).toMatchObject({
      last_number: 0,
      edge_reported_number: 5,
    });
    // The edge's Tutup Hari would be refused: 3 is missing there.
    expect(await outletGaps(edgeOutletId)).toEqual([
      expect.objectContaining({ prefix: "P1", missing: [3] }),
    ]);

    await writeOff(cloudOutletId, 3);

    const pulled = await edgePull(edgeOutletId, cloudOutletId, own, true);
    expect(pulled).toMatchObject({
      receiptWriteoffsInserted: 1,
      receiptWriteoffsSkipped: 0,
      receiptWriteoffsRefused: 0,
    });
    const edgeRun = await runOf(edgeOutletId);
    expect(await writeoffRows(edgeOutletId)).toEqual([
      expect.objectContaining({
        prefix: "P1",
        sequence_number: 3,
        sequence_id: edgeRun.id,
      }),
    ]);
    expect(await outletGaps(edgeOutletId)).toEqual([]);
  });
});
