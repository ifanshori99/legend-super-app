// Detect a restored / cloned edge database (bead legend-yd0h8; builds on
// legend-zsdd; legend-ol6v edge->cloud receipt merge is NOT built).
//
// Invariant under test: an edge database that went BACK in time (backup or VM
// snapshot restore, or a clone) keeps its (node, instance) binding, so the
// cloud cannot tell it from the original by the binding alone. Each pull of a
// primary edge reports its local counters (`receiptRuns`, `P1:150,P3:7`); the
// cloud keeps a never-decreasing high-water per run
// (`receipt_sequences.edge_reported_number`) and, when a report is BELOW the
// high-water, retires the run (`retired_reason = 'edge_regressed'`) and binds
// the next free prefix to the same (node, instance) at 0, so the restored edge
// numbers under a new prefix and never reissues a printed number. Rotations are
// rate limited (2 per node+device per 24 h); then the cloud stops rotating and
// raises `receiptRunAlert` (only to an edge that sent `receiptRuns`).
//
// Written against the Contract of docs/briefs/sub-edge-restore-detect.md. Same
// simulation as pos-receipt-seq-edge.test.ts (helpers copied, not edited): the
// cloud and every "edge database" share one PostgreSQL database, an edge
// database is an edge OUTLET, and a cloud page is shipped to an edge outlet by
// rewriting the sequence id and outlet. The edge is driven through
// `pullDeviceRegistry`, whose `fetchPage(since, receiptRuns)` calls the cloud
// `listDeviceRecordsSince` (in cloud mode while the cloud answers).
//
// Assumptions:
//  - Prefixes are handed out as P1, P2, P3 ... per outlet ("next free P<n>").
//  - A regression rotation keeps the run's device and binds the new row to the
//    same (node, instance); the new row's cloud `last_number` is 0.
//  - Alert timing follows Design 3 literally: the alert holds as soon as some
//    device of the node has >= 2 `edge_regressed` retirements in 24 h, counting
//    the pull's own rotations. The 24 h window EXPIRY is not tested (the
//    trigger forbids back-dating `retired_at` of a retired row).
//  - On the base (before legend-yd0h8) the new API (`encodeReceiptRunReport`,
//    `receiptRuns`, `receiptRunAlert`, the new columns) does not exist: cases
//    that need it fail on that missing API. Cases 1 and 2 only use the edge
//    pull, so they fail on the receipt NUMBER assertion.
//  - Round 2/3 (R1 stale token, R2 retire needs a reason, A3 early clone alert,
//    Q1..Q3): the token of a report is the CLOUD arrival time of the request
//    (the route stamps it before the credential check and passes it as
//    `listDeviceRecordsSince`'s `now` option), never an edge clock. A row whose `edge_reported_at` is >= the
//    token is skipped as stale (equal token = stale). The claim is driven
//    directly (explicit `reportedAt` = arrival time) for the `stale` count, and
//    through `listDeviceRecordsSince(..., { now })` for page-level facts. The
//    claim runs in the default (cloud) mode with a tenant-wide test context.
//    A pull without an explicit `now` gets a strictly increasing `now` (two
//    pulls never share a token), all in the future of the real clock so that
//    nothing is held back by the settle window.
//  - A regression rotation stamps the retired row `edge_reported_at` with the
//    token of the rotating pull (Q3), so a delayed report that arrived earlier
//    cannot look like a second live database.
//  - Rejected owner SQL is asserted as a rejected query (messages are backend
//    detail), after a precondition read proves the new columns exist and
//    followed by a check that nothing moved.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
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
  ulidToUuid,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  decodeReceiptRunReport,
  encodeReceiptRunReport,
  type DeviceReceiptSequenceBinding,
  type DeviceSyncPage,
  type ReceiptRunReport,
} from "@starter/shared/edge";
import { formatReceiptNumber, type PosReceipt } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { logger } from "../lib/logger.ts";
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
import * as receiptService from "../services/pos-receipt.service.ts";
import {
  allocateReceipt,
  claimDeviceReceiptSequencesForEdge,
  createPosReceiptPort,
  mergeDeviceReceiptRun,
  provisionReceiptSequence,
} from "../services/pos-receipt.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  cashierRole: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let other: IsolatedTenant;
let headers: { Host: string };
let cashier: { client: ReturnType<typeof agent>; userId: string };
const actor = randomUUID();
const cloudState = getEdgeRuntimeState();

// ---- Fixtures (copied from pos-receipt-kfix.test.ts) ------------------------

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
  tenantId: string,
  source: "session" | "device",
  outletId: string,
): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source,
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );
const cloudScope = (outletId: string, tenantId = tenant.tenantId) =>
  scoped(tenantId, "session", outletId);
const edgeScope = (outletId: string, tenantId = tenant.tenantId) =>
  scoped(tenantId, "device", outletId);

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
      `Q${outletId.slice(0, 8)}`.toUpperCase(),
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
  const created = await asEdgeProcess(() =>
    cashier.client
      .post(`/api/outlets/${encodeURIComponent(outletId)}/pos/orders`)
      .set(headers)
      .set(originHeader)
      .send({
        idempotencyKey: randomUUID(),
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId: ids.kopi, quantity: 1, modifierIds: [] }],
      }),
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}

/**
 * 1269 E3: the cloud refuses a sale on an outlet an active edge serves
 * (POS_WRITE_ON_EDGE), so a draft sale to number is created as the edge would.
 */
async function asEdgeProcess<T>(run: () => Promise<T>): Promise<T> {
  const previous = getEdgeRuntimeState();
  setEdgeRuntimeStateForTests({ ...previous, edgeMode: true });
  try {
    return await run();
  } finally {
    setEdgeRuntimeStateForTests(previous);
  }
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

// ---- Device and sequence helpers --------------------------------------------

type DeviceType = Parameters<typeof enrollDevice>[2]["type"];

async function enroll(
  outletId: string,
  type: DeviceType = "pos",
  tenantId = tenant.tenantId,
) {
  const { device } = await enrollDevice(cloudScope(outletId, tenantId), actor, {
    outletId,
    type,
    label: `Perangkat ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  return device;
}

// ---- Setup ------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setAuditWriter(coreAuditWriter);
  setPosReceiptPort(createPosReceiptPort());
  tenant = await createIsolatedTenant(`rpv-${randomUUID().slice(0, 6)}`);
  other = await createIsolatedTenant(`rpw-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Receipt Prov Kasir', false, NULL, $3, false, '["tenant","outlet"]')`,
    [
      ids.cashierRole,
      tenant.tenantId,
      JSON.stringify(["order.view", "pos.sale.create"]),
    ],
  );
  const client = agent(app);
  await signUp(client, "Receipt Prov Kasir");
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
       VALUES ($1, $2, $3, 'Receipt Prov Uji', 0)`,
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
       VALUES ($1, $2, NULL, 'PBJT-RPV', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
  });
});

afterEach(() => {
  setEdgeRuntimeStateForTests(cloudState);
  vi.restoreAllMocks();
});

afterAll(async () => {
  setEdgeRuntimeStateForTests(cloudState);
  setAuditWriter(null);
  setPosReceiptPort(null);
  // Final orders and receipts are append-only: the tenants stay in the
  // disposable database with a valid creator (as pos-receipt-kfix.test.ts does).
  for (const t of [tenant, other])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      t.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

// ---- legend-yd0h8 helpers ----------------------------------------------------

type Binding = DeviceReceiptSequenceBinding;
type SeqRow = {
  id: string;
  prefix: string;
  last_number: number;
  device_id: string;
  edge_node_id: string | null;
  edge_instance_id: string | null;
  retired_at: Date | null;
};
type RunRow = SeqRow & {
  edge_reported_number: number;
  edge_reported_at: Date | null;
  retired_reason: string | null;
};

/** Every row of the outlet (retired included) with the binding columns. */
function fullRows(outletId: string): Promise<SeqRow[]> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const result = await client.query(
      `SELECT id, prefix, last_number, device_id, edge_node_id, edge_instance_id, retired_at
       FROM receipt_sequences WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY prefix`,
      [tenant.tenantId, outletId],
    );
    return result.rows as SeqRow[];
  });
}

/** Same rows plus the legend-yd0h8 columns (fails while they do not exist). */
function runRows(outletId: string): Promise<RunRow[]> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const result = await client.query(
      `SELECT id, prefix, last_number, device_id, edge_node_id, edge_instance_id, retired_at,
              edge_reported_number, edge_reported_at, retired_reason
       FROM receipt_sequences WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY prefix`,
      [tenant.tenantId, outletId],
    );
    return result.rows as RunRow[];
  });
}

const rowOf = <T extends SeqRow>(rows: T[], prefix: string): T => {
  const row = rows.find((r) => r.prefix === prefix);
  if (!row) throw new Error(`No sequence ${prefix} in ${JSON.stringify(rows)}`);
  return row;
};

async function currentPrefix(
  outletId: string,
  deviceId: string,
): Promise<string> {
  const row = (await fullRows(outletId)).find(
    (r) => r.device_id === deviceId && r.retired_at === null,
  );
  if (!row) throw new Error(`Device ${deviceId} has no current run`);
  return row.prefix;
}

const regressedCount = (rows: RunRow[]) =>
  rows.filter((r) => r.retired_reason === "edge_regressed").length;

/** A cloud primary edge_nodes row (instance_id stays NULL on cloud rows). */
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

/** Stable edge-side id per (edge outlet, cloud sequence id); see `shipTo`. */
const shippedIds = new Map<string, string>();

/**
 * What an edge database applies: the cloud page with each sequence moved to
 * the edge's own outlet and given another id (the cloud rows live in the same
 * database in this test). The id is stable per edge and cloud row, as a real
 * edge keeps the cloud's id: legend-sduiq retires a local run whose id is not
 * in the pulled list. Device records stay behind (they belong to the cloud
 * outlet); the paging meta is kept.
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
  return {
    ...page,
    data: [],
    receiptSequences: (page.receiptSequences ?? []).map((s) => ({
      ...s,
      id: edgeIdOf(s.id),
      outletId: edgeOutletId,
    })),
  };
}

/**
 * This edge database's own `edge_nodes` row (id = node id, `instance_id` =
 * its instance), as `ensureLocalEdgeNode` writes it (upsert, copied from
 * pos-receipt-seq-edge.test.ts). A restored/cloned database keeps the same
 * (node, instance), so every simulated edge here uses the same binding.
 */
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
    /** legend-rh1hk: the edge outbox cursor sent as `receiptRunsSeq`. */
    reportSeq?: number;
    /** Cloud arrival time of the request (the report token). Default: next tick. */
    now?: Date;
    since?: string | null;
    limit?: number;
  } = {},
): Promise<DeviceSyncPage> {
  const query = deviceSyncQuerySchema.parse({
    limit: options.limit ?? 100,
    receiptSequences: "1",
    edgeInstance: own.edgeInstanceId,
    ...(options.since ? { since: options.since } : {}),
    ...(options.report
      ? { receiptRuns: encodeReceiptRunReport(options.report) }
      : {}),
    ...(options.reportSeq !== undefined
      ? { receiptRunsSeq: String(options.reportSeq) }
      : {}),
  });
  return listDeviceRecordsSince(
    {
      tenantId: tenant.tenantId as TenantId,
      outletId: outletIdSchema.parse(cloudOutletId),
      edgeNodeId: own.edgeNodeId,
    },
    query,
    { now: options.now ?? nextCloudNow(), settleMs: 0 },
  );
}

/**
 * The edge database `edgeOutletId` pulls from the cloud outlet through
 * `pullDeviceRegistry` (it computes and passes its own `receiptRuns`).
 * `calls` records what each page request carried.
 */
async function edgePull(
  edgeOutletId: string,
  cloudOutletId: string,
  own: Binding,
  limit = 100,
) {
  await localEdgeNode(edgeOutletId, own);
  const calls: Array<{
    since: string | null;
    receiptRuns: ReceiptRunReport | undefined;
  }> = [];
  const pages: DeviceSyncPage[] = [];
  const result = await inEdgeMode(() =>
    pullDeviceRegistry({
      context: edgeScope(edgeOutletId),
      role: "primary",
      binding: own,
      fetchPage: async (
        since: string | null,
        receiptRuns?: ReceiptRunReport,
      ) => {
        calls.push({ since, receiptRuns });
        // The cloud answers in cloud mode, whatever the calling edge's mode.
        const edgeState = getEdgeRuntimeState();
        setEdgeRuntimeStateForTests(cloudState);
        try {
          const page = await cloudPull(cloudOutletId, own, {
            since,
            limit,
            report: receiptRuns,
          });
          pages.push(page);
          return shipTo(page, edgeOutletId);
        } finally {
          setEdgeRuntimeStateForTests(edgeState);
        }
      },
    }),
  );
  return { result, calls, pages };
}

/** The edge database of `own` applies one already-shipped page (no check). */
async function edgeApply(edgeOutletId: string, pulled: unknown, own: Binding) {
  await localEdgeNode(edgeOutletId, own);
  return inEdgeMode(() =>
    pullDeviceRegistry({
      context: edgeScope(edgeOutletId),
      role: "primary",
      binding: own,
      fetchPage: async () => pulled,
    }),
  );
}

async function edgeSell(outletId: string, deviceId: string): Promise<string> {
  const orderId = await draftOrder(outletId);
  const receipt = await inEdgeMode(() => allocate(outletId, orderId, deviceId));
  return receipt.number;
}

/** A report for the CURRENT run of each device: `deviceId -> lastNumber`. */
async function reportFor(
  cloudOutletId: string,
  counts: Array<[deviceId: string, lastNumber: number]>,
): Promise<ReceiptRunReport> {
  const report = new Map<string, number>();
  for (const [deviceId, lastNumber] of counts)
    report.set(await currentPrefix(cloudOutletId, deviceId), lastNumber);
  return report;
}

/** A cloud outlet with `n` pos devices and a primary node N, nothing pulled yet. */
async function cloudOutlet(deviceCount = 1) {
  const outletId = await freshOutlet();
  const devices: string[] = [];
  for (let i = 0; i < deviceCount; i += 1)
    devices.push((await enroll(outletId, "pos")).id);
  const nodeId = await insertNode(outletId);
  const own: Binding = { edgeNodeId: nodeId, edgeInstanceId: randomUUID() };
  return { outletId, devices, own };
}

/** Restore setup: edge A (N, I) pulled, sold `sold` on P1 and pulled again. */
async function edgeAWithHighWater(sold = 3) {
  const { outletId, devices, own } = await cloudOutlet(1);
  const [deviceId] = devices as [string];
  const edgeA = await freshOutlet();
  const first = await edgePull(edgeA, outletId, own);
  for (let i = 1; i <= sold; i += 1)
    expect(await edgeSell(edgeA, deviceId)).toBe(
      `P1-${String(i).padStart(6, "0")}`,
    );
  await edgePull(edgeA, outletId, own);
  return { outletId, deviceId, own, edgeA, firstPage: first.pages[0]! };
}

/** `at(10)` = 10 s after the base: cloud arrival times of reports. */
function clock(): (seconds: number) => Date {
  const base = Date.now() + 10 * 60_000;
  return (seconds) => new Date(base + seconds * 1000);
}

/** The claim run directly, to read its counts (`stale`, `regressed`, ...). */
function claim(
  outletId: string,
  own: Binding,
  report: ReceiptRunReport,
  reportedAt?: Date,
  reportCursor?: number,
) {
  return inTx((tx, context) =>
    claimDeviceReceiptSequencesForEdge(tx, context, {
      outletId,
      ...own,
      report,
      ...(reportedAt ? { reportedAt } : {}),
      ...(reportCursor !== undefined ? { reportCursor } : {}),
    }),
  );
}

// ---- Cases ---------------------------------------------------------------------

describe("yd0h8-1 a restored edge database (backup of an earlier state) never reissues a printed number", () => {
  it("POS-06 EDG-02 restore: B holds P1 at 1 while the cloud saw 3: P1 is retired (edge_regressed), B numbers under a new prefix, never P1-000002", async () => {
    const { outletId, deviceId, own, firstPage } = await edgeAWithHighWater(3);

    // The restored database B: same node and instance, holds P1 at 1.
    const edgeB = await freshOutlet();
    await edgeApply(edgeB, shipTo(firstPage, edgeB), own);
    expect(await edgeSell(edgeB, deviceId)).toBe("P1-000001");

    const pulled = await edgePull(edgeB, outletId, own);
    const next = await edgeSell(edgeB, deviceId);
    // The restored edge must not continue A's already printed P1-000002.
    expect(next).not.toBe("P1-000002");
    expect(next).toBe("P2-000001");

    const rows = await runRows(outletId);
    expect(rowOf(rows, "P1")).toMatchObject({
      retired_reason: "edge_regressed",
      edge_reported_number: 3,
      edge_node_id: own.edgeNodeId,
      edge_instance_id: own.edgeInstanceId,
    });
    expect(rowOf(rows, "P1").retired_at).not.toBeNull();
    expect(rowOf(rows, "P2")).toMatchObject({
      last_number: 0,
      retired_at: null,
      retired_reason: null,
      edge_node_id: own.edgeNodeId,
      edge_instance_id: own.edgeInstanceId,
    });
    expect(regressedCount(rows)).toBe(1);
    // A single restore is not an alert.
    expect(pulled.result.receiptRunAlert).toBe(false);
    for (const page of pulled.pages)
      expect("receiptRunAlert" in page).toBe(false);
  });

  it("POS-06 EDG-02 restore from before the run: B holds no P1, sends an empty report, is rotated and never issues P1-000001", async () => {
    const { outletId, deviceId, own } = await edgeAWithHighWater(3);

    const edgeB = await freshOutlet();
    const pulled = await edgePull(edgeB, outletId, own);
    const number = await edgeSell(edgeB, deviceId);
    expect(number).not.toBe("P1-000001");
    expect(number).toBe("P2-000001");
    // The empty report is sent (`receiptRuns=`), not omitted.
    expect(pulled.calls[0]?.receiptRuns).toEqual(new Map());

    const rows = await runRows(outletId);
    expect(rowOf(rows, "P1")).toMatchObject({
      retired_reason: "edge_regressed",
    });
    expect(rowOf(rows, "P2").retired_at).toBeNull();
    expect(regressedCount(rows)).toBe(1);
  });
});

describe("yd0h8-3 normal reports never rotate and the high-water only rises", () => {
  it("POS-06 equal, forward and repeated reports: no rotation, high-water follows, the edge keeps numbering P1", async () => {
    const { outletId, devices, own } = await cloudOutlet(1);
    const [deviceId] = devices as [string];
    const edge = await freshOutlet();

    await edgePull(edge, outletId, own);
    // A fresh run reported at 0 equals the high-water 0: normal.
    expect(rowOf(await runRows(outletId), "P1")).toMatchObject({
      edge_reported_number: 0,
      retired_at: null,
    });

    await edgeSell(edge, deviceId);
    await edgeSell(edge, deviceId);
    const forward = await edgePull(edge, outletId, own);
    expect(forward.calls[0]?.receiptRuns).toEqual(new Map([["P1", 2]]));
    expect(rowOf(await runRows(outletId), "P1").edge_reported_number).toBe(2);

    // Equal, twice.
    await edgePull(edge, outletId, own);
    await edgePull(edge, outletId, own);
    expect(rowOf(await runRows(outletId), "P1").edge_reported_number).toBe(2);

    await edgeSell(edge, deviceId);
    const again = await edgePull(edge, outletId, own);
    expect(again.result.receiptRunAlert).toBe(false);

    const rows = await runRows(outletId);
    expect(rows.map((r) => r.prefix)).toEqual(["P1"]);
    expect(rowOf(rows, "P1")).toMatchObject({
      edge_reported_number: 3,
      retired_at: null,
      retired_reason: null,
      // The edge's numbers still never reach the cloud counter (legend-ol6v).
      last_number: 0,
    });
    expect(await edgeSell(edge, deviceId)).toBe("P1-000004");
  });

  it("POS-06 multi-page pull: every page carries the report, three runs at 1, 2, 3 raise their high-water and nothing rotates", async () => {
    const { outletId, devices, own } = await cloudOutlet(3);
    const edge = await freshOutlet();
    await edgePull(edge, outletId, own);
    for (const [index, deviceId] of devices.entries())
      for (let i = 0; i <= index; i += 1) await edgeSell(edge, deviceId);

    const pulled = await edgePull(edge, outletId, own, 1);
    expect(pulled.calls.length).toBeGreaterThan(1);
    const expected = await reportFor(
      outletId,
      devices.map((d, i) => [d, i + 1]),
    );
    for (const call of pulled.calls) expect(call.receiptRuns).toEqual(expected);

    const rows = await runRows(outletId);
    expect(rows).toHaveLength(3);
    for (const [index, deviceId] of devices.entries())
      expect(rows.find((r) => r.device_id === deviceId)).toMatchObject({
        edge_reported_number: index + 1,
        retired_at: null,
        retired_reason: null,
      });
    expect(pulled.result.receiptRunAlert).toBe(false);
  });

  it("POS-06 entries for unknown or retired prefixes are ignored and a report never lowers the high-water", async () => {
    const { outletId, devices, own } = await cloudOutlet(1);
    const [deviceId] = devices as [string];
    await cloudPull(outletId, own, { report: new Map() });
    await cloudPull(outletId, own, { report: new Map([["P1", 5]]) });
    expect(rowOf(await runRows(outletId), "P1").edge_reported_number).toBe(5);

    // Unknown prefix P9 beside the true value: ignored, no rotation.
    const withUnknown = await cloudPull(outletId, own, {
      report: new Map([
        ["P1", 5],
        ["P9", 1],
      ]),
    });
    expect(withUnknown.receiptSequences?.map((s) => s.prefix)).toEqual(["P1"]);

    // A regression retires P1; a later report that still lists P1 (huge) is
    // ignored for the retired run and judged only for P2.
    await cloudPull(outletId, own, { report: new Map([["P1", 1]]) });
    expect(await currentPrefix(outletId, deviceId)).toBe("P2");
    const stale = await cloudPull(outletId, own, {
      report: new Map([
        ["P1", 999],
        ["P2", 0],
      ]),
    });
    expect(stale.receiptSequences?.map((s) => s.prefix)).toEqual(["P2"]);

    const rows = await runRows(outletId);
    expect(rows.map((r) => r.prefix)).toEqual(["P1", "P2"]);
    // The retired run keeps its high-water; the new one starts at 0.
    expect(rowOf(rows, "P1").edge_reported_number).toBe(5);
    expect(rowOf(rows, "P2")).toMatchObject({
      edge_reported_number: 0,
      retired_at: null,
    });
    expect(regressedCount(rows)).toBe(1);
  });
});

describe("yd0h8-4 an old edge (no receiptRuns) is not checked", () => {
  it("POS-06 EDG-02 without receiptRuns: no regression check, no rotation, no receiptRunAlert key, zsdd behaviour unchanged", async () => {
    const { outletId, devices, own } = await cloudOutlet(1);
    const [deviceId] = devices as [string];
    await cloudPull(outletId, own, { report: new Map() });
    await cloudPull(outletId, own, { report: new Map([["P1", 3]]) });

    // The old edge would be "regressed" (it holds nothing) but sends no report.
    const old = await cloudPull(outletId, own);
    expect(old.receiptSequences?.map((s) => s.prefix)).toEqual(["P1"]);
    expect("receiptRunAlert" in old).toBe(false);
    const rows = await runRows(outletId);
    expect(rows.map((r) => r.prefix)).toEqual(["P1"]);
    expect(rowOf(rows, "P1")).toMatchObject({
      retired_at: null,
      edge_reported_number: 3,
    });
    expect(await currentPrefix(outletId, deviceId)).toBe("P1");

    // zsdd: a NEW instance (rebuilt edge) still rotates, reason claim_rotated.
    const rebuilt: Binding = {
      edgeNodeId: own.edgeNodeId,
      edgeInstanceId: randomUUID(),
    };
    const afterRebuild = await cloudPull(outletId, rebuilt);
    expect(afterRebuild.receiptSequences?.map((s) => s.prefix)).toEqual(["P2"]);
    expect(rowOf(await runRows(outletId), "P1")).toMatchObject({
      retired_reason: "claim_rotated",
    });
    expect("receiptRunAlert" in afterRebuild).toBe(false);
  });
});

/** Drives one device of a cloned database to the rotation limit (2 rotations). */
async function cloneUntilAlert() {
  const setup = await cloudOutlet(1);
  const { outletId, devices, own } = setup;
  const [deviceId] = devices as [string];
  await cloudPull(outletId, own, { report: new Map() });
  await cloudPull(outletId, own, { report: new Map([["P1", 3]]) });
  // Clone B reports 1 < 3: regression 1 (a single restore: no alert yet).
  const first = await cloudPull(outletId, own, {
    report: new Map([["P1", 1]]),
  });
  expect(first.receiptSequences?.map((s) => s.prefix)).toEqual(["P2"]);
  expect("receiptRunAlert" in first).toBe(false);
  // Clone A then reports P2 at 5; clone B reports P2 at 2: regression 2.
  await cloudPull(outletId, own, { report: new Map([["P2", 5]]) });
  const second = await cloudPull(outletId, own, {
    report: new Map([["P2", 2]]),
  });
  expect(second.receiptSequences?.map((s) => s.prefix)).toEqual(["P3"]);
  return { ...setup, deviceId, second };
}

describe("yd0h8-5 a clone (two live databases on one node) rotates at most twice, then alerts and stops", () => {
  it("POS-06 EDG-02 two rotations per device in 24 h, the alert appears with the second, the third regression is throttled: prefix stable, high-water kept, alert true", async () => {
    const { outletId, deviceId, own, second } = await cloneUntilAlert();
    expect(second.receiptRunAlert).toBe(true);

    // Run P3 gets a high-water of 9, then the other clone reports 4 < 9.
    const raised = await cloudPull(outletId, own, {
      report: new Map([["P3", 9]]),
    });
    expect(raised.receiptRunAlert).toBe(true);
    for (let i = 0; i < 2; i += 1) {
      const throttled = await cloudPull(outletId, own, {
        report: new Map([["P3", 4]]),
      });
      // No third rotation: the same run is handed out again, alert stays.
      expect(throttled.receiptSequences?.map((s) => s.prefix)).toEqual(["P3"]);
      expect(throttled.receiptRunAlert).toBe(true);
    }

    const rows = await runRows(outletId);
    expect(rows.map((r) => r.prefix)).toEqual(["P1", "P2", "P3"]);
    expect(regressedCount(rows)).toBe(2);
    expect(rowOf(rows, "P1")).toMatchObject({
      retired_reason: "edge_regressed",
    });
    expect(rowOf(rows, "P2")).toMatchObject({
      retired_reason: "edge_regressed",
      edge_reported_number: 5,
    });
    // The high-water is never lowered by a throttled (smaller) report.
    expect(rowOf(rows, "P3")).toMatchObject({
      retired_at: null,
      retired_reason: null,
      edge_reported_number: 9,
    });
    expect(await currentPrefix(outletId, deviceId)).toBe("P3");
  });

  it("POS-06 an edge pulling with receiptRuns sees the alert even when its own report is fine; an old edge never does", async () => {
    const { outletId, own } = await cloneUntilAlert();
    await cloudPull(outletId, own, { report: new Map([["P3", 9]]) });

    const equal = await cloudPull(outletId, own, {
      report: new Map([["P3", 9]]),
    });
    expect(equal.receiptRunAlert).toBe(true);
    expect(equal.receiptSequences?.map((s) => s.prefix)).toEqual(["P3"]);

    const old = await cloudPull(outletId, own);
    expect("receiptRunAlert" in old).toBe(false);
    expect(old.receiptSequences?.map((s) => s.prefix)).toEqual(["P3"]);
    expect(regressedCount(await runRows(outletId))).toBe(2);
  });

  it("POS-06 EDG-02 end to end: a restored edge that regresses once the limit is reached keeps its prefix, the pull result shows the alert", async () => {
    const { outletId, deviceId, own } = await cloneUntilAlert();
    await cloudPull(outletId, own, { report: new Map([["P3", 9]]) });

    const edgeC = await freshOutlet();
    const pulled = await edgePull(edgeC, outletId, own);
    expect(pulled.result.receiptRunAlert).toBe(true);
    // Throttled: no P4; the edge numbers under the stable current run.
    expect(await edgeSell(edgeC, deviceId)).toBe("P3-000001");
    const rows = await runRows(outletId);
    expect(rows.map((r) => r.prefix)).toEqual(["P1", "P2", "P3"]);
    expect(regressedCount(rows)).toBe(2);
    expect(rowOf(rows, "P3").edge_reported_number).toBe(9);
  });

  it("POS-06 the limit is per device: another device of the same node still rotates once, and sees the node alert", async () => {
    const { outletId, devices, own } = await cloudOutlet(2);
    const [d1, d2] = devices as [string, string];
    await cloudPull(outletId, own, { report: new Map() });
    const pull = async (counts: Array<[string, number]>) =>
      cloudPull(outletId, own, { report: await reportFor(outletId, counts) });

    await pull([
      [d1, 3],
      [d2, 6],
    ]);
    // d1 regresses twice (clone), d2 stays fine.
    await pull([
      [d1, 1],
      [d2, 6],
    ]);
    await pull([
      [d1, 5],
      [d2, 6],
    ]);
    await pull([
      [d1, 2],
      [d2, 6],
    ]);
    const d1Current = await currentPrefix(outletId, d1);
    const d2Before = await currentPrefix(outletId, d2);
    expect(regressedCount(await runRows(outletId))).toBe(2);

    // d2 now regresses for the first time: rotates (its own count is 0).
    const page = await pull([
      [d1, 0],
      [d2, 1],
    ]);
    expect(await currentPrefix(outletId, d2)).not.toBe(d2Before);
    expect(await currentPrefix(outletId, d1)).toBe(d1Current);
    expect(page.receiptRunAlert).toBe(true);
    expect(regressedCount(await runRows(outletId))).toBe(3);
  });
});

describe("yd0h8-8 a stale report (arriving with a token not newer than the stored one) is skipped", () => {
  it("POS-06 EDG-02 P1:3 arriving at t1 after P1:5 at t2 (token not newer): no rotation, stale 1, high-water and its time kept, the budget is not burned", async () => {
    const { outletId, own } = await cloudOutlet(1);
    const at = clock();
    await claim(outletId, own, new Map(), at(10));
    const raised = await claim(outletId, own, new Map([["P1", 5]]), at(40));
    expect(raised).toMatchObject({ regressed: 0, stale: 0 });

    const late = await claim(outletId, own, new Map([["P1", 3]]), at(30));
    expect(late).toMatchObject({
      regressed: 0,
      throttled: 0,
      stale: 1,
      alert: false,
    });
    // The same token as the stored one is stale too (not strictly newer).
    const same = await claim(outletId, own, new Map([["P1", 3]]), at(40));
    expect(same).toMatchObject({ regressed: 0, stale: 1, alert: false });

    // Through the page: still the same run handed out, no alert key.
    const page = await cloudPull(outletId, own, {
      report: new Map([["P1", 3]]),
      now: at(35),
    });
    expect(page.receiptSequences?.map((s) => s.prefix)).toEqual(["P1"]);
    expect("receiptRunAlert" in page).toBe(false);

    const rows = await runRows(outletId);
    expect(rows.map((r) => r.prefix)).toEqual(["P1"]);
    expect(rowOf(rows, "P1")).toMatchObject({
      retired_at: null,
      retired_reason: null,
      edge_reported_number: 5,
    });
    expect(rowOf(rows, "P1").edge_reported_at?.getTime()).toBe(
      at(40).getTime(),
    );

    // A real restore afterwards is still rotated, not throttled.
    const real = await claim(outletId, own, new Map([["P1", 1]]), at(60));
    expect(real).toMatchObject({ regressed: 1, throttled: 0, stale: 0 });
    const after = await runRows(outletId);
    expect(rowOf(after, "P1").retired_reason).toBe("edge_regressed");
    expect(rowOf(after, "P2").retired_at).toBeNull();
    expect(regressedCount(after)).toBe(1);
  });

  it("POS-06 EDG-02 the same lower count with a NEWER arrival token is a real regression: rotation, stale 0", async () => {
    const { outletId, own } = await cloudOutlet(1);
    const at = clock();
    await claim(outletId, own, new Map(), at(10));
    await claim(outletId, own, new Map([["P1", 5]]), at(40));

    const result = await claim(outletId, own, new Map([["P1", 3]]), at(50));
    expect(result).toMatchObject({ regressed: 1, throttled: 0, stale: 0 });
    const rows = await runRows(outletId);
    expect(rowOf(rows, "P1")).toMatchObject({
      retired_reason: "edge_regressed",
      edge_reported_number: 5,
    });
    // Q3: the rotation stamps the retired row with the token of the rotating
    // report (the high-water number stays frozen at 5).
    expect(rowOf(rows, "P1").edge_reported_at?.getTime()).toBe(
      at(50).getTime(),
    );
    expect(rowOf(rows, "P2")).toMatchObject({
      retired_at: null,
      edge_reported_number: 0,
    });
  });

  it("POS-06 EDG-02 a restore whose edge clock is far behind is still rotated: the token is the cloud arrival time, no edge clock is involved", async () => {
    const { outletId, own } = await cloudOutlet(1);
    const at = clock();
    // Two pulls through the page API with increasing cloud `now`. The
    // restored box's own clock (say a year behind) is never sent.
    await cloudPull(outletId, own, { report: new Map(), now: at(10) });
    const live = await cloudPull(outletId, own, {
      report: new Map([["P1", 5]]),
      now: at(20),
    });
    expect(live.receiptSequences?.map((s) => s.prefix)).toEqual(["P1"]);

    const restored = await cloudPull(outletId, own, {
      report: new Map([["P1", 2]]),
      now: at(30),
    });
    expect(restored.receiptSequences?.map((s) => s.prefix)).toEqual(["P2"]);
    const rows = await runRows(outletId);
    expect(rowOf(rows, "P1").retired_reason).toBe("edge_regressed");
    expect(rowOf(rows, "P2").retired_at).toBeNull();
    expect(regressedCount(rows)).toBe(1);
    // A single restore: no alert.
    expect("receiptRunAlert" in restored).toBe(false);
  });
});

describe("yd0h8-9 a clone is alerted at the first rotation", () => {
  it("POS-06 EDG-02 after one regression, a report of the retired prefix above its frozen high-water with a newer time raises the alert at once", async () => {
    const { outletId, own } = await cloudOutlet(1);
    const at = clock();
    await claim(outletId, own, new Map(), at(5));
    await claim(outletId, own, new Map([["P1", 3]]), at(10));
    // Clone B reports 1 < 3: one regression, a single restore: no alert yet.
    const first = await claim(outletId, own, new Map([["P1", 1]]), at(20));
    expect(first).toMatchObject({ regressed: 1, alert: false });
    expect(regressedCount(await runRows(outletId))).toBe(1);

    // Database A is still alive on P1: it reports P1 above the frozen 3. Not
    // yet an alert when the token is not newer than the frozen one...
    const olderToken = await claim(outletId, own, new Map([["P1", 4]]), at(10));
    expect(olderToken.alert).toBe(false);
    // ... nor when the count is not above the frozen high-water ...
    const notAbove = await claim(outletId, own, new Map([["P1", 3]]), at(30));
    expect(notAbove.alert).toBe(false);

    // ... but above it with a newer token: a second live database exists.
    const page = await cloudPull(outletId, own, {
      report: new Map([["P1", 4]]),
      now: at(30),
    });
    expect(page.receiptRunAlert).toBe(true);
    // Only one rotation so far: the alert did not come from the count.
    const rows = await runRows(outletId);
    expect(regressedCount(rows)).toBe(1);
    // The retired run stays frozen; the current run is unaffected.
    expect(rowOf(rows, "P1")).toMatchObject({
      retired_reason: "edge_regressed",
      edge_reported_number: 3,
    });
    expect(rowOf(rows, "P2").retired_at).toBeNull();

    // An old edge (no report) never sees the alert.
    const old = await cloudPull(outletId, own);
    expect("receiptRunAlert" in old).toBe(false);
  });

  it("POS-06 EDG-02 Q3: a report of the retired prefix above its frozen high-water that arrives before the rotation stamp is not a clone; one arriving after it is", async () => {
    const { outletId, own } = await cloudOutlet(1);
    const at = clock();
    await cloudPull(outletId, own, { report: new Map(), now: at(10) });
    await cloudPull(outletId, own, {
      report: new Map([["P1", 3]]),
      now: at(20),
    });
    // t3 = at(30): the restore is rotated; P1 is retired and stamped with t3.
    const rotation = await cloudPull(outletId, own, {
      report: new Map([["P1", 1]]),
      now: at(30),
    });
    expect(rotation.receiptSequences?.map((s) => s.prefix)).toEqual(["P2"]);
    const afterRotation = await runRows(outletId);
    expect(rowOf(afterRotation, "P1")).toMatchObject({
      retired_reason: "edge_regressed",
      edge_reported_number: 3,
    });
    expect(rowOf(afterRotation, "P1").edge_reported_at?.getTime()).toBe(
      at(30).getTime(),
    );

    // t2.5 = at(25): the live database's delayed report (read before the
    // restore) is older than the rotation stamp: no second database, no alert.
    const delayed = await cloudPull(outletId, own, {
      report: new Map([["P1", 4]]),
      now: at(25),
    });
    expect("receiptRunAlert" in delayed).toBe(false);
    expect(regressedCount(await runRows(outletId))).toBe(1);

    // After the stamp the same report means a database still numbering P1.
    const live = await cloudPull(outletId, own, {
      report: new Map([["P1", 4]]),
      now: at(40),
    });
    expect(live.receiptRunAlert).toBe(true);
    // Still one rotation; the retired run stays frozen.
    const rows = await runRows(outletId);
    expect(regressedCount(rows)).toBe(1);
    expect(rowOf(rows, "P1").edge_reported_number).toBe(3);
  });
});

describe("yd0h8-6 the database refuses to lower the high-water or rewrite a retire reason", () => {
  async function rotatedOutlet() {
    const { outletId, own } = await cloudOutlet(1);
    await cloudPull(outletId, own, { report: new Map() });
    await cloudPull(outletId, own, { report: new Map([["P1", 3]]) });
    await cloudPull(outletId, own, { report: new Map([["P1", 1]]) });
    const rows = await runRows(outletId);
    // Precondition (also proves the columns exist).
    const retired = rowOf(rows, "P1");
    const current = rowOf(rows, "P2");
    expect(retired).toMatchObject({
      retired_reason: "edge_regressed",
      edge_reported_number: 3,
    });
    expect(current).toMatchObject({
      retired_at: null,
      retired_reason: null,
      edge_reported_number: 0,
    });
    return { outletId, retired, current };
  }
  const update = (sql: string, params: unknown[]) =>
    asOwnerTenant(tenant.tenantId, (c) => c.query(sql, params));

  it("POS-06 edge_reported_number can rise on a current row but never decrease or leave 0..999999999", async () => {
    const { outletId, current } = await rotatedOutlet();
    await update(
      "UPDATE receipt_sequences SET edge_reported_number = 5 WHERE id = $1",
      [current.id],
    );
    for (const value of [4, 0, -1, 1_000_000_000])
      await expect(
        update(
          "UPDATE receipt_sequences SET edge_reported_number = $2 WHERE id = $1",
          [current.id, value],
        ),
      ).rejects.toThrow();
    expect(rowOf(await runRows(outletId), "P2").edge_reported_number).toBe(5);
  });

  it("POS-06 a retired row keeps its edge_reported_number and retired_reason", async () => {
    const { outletId, retired } = await rotatedOutlet();
    const before = await runRows(outletId);
    for (const [sql, params] of [
      [
        "UPDATE receipt_sequences SET edge_reported_number = 4 WHERE id = $1",
        [retired.id],
      ],
      [
        "UPDATE receipt_sequences SET edge_reported_number = 2 WHERE id = $1",
        [retired.id],
      ],
      [
        "UPDATE receipt_sequences SET retired_reason = 'claim_rotated' WHERE id = $1",
        [retired.id],
      ],
      [
        "UPDATE receipt_sequences SET retired_reason = NULL WHERE id = $1",
        [retired.id],
      ],
    ] as Array<[string, unknown[]]>)
      await expect(update(sql, params)).rejects.toThrow();
    expect(await runRows(outletId)).toEqual(before);
  });

  it("POS-06 retired_reason is set only together with retired_at, to a known reason", async () => {
    const { outletId, current } = await rotatedOutlet();
    // Not on a current row.
    await expect(
      update(
        "UPDATE receipt_sequences SET retired_reason = 'edge_regressed' WHERE id = $1",
        [current.id],
      ),
    ).rejects.toThrow();
    // Not an unknown reason.
    await expect(
      update(
        "UPDATE receipt_sequences SET retired_at = now(), retired_reason = 'bogus' WHERE id = $1",
        [current.id],
      ),
    ).rejects.toThrow();
    expect(rowOf(await runRows(outletId), "P2")).toMatchObject({
      retired_at: null,
      retired_reason: null,
    });
    // In the very update that retires the row it is allowed.
    await update(
      "UPDATE receipt_sequences SET retired_at = now(), retired_reason = 'claim_rotated' WHERE id = $1",
      [current.id],
    );
    const row = rowOf(await runRows(outletId), "P2");
    expect(row.retired_at).not.toBeNull();
    expect(row.retired_reason).toBe("claim_rotated");
  });

  it("POS-06 a row cannot be retired without a reason (retired_at alone, or with a NULL reason)", async () => {
    const { outletId, current } = await rotatedOutlet();
    await expect(
      update("UPDATE receipt_sequences SET retired_at = now() WHERE id = $1", [
        current.id,
      ]),
    ).rejects.toThrow();
    await expect(
      update(
        "UPDATE receipt_sequences SET retired_at = now(), retired_reason = NULL WHERE id = $1",
        [current.id],
      ),
    ).rejects.toThrow();
    expect(rowOf(await runRows(outletId), "P2")).toMatchObject({
      retired_at: null,
      retired_reason: null,
    });
  });

  it("POS-06 edge_reported_at can be set from NULL and move forward, never backwards or back to NULL", async () => {
    const { outletId, current } = await rotatedOutlet();
    expect(current.edge_reported_at).toBeNull();
    const base = Date.now() - 3_600_000;
    const set = (value: Date | null) =>
      update(
        "UPDATE receipt_sequences SET edge_reported_at = $2 WHERE id = $1",
        [current.id, value],
      );
    await set(new Date(base));
    await expect(set(new Date(base - 1000))).rejects.toThrow();
    await expect(set(null)).rejects.toThrow();
    expect(
      rowOf(await runRows(outletId), "P2").edge_reported_at?.getTime(),
    ).toBe(base);
    await set(new Date(base + 1000));
    expect(
      rowOf(await runRows(outletId), "P2").edge_reported_at?.getTime(),
    ).toBe(base + 1000);
  });

  it("POS-06 edge_reported_at is frozen on a retired row, set or NULL", async () => {
    const { outletId, retired, current } = await rotatedOutlet();
    // P1 was retired after a high-water raise: its time is set (also proves
    // the column exists and is written by the claim).
    expect(retired.edge_reported_at).not.toBeNull();
    for (const value of [new Date(Date.now() + 60_000), null])
      await expect(
        update(
          "UPDATE receipt_sequences SET edge_reported_at = $2 WHERE id = $1",
          [retired.id, value],
        ),
      ).rejects.toThrow();

    // A row retired while its time is NULL stays NULL.
    await update(
      "UPDATE receipt_sequences SET retired_at = now(), retired_reason = 'claim_rotated' WHERE id = $1",
      [current.id],
    );
    await expect(
      update(
        "UPDATE receipt_sequences SET edge_reported_at = $2 WHERE id = $1",
        [current.id, new Date()],
      ),
    ).rejects.toThrow();
    const rows = await runRows(outletId);
    expect(rowOf(rows, "P1").edge_reported_at?.getTime()).toBe(
      retired.edge_reported_at?.getTime(),
    );
    expect(rowOf(rows, "P2").edge_reported_at).toBeNull();
  });
});

describe("yd0h8-7 the receiptRuns query parameter is parsed strictly", () => {
  const parse = (receiptRuns: string) =>
    deviceSyncQuerySchema.safeParse({
      limit: 100,
      receiptSequences: "1",
      receiptRuns,
    });
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => `P${i + 1}:1`).join(",");

  it("POS-06 accepts the empty report and sorted entries, and encodes a report back", () => {
    expect(parse("").success).toBe(true);
    const ok = deviceSyncQuerySchema.parse({
      limit: 100,
      receiptSequences: "1",
      receiptRuns: "P1:150,P3:7",
    });
    // The query keeps the string (route and service both parse it, so a
    // second parse must accept the first one's output).
    expect(ok.receiptRuns).toBe("P1:150,P3:7");
    expect(deviceSyncQuerySchema.parse(ok)).toEqual(ok);
    expect(decodeReceiptRunReport(ok.receiptRuns ?? "x")).toEqual(
      new Map([
        ["P1", 150],
        ["P3", 7],
      ]),
    );
    expect(decodeReceiptRunReport("")).toEqual(new Map());
    expect(decodeReceiptRunReport("P1:1,P1:2")).toBeNull();
    expect(
      encodeReceiptRunReport(
        new Map([
          ["P3", 7],
          ["P1", 150],
        ]),
      ),
    ).toBe("P1:150,P3:7");
    expect(encodeReceiptRunReport(new Map())).toBe("");
    expect(parse("P1:0,P2:999999999").success).toBe(true);
    expect(parse(many(500)).success).toBe(true);
  });

  it("POS-06 refuses a bad prefix, a bad or negative number, a duplicate prefix, malformed lists and more than 500 entries", () => {
    // Control: the same shape with valid content is accepted, so each refusal
    // below is about the entry and not about an unknown parameter.
    expect(parse("P1:1,P2:2").success).toBe(true);
    for (const bad of [
      "p1:5",
      "-P1:5",
      ":5",
      "P1",
      "P1:",
      "P1:abc",
      "P1:-1",
      "P1:1.5",
      "P1:1000000000",
      "P1:1,P1:2",
      "P1:1,",
      ",P1:1",
      "P1:1,,P2:2",
      many(501),
      `P1:1,${"X".repeat(8000)}`,
    ])
      expect(parse(bad).success, JSON.stringify(bad.slice(0, 40))).toBe(false);
  });
});

// ---- Merge stamps edge_reported_at (architect decision) ----------------------------
//
// `mergeDeviceReceiptRun` stamps `receipt_sequences.edge_reported_at` with the
// APP clock (GREATEST of the stored value and now) only when `lastNumber` rises,
// the row is not retired and `edge_node_id` is bound. The stamp is what lets the
// claim tell a stale report (arrived before the merge) from a real regression.
//
// Assumptions:
//  - "App clock" = the clock of the API process (`Date.now()`); asserted with a
//    5 s tolerance around the merge.
//  - A report is judged against the merged `last_number` too: after a merge to 3,
//    a report of P1:2 is below it.
//  - Merging into a RETIRED run is allowed (late device batch) and must succeed.
//  - Rows are bound by a first claim with an empty report; its own effect on
//    `edge_reported_at` is not relied upon (the stamp is read after the merge).

describe("yd0h8-10 merge stamps edge_reported_at only for a rising, live, bound run", () => {
  const stampOf = async (outletId: string, prefix = "P1") =>
    rowOf(await runRows(outletId), prefix);

  /** `n` completed orders owned by `deviceId`, without receipts yet. */
  async function deviceOrders(
    outletId: string,
    deviceId: string,
    count: number,
  ): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < count; i += 1) out.push(await draftOrder(outletId));
    await asOwnerTenant(tenant.tenantId, async (client) => {
      for (const orderId of out) {
        await client.query(
          `UPDATE pos_orders SET device_id = $3 WHERE tenant_id = $1 AND order_id = $2::uuid`,
          [tenant.tenantId, ulidToUuid(orderId), deviceId],
        );
        await client.query(
          `UPDATE orders SET status = 'completed' WHERE tenant_id = $1 AND id = $2::uuid`,
          [tenant.tenantId, ulidToUuid(orderId)],
        );
      }
    });
    return out;
  }

  function receiptsOf(
    outletId: string,
    deviceId: string,
    orderIds: string[],
    prefix = "P1",
  ): PosReceipt[] {
    const at = new Date().toISOString();
    return orderIds.map(
      (orderId, index) =>
        ({
          id: randomUUID(),
          tenantId: tenant.tenantId,
          outletId,
          orderId,
          deviceId,
          number: formatReceiptNumber(prefix, index + 1),
          sequenceNumber: index + 1,
          status: "issued",
          issuedAt: at,
          voidedAt: null,
          voidReason: null,
          voidedBy: null,
          reprintCount: 0,
        }) as unknown as PosReceipt,
    );
  }

  function mergeRun(
    outletId: string,
    deviceId: string,
    lastNumber: number,
    receipts: PosReceipt[],
    prefix = "P1",
  ) {
    return inTx((tx, context) =>
      mergeDeviceReceiptRun(tx, context, {
        sequence: { outletId, deviceId, prefix, lastNumber },
        receipts,
      }),
    );
  }

  /** Cloud outlet, one device bound to edge (N, I) at P1, three merge-ready orders. */
  async function boundRun() {
    const { outletId, devices, own } = await cloudOutlet(1);
    const [deviceId] = devices as [string];
    const past = Date.now() - 600_000;
    await claim(outletId, own, new Map(), new Date(past));
    const bound = await stampOf(outletId);
    expect(bound).toMatchObject({
      edge_node_id: own.edgeNodeId,
      edge_instance_id: own.edgeInstanceId,
      retired_at: null,
      last_number: 0,
    });
    const orders = await deviceOrders(outletId, deviceId, 3);
    const receipts = receiptsOf(outletId, deviceId, orders);
    return { outletId, deviceId, own, past, receipts };
  }

  /** The first merge to 3; returns the stamp it wrote and the window around it. */
  async function mergeThree(
    setup: Awaited<ReturnType<typeof boundRun>>,
  ): Promise<Date> {
    const before = Date.now();
    await mergeRun(setup.outletId, setup.deviceId, 3, setup.receipts);
    const after = Date.now();
    const row = await stampOf(setup.outletId);
    expect(row.last_number).toBe(3);
    expect(
      row.edge_reported_at,
      "the merge must stamp edge_reported_at",
    ).not.toBeNull();
    expect(row.edge_reported_at!.getTime()).toBeGreaterThanOrEqual(
      before - 5_000,
    );
    expect(row.edge_reported_at!.getTime()).toBeLessThanOrEqual(after + 5_000);
    return row.edge_reported_at!;
  }

  it("POS-06 EDG-02 merge raises a bound run to 3, then a report of P1:2 whose time is before the stamp is stale: stale 1, no rotation", async () => {
    const setup = await boundRun();
    const stamp = await mergeThree(setup);

    const late = await claim(
      setup.outletId,
      setup.own,
      new Map([["P1", 2]]),
      new Date(stamp.getTime() - 1000),
    );
    expect(late).toMatchObject({
      regressed: 0,
      throttled: 0,
      stale: 1,
      alert: false,
    });
    const rows = await runRows(setup.outletId);
    expect(rows.map((r) => r.prefix)).toEqual(["P1"]);
    expect(rowOf(rows, "P1")).toMatchObject({
      retired_at: null,
      retired_reason: null,
      last_number: 3,
    });
    expect(regressedCount(rows)).toBe(0);
  });

  it("POS-06 EDG-02 after the same merge, a report of P1:2 whose time is after the stamp is a real regression: regressed 1, stale 0", async () => {
    const setup = await boundRun();
    const stamp = await mergeThree(setup);

    const real = await claim(
      setup.outletId,
      setup.own,
      new Map([["P1", 2]]),
      new Date(stamp.getTime() + 1000),
    );
    expect(real).toMatchObject({ regressed: 1, throttled: 0, stale: 0 });
    const rows = await runRows(setup.outletId);
    expect(rowOf(rows, "P1").retired_reason).toBe("edge_regressed");
    expect(rowOf(rows, "P2").retired_at).toBeNull();
    expect(regressedCount(rows)).toBe(1);
  });

  it("POS-06 EDG-02 a merge that raises a RETIRED run succeeds and leaves edge_reported_at as it was", async () => {
    const { outletId, devices, own } = await cloudOutlet(1);
    const [deviceId] = devices as [string];
    const base = Date.now() - 600_000;
    await claim(outletId, own, new Map(), new Date(base));
    await claim(outletId, own, new Map([["P1", 5]]), new Date(base + 10_000));
    const regression = await claim(
      outletId,
      own,
      new Map([["P1", 1]]),
      new Date(base + 20_000),
    );
    expect(regression).toMatchObject({ regressed: 1 });
    const retired = await stampOf(outletId);
    expect(retired.retired_reason).toBe("edge_regressed");
    expect(retired.edge_reported_at?.getTime()).toBe(base + 20_000);

    const orders = await deviceOrders(outletId, deviceId, 3);
    await expect(
      mergeRun(outletId, deviceId, 3, receiptsOf(outletId, deviceId, orders)),
    ).resolves.toBeDefined();

    const after = await stampOf(outletId);
    expect(after).toMatchObject({
      retired_reason: "edge_regressed",
      last_number: 3,
    });
    expect(after.edge_reported_at?.getTime()).toBe(base + 20_000);
  });

  it("POS-06 EDG-02 a replay of the merge and an older (stale) batch do not change the stamp", async () => {
    const setup = await boundRun();
    const stamp = await mergeThree(setup);

    // Same run again: lastNumber does not rise.
    await mergeRun(setup.outletId, setup.deviceId, 3, setup.receipts);
    expect((await stampOf(setup.outletId)).edge_reported_at?.getTime()).toBe(
      stamp.getTime(),
    );
    // An earlier batch of the same run (2 of 3 receipts, already stored).
    await mergeRun(
      setup.outletId,
      setup.deviceId,
      2,
      setup.receipts.slice(0, 2),
    );
    const row = await stampOf(setup.outletId);
    expect(row.last_number).toBe(3);
    expect(row.edge_reported_at?.getTime()).toBe(stamp.getTime());
  });

  it("POS-06 EDG-02 a run with no edge binding (cloud-provisioned, never claimed) is merged without any stamp", async () => {
    const outletId = await freshOutlet();
    const deviceId = (await enroll(outletId, "pos")).id;
    await inTx((tx, c) =>
      provisionReceiptSequence(tx, c, { outletId, deviceId, prefix: "P1" }),
    );
    const before = await stampOf(outletId);
    expect(before).toMatchObject({
      edge_node_id: null,
      edge_instance_id: null,
      edge_reported_at: null,
    });
    const orders = await deviceOrders(outletId, deviceId, 3);
    await mergeRun(
      outletId,
      deviceId,
      3,
      receiptsOf(outletId, deviceId, orders),
    );
    const row = await stampOf(outletId);
    expect(row.last_number).toBe(3);
    expect(row.edge_reported_at).toBeNull();
  });

  it("POS-06 EDG-02 an edge_reported_at newer than the merge clock is kept: the merge does not fail and the value stays", async () => {
    const { outletId, devices, own } = await cloudOutlet(1);
    const [deviceId] = devices as [string];
    await claim(outletId, own, new Map(), new Date(Date.now() - 600_000));
    // A forward report with a cloud time 10 min ahead of the app clock.
    const future = Date.now() + 600_000;
    await claim(outletId, own, new Map([["P1", 1]]), new Date(future));
    const primed = await stampOf(outletId);
    expect(primed.edge_reported_at?.getTime()).toBe(future);

    const orders = await deviceOrders(outletId, deviceId, 3);
    await expect(
      mergeRun(outletId, deviceId, 3, receiptsOf(outletId, deviceId, orders)),
    ).resolves.toBeDefined();
    const row = await stampOf(outletId);
    expect(row.last_number).toBe(3);
    expect(row.edge_reported_at?.getTime()).toBe(future);
  });

  // ---- legend-rh1hk: the report is read just before a merge lands (race) -------
  //
  // The edge sends its outbox link cursor `C` with the report. The cloud reads a
  // report as behind a merge only when the first link slot above `C` (mapped
  // by the peer offset) is younger than 30 s before the report token, the cursor
  // row is bound to the pulling instance, and the report is not below the
  // edge's own earlier report. Everything else keeps the full check.

  /** Link cursor row (`edge_to_cloud`) and its slots of node `own`. */
  async function seedLink(
    outletId: string,
    own: DeviceReceiptSequenceBinding,
    link: {
      instance: string | null;
      next: number;
      offset?: number;
      slots: Array<[linkSeq: number, createdAt: Date]>;
    },
  ): Promise<void> {
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query(
        `INSERT INTO sync_cursors (tenant_id, outlet_id, edge_node_id, direction, next_out_seq, acked_out_seq, received_in_seq, peer_instance_id, peer_seq_offset)
         VALUES ($1, $2, $3, 'edge_to_cloud', $4, $5, $5, $6, $5)`,
        [
          tenant.tenantId,
          outletId,
          own.edgeNodeId,
          link.next,
          link.offset ?? 0,
          link.instance,
        ],
      );
      for (const [linkSeq, createdAt] of link.slots)
        await client.query(
          `INSERT INTO edge_link_slots (tenant_id, outlet_id, edge_node_id, direction, link_seq, event_id, created_at)
           VALUES ($1, $2, $3, 'edge_to_cloud', $4, $5, $6)`,
          [
            tenant.tenantId,
            outletId,
            own.edgeNodeId,
            linkSeq,
            randomUUID(),
            createdAt,
          ],
        );
    });
  }

  /**
   * Edge reported P1:`firstReport` (high-water, default 2), then a merge raised
   * lastNumber to 3.
   * `tau` is a report token just after the merge stamp. Slots 1..5 are old;
   * slot 6 (the merge's event) is `slotAgeMs` before `tau`.
   */
  async function raceSetup(
    slotAgeMs: number,
    instance: "own" | "other" | null = "own",
    offset = 0,
    firstReport = 2,
  ) {
    const setup = await boundRun();
    await claim(
      setup.outletId,
      setup.own,
      new Map([["P1", firstReport]]),
      new Date(setup.past + 10_000),
    );
    const stamp = await mergeThree(setup);
    const tau = new Date(stamp.getTime() + 1000);
    const old = new Date(tau.getTime() - 3_600_000);
    await seedLink(setup.outletId, setup.own, {
      instance:
        instance === "own"
          ? setup.own.edgeInstanceId
          : instance === "other"
            ? randomUUID()
            : null,
      next: offset + 6,
      offset,
      slots: [1, 2, 3, 4, 5]
        .map((n) => [offset + n, old] as [number, Date])
        .concat([[offset + 6, new Date(tau.getTime() - slotAgeMs)]]),
    });
    return { ...setup, stamp, tau };
  }

  const expectKept = async (outletId: string) => {
    const rows = await runRows(outletId);
    expect(rows.map((r) => r.prefix)).toEqual(["P1"]);
    expect(rowOf(rows, "P1")).toMatchObject({
      retired_at: null,
      retired_reason: null,
      last_number: 3,
    });
    expect(regressedCount(rows)).toBe(0);
  };

  it("rh1hk race: the report P1:2 was read before the merge to 3 (cursor 5, slot 6 made 5 s before the token): no rotation, behind 1, no alert, prefix kept", async () => {
    const s = await raceSetup(5_000);
    const result = await claim(
      s.outletId,
      s.own,
      new Map([["P1", 2]]),
      s.tau,
      5,
    );
    expect(result).toMatchObject({
      regressed: 0,
      throttled: 0,
      stale: 0,
      behind: 1,
      alert: false,
    });
    await expectKept(s.outletId);
  });

  it("rh1hk race through the page: receiptRunsSeq keeps the run handed out, no alert key", async () => {
    const s = await raceSetup(5_000);
    const page = await cloudPull(s.outletId, s.own, {
      report: new Map([["P1", 2]]),
      reportSeq: 5,
      now: s.tau,
    });
    expect(page.receiptSequences?.map((q) => q.prefix)).toEqual(["P1"]);
    expect("receiptRunAlert" in page).toBe(false);
    await expectKept(s.outletId);
  });

  it("rh1hk race: the peer offset maps the edge cursor (slots stored at 100 + n)", async () => {
    const s = await raceSetup(5_000, "own", 100);
    const result = await claim(
      s.outletId,
      s.own,
      new Map([["P1", 2]]),
      s.tau,
      5,
    );
    expect(result).toMatchObject({ regressed: 0, behind: 1 });
    await expectKept(s.outletId);
  });

  it("rh1hk restore: the slot above the cursor is 10 min old (the cloud passed it before the restore): rotated as before, behind 0", async () => {
    const s = await raceSetup(600_000);
    const result = await claim(
      s.outletId,
      s.own,
      new Map([["P1", 2]]),
      s.tau,
      5,
    );
    expect(result).toMatchObject({ regressed: 1, behind: 0, stale: 0 });
    const rows = await runRows(s.outletId);
    expect(rowOf(rows, "P1").retired_reason).toBe("edge_regressed");
    expect(rowOf(rows, "P2").retired_at).toBeNull();
  });

  it("rh1hk restore within 30 s is seen one pull later: behind first, then rotated once the slot is older than the window", async () => {
    const s = await raceSetup(5_000);
    const first = await claim(
      s.outletId,
      s.own,
      new Map([["P1", 2]]),
      s.tau,
      5,
    );
    expect(first).toMatchObject({ regressed: 0, behind: 1 });
    const later = new Date(s.tau.getTime() + 31_000);
    const second = await claim(
      s.outletId,
      s.own,
      new Map([["P1", 2]]),
      later,
      5,
    );
    expect(second).toMatchObject({ regressed: 1, behind: 0 });
    expect(rowOf(await runRows(s.outletId), "P1").retired_reason).toBe(
      "edge_regressed",
    );
  });

  it("rh1hk a report below the edge's own earlier report is a regression whatever the cursor says: rotated", async () => {
    const s = await raceSetup(5_000);
    const result = await claim(
      s.outletId,
      s.own,
      new Map([["P1", 1]]),
      s.tau,
      5,
    );
    expect(result).toMatchObject({ regressed: 1, behind: 0 });
    expect(rowOf(await runRows(s.outletId), "P1").retired_reason).toBe(
      "edge_regressed",
    );
  });

  it("rh1hk a cursor row bound to another instance is ignored: rotated", async () => {
    const s = await raceSetup(5_000, "other");
    const result = await claim(
      s.outletId,
      s.own,
      new Map([["P1", 2]]),
      s.tau,
      5,
    );
    expect(result).toMatchObject({ regressed: 1, behind: 0 });
  });

  it("rh1hk a cursor row with no instance is ignored: rotated", async () => {
    const s = await raceSetup(5_000, null);
    const result = await claim(
      s.outletId,
      s.own,
      new Map([["P1", 2]]),
      s.tau,
      5,
    );
    expect(result).toMatchObject({ regressed: 1, behind: 0 });
  });

  it("rh1hk no cursor (an edge without receiptRunsSeq): the old full check, rotated even with a recent slot", async () => {
    const s = await raceSetup(5_000);
    const result = await claim(s.outletId, s.own, new Map([["P1", 2]]), s.tau);
    expect(result).toMatchObject({ regressed: 1, behind: 0 });
  });

  it("rh1hk a cursor at or above every slot has no slot above it: rotated", async () => {
    const s = await raceSetup(5_000);
    const result = await claim(
      s.outletId,
      s.own,
      new Map([["P1", 2]]),
      s.tau,
      6,
    );
    expect(result).toMatchObject({ regressed: 1, behind: 0 });
  });

  it("rh1hk clone: a recent-slot report at the edge's own high-water is behind, a twin below it rotates, and a report above the frozen high-water raises the alert", async () => {
    const s = await raceSetup(5_000);
    // (a) P1:2 is >= edge_reported_number 2 and < lastNumber 3, slot recent.
    const first = await claim(
      s.outletId,
      s.own,
      new Map([["P1", 2]]),
      s.tau,
      5,
    );
    expect(first).toMatchObject({ regressed: 0, behind: 1, alert: false });
    await expectKept(s.outletId);
    // (b) the twin reports 1, below edge_reported_number 2: a real regression.
    const twinTau = new Date(s.tau.getTime() + 2_000);
    const second = await claim(
      s.outletId,
      s.own,
      new Map([["P1", 1]]),
      twinTau,
      5,
    );
    expect(second).toMatchObject({ regressed: 1, behind: 0, alert: false });
    expect(regressedCount(await runRows(s.outletId))).toBe(1);
    // (c) a live database above the frozen high-water 2, with a newer token.
    const third = await claim(
      s.outletId,
      s.own,
      new Map([["P1", 3]]),
      new Date(s.tau.getTime() + 4_000),
      5,
    );
    expect(third.alert).toBe(true);
    expect(regressedCount(await runRows(s.outletId))).toBe(1);
  });

  it("rh1hk behind stores the higher report: edge_reported_number 1 and lastNumber 3, a report of 2 is behind and stores 2 with edge_reported_at = tau", async () => {
    const s = await raceSetup(5_000, "own", 0, 1);
    expect(rowOf(await runRows(s.outletId), "P1")).toMatchObject({
      edge_reported_number: 1,
      last_number: 3,
    });
    const result = await claim(
      s.outletId,
      s.own,
      new Map([["P1", 2]]),
      s.tau,
      5,
    );
    expect(result).toMatchObject({ regressed: 0, behind: 1, alert: false });
    const row = rowOf(await runRows(s.outletId), "P1");
    expect(row).toMatchObject({
      edge_reported_number: 2,
      last_number: 3,
      retired_at: null,
    });
    expect(row.edge_reported_at?.getTime()).toBe(s.tau.getTime());
  });

  it("rh1hk boundary: a slot exactly 30 s before the token counts as behind (the code compares created_at >= tau - 30 s)", async () => {
    const s = await raceSetup(30_000);
    const result = await claim(
      s.outletId,
      s.own,
      new Map([["P1", 2]]),
      s.tau,
      5,
    );
    expect(result).toMatchObject({ regressed: 0, behind: 1 });
    await expectKept(s.outletId);
  });

  it("rh1hk one claim, two prefixes: the one reported at its high-water is behind, the one below its own earlier report is regressed", async () => {
    const { outletId, devices, own } = await cloudOutlet(2);
    const [deviceA, deviceB] = devices as [string, string];
    const past = Date.now() - 600_000;
    await claim(outletId, own, new Map(), new Date(past));
    const prefixA = await currentPrefix(outletId, deviceA);
    const prefixB = await currentPrefix(outletId, deviceB);
    await claim(
      outletId,
      own,
      new Map([
        [prefixA, 2],
        [prefixB, 2],
      ]),
      new Date(past + 10_000),
    );
    for (const [deviceId, prefix] of [
      [deviceA, prefixA],
      [deviceB, prefixB],
    ] as const) {
      const orders = await deviceOrders(outletId, deviceId, 3);
      await mergeRun(
        outletId,
        deviceId,
        3,
        receiptsOf(outletId, deviceId, orders, prefix),
        prefix,
      );
    }
    const stamps = (await runRows(outletId))
      .filter((r) => r.retired_at === null)
      .map((r) => r.edge_reported_at!.getTime());
    const tau = new Date(Math.max(...stamps) + 1000);
    const old = new Date(tau.getTime() - 3_600_000);
    await seedLink(outletId, own, {
      instance: own.edgeInstanceId,
      next: 6,
      slots: [1, 2, 3, 4, 5]
        .map((n) => [n, old] as [number, Date])
        .concat([[6, new Date(tau.getTime() - 5_000)]]),
    });
    const result = await claim(
      outletId,
      own,
      new Map([
        [prefixA, 2],
        [prefixB, 1],
      ]),
      tau,
      5,
    );
    expect(result).toMatchObject({
      regressed: 1,
      behind: 1,
      throttled: 0,
      stale: 0,
      alert: false,
    });
    const rows = await runRows(outletId);
    expect(rowOf(rows, prefixA)).toMatchObject({
      retired_at: null,
      last_number: 3,
    });
    expect(rowOf(rows, prefixB).retired_reason).toBe("edge_regressed");
    expect(regressedCount(rows)).toBe(1);
  });

  it("rh1hk read order: the edge reads its outbox cursor BEFORE the receipt counters (a sale in between must not raise the cursor above the counters)", async () => {
    const { outletId, own } = await cloudOutlet(1);
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO sync_cursors (tenant_id, outlet_id, edge_node_id, direction, next_out_seq)
         VALUES ($1, $2, $3, 'edge_to_cloud', 7)`,
        [tenant.tenantId, outletId, own.edgeNodeId],
      ),
    );
    const real = receiptService.localReceiptRunReport;
    const spy = vi
      .spyOn(receiptService, "localReceiptRunReport")
      .mockImplementation(async (...args) => {
        // A receipt event is queued (committed) right before the counters read.
        await asOwnerTenant(tenant.tenantId, (client) =>
          client.query(
            `UPDATE sync_cursors SET next_out_seq = 99 WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud'`,
            [tenant.tenantId, own.edgeNodeId],
          ),
        );
        return real(...args);
      });
    try {
      const seen: Array<number | undefined> = [];
      await inEdgeMode(() =>
        pullDeviceRegistry({
          context: edgeScope(outletId),
          role: "primary",
          binding: own,
          fetchPage: async (_since, _runs, _refusals, receiptRunsSeq) => {
            seen.push(receiptRunsSeq);
            return {
              data: [],
              meta: { limit: 100, nextCursor: null, watermark: null },
            };
          },
        }),
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([7]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("rh1hk a failed cursor read never costs the report", () => {
  it("the pull sends the report without a cursor (undefined) when the sync_cursors read fails, and logs only the error name", async () => {
    const { outletId, own } = await cloudOutlet(1);
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO sync_cursors (tenant_id, outlet_id, edge_node_id, direction, next_out_seq)
         VALUES ($1, $2, $3, 'edge_to_cloud', 7)`,
        [tenant.tenantId, outletId, own.edgeNodeId],
      ),
    );
    const policy = `rh1hk_fail_${randomUUID().slice(0, 8)}`;
    // Test-only: reading this tenant's cursor rows fails (division by zero),
    // for the app role only; dropped in `finally`.
    await owner.query(
      `CREATE POLICY ${policy} ON sync_cursors AS RESTRICTIVE FOR SELECT TO legend_app
       USING (1 / (CASE WHEN tenant_id = '${tenant.tenantId}'::uuid THEN 0 ELSE 1 END) = 1)`,
    );
    const logged = vi.spyOn(logger, "error");
    try {
      const seen: Array<{
        runs: ReceiptRunReport | undefined;
        seq: number | undefined;
      }> = [];
      await inEdgeMode(() =>
        pullDeviceRegistry({
          context: edgeScope(outletId),
          role: "primary",
          binding: own,
          fetchPage: async (_since, runs, _refusals, receiptRunsSeq) => {
            seen.push({ runs, seq: receiptRunsSeq });
            return {
              data: [],
              meta: { limit: 100, nextCursor: null, watermark: null },
            };
          },
        }),
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]!.seq).toBeUndefined();
      expect(seen[0]!.runs).toBeInstanceOf(Map);
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({
          edgeNodeId: own.edgeNodeId,
          errorName: expect.any(String),
        }),
        expect.stringContaining("cursor read failed"),
      );
      for (const call of logged.mock.calls)
        expect(JSON.stringify(call)).not.toMatch(/division by zero/i);
    } finally {
      logged.mockRestore();
      await owner.query(`DROP POLICY IF EXISTS ${policy} ON sync_cursors`);
    }
  });
});

describe("rh1hk the receiptRunsSeq query parameter is parsed strictly", () => {
  const parse = (receiptRunsSeq: string, withRuns = true) =>
    deviceSyncQuerySchema.safeParse({
      limit: 100,
      receiptSequences: "1",
      ...(withRuns ? { receiptRuns: "P1:1" } : {}),
      receiptRunsSeq,
    });

  it("accepts 0 and up to 15 digits without a leading zero, keeps the string, and a second parse accepts the first output", () => {
    for (const ok of ["0", "5", "123456789012345"])
      expect(parse(ok).success, ok).toBe(true);
    const first = deviceSyncQuerySchema.parse({
      limit: 100,
      receiptSequences: "1",
      receiptRuns: "P1:1",
      receiptRunsSeq: "42",
    });
    expect(first.receiptRunsSeq).toBe("42");
    expect(deviceSyncQuerySchema.parse(first)).toEqual(first);
  });

  it("refuses an empty, signed, padded, fractional, exponent, too long or non-numeric value", () => {
    expect(parse("5").success).toBe(true);
    for (const bad of [
      "",
      "-1",
      "+1",
      "01",
      "1.5",
      "1e3",
      "1234567890123456",
      " 5",
      "abc",
    ])
      expect(parse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("refuses receiptRunsSeq without receiptRuns", () => {
    expect(parse("5", false).success).toBe(false);
  });
});
