// Receipt number write-offs pulled to the edge (bead legend-jcby0; the write-off
// itself is legend-0hzqw).
//
// Problem: an owner writes a lost receipt number off on the CLOUD, but the edge
// database never received the row, so Tutup Hari on the edge stayed refused with
// RECEIPT_SEQUENCE_GAP. The fix copies the cloud's write-off rows into the edge's
// own `receipt_number_writeoffs` through the device-registry pull. Opt-in like
// `receiptSequences`: query `receiptWriteoffs=1` -> page field `receiptWriteoffs`
// (the outlet's full list on every page); pull result fields
// `receiptWriteoffsInserted` / `receiptWriteoffsSkipped` / `receiptWriteoffsRefused`.
//
// Written against docs/briefs/sub-receipt-writeoff-edge-sync.md (Design + Section
// T). Real PostgreSQL with RLS. As in pos-receipt-seq-edge.test.ts the "edge"
// database is the cloud database: the simulated edge is ANOTHER OUTLET of the same
// tenant, and a page the cloud made for the cloud outlet is shipped to the edge
// outlet by rewriting outlet id, write-off ids and sequence ids (ids are unique per
// database). Day close, gap and late-receipt helpers are copied from
// pos-receipt-writeoff.test.ts (not edited there).
//
// Assumptions:
//  - The cloud write-off is a direct insert in a tenant transaction (the 0156
//    trigger still checks it), not the HTTP service: the service/route is covered
//    by pos-receipt-writeoff.test.ts and needs an MFA-verified owner session.
//  - The cloud run behind a write-off is a bare `receipt_sequences` row (no
//    receipts, `last_number` set, unbound). The cloud pull sends no `edgeInstance`,
//    so the cloud claims or rotates nothing and the write-off list is the only
//    thing under test; the page still carries `receiptSequences=1` like a real
//    edge, and the write-off field is independent of the sequence claim.
//  - Tutup Hari "on the edge" is the real POST .../pos/day/close on the edge
//    outlet with the edge outlet's local rows; it is not run with the edge flag
//    on (the gap check reads only local rows and does not depend on the mode).
//  - Pull result counts: a row whose receipt already exists on the edge, a run the
//    edge does not hold, and a number above the edge run's last_number are
//    `Skipped`; a forged list (row of another outlet) is `Refused` as a whole,
//    asserted as ">= 1" because the brief does not say whether the count is per
//    row or per list. A repeat pull is only asserted by "0 inserted, 1 row".
//  - The "other tenant" row is a forged row whose `sequenceId` is a run of another
//    tenant: invisible under RLS, so it is skipped and the good rows still land.
//
// Fix round 1 (docs/briefs/sub-receipt-writeoff-edge-sync-fix1.md, Section T2)
// adds the last describe blocks. Further assumptions:
//  - A write-off the pre-checks skip (other prefix, run not held, late receipt,
//    already copied) counts in `receiptWriteoffsSkipped` (the "missed" warn log
//    is only a log, not a count).
//  - A non-23514 insert error is built with a NUL character in `reason`: it
//    passes the zod schema (a plain string of 10..500) but PostgreSQL text
//    refuses it. The brief says the whole list is refused, so nothing of it may
//    be stored, even a good row listed before the bad one.
//  - The 23514 trigger skip is NOT tested: every condition the 0156 trigger
//    checks (run held, same prefix, number <= last_number, no receipt holding the
//    number) is already caught by the pre-checks, so the trigger can only fire in
//    a race between the pre-check and the insert, which a test cannot build
//    without a hook inside the service. It is also not worth a direct call of
//    `applyDeviceReceiptWriteoffs` (its signature is not in the spec).
//  - The cap test inserts 1001 write-offs with one SQL statement, created_at one
//    second apart, so the oldest is number 1 and the newest number 1001.
//
// Run just the edge repro:
//   LEGEND_TEST_FILES="src/test/edge-pull-writeoffs.test.ts" pnpm test -t "EDGE-REPRO"
// Run the whole file:
//   LEGEND_TEST_FILES="src/test/edge-pull-writeoffs.test.ts" pnpm test

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
  RECEIPT_WRITEOFF_SYNC_MAX,
  deviceSyncPageSchema,
  deviceSyncRecordSchema,
  type DeviceReceiptSequenceBinding,
  type DeviceSyncPage,
} from "@starter/shared/edge";
import { formatReceiptNumber } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import {
  deviceSyncQuerySchema,
  listDeviceRecordsSince,
  pullDeviceRegistry,
} from "../services/edge-device-sync.ts";
import {
  receiptGapsForDevice,
  receiptGapsForOutletFast,
} from "../services/pos-receipt.service.ts";
import {
  setPosOutletReceiptGapsPort,
  setPosReceiptGapsPort,
} from "../services/pos-shift-ports.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;
const REASON = "Struk hilang bersama printer yang rusak";
const SEED_SNAPSHOT = JSON.stringify({
  outletName: "Cafe Legend Senopati",
  outletAddress: "Jl. Kopi Legenda No. 12, Jakarta Selatan",
  legalName: null,
  npwpLast4: null,
});

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  cashierRole: randomUUID(),
  managerRole: randomUUID(),
};

type Binding = DeviceReceiptSequenceBinding;
type Member = { client: ReturnType<typeof agent>; userId: string };

let app: Express;
let tenant: IsolatedTenant;
let other: IsolatedTenant;
let headers: { Host: string };
let cashier: Member;
let manager: Member;
const cloudState = getEdgeRuntimeState();

const errorCode = (body: { error?: { code?: string }; code?: string }) =>
  body.error?.code ?? body.code;
const holeMessage = (...numbers: string[]) =>
  `Ada nomor struk yang hilang di outlet ini: ${numbers.join(", ")}.`;

// ---- Fixtures (copied from pos-receipt-writeoff.test.ts) ----------------------

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

async function member(roleId: string, label: string): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return { client, userId };
}

/** An outlet of tenant `t` without a price list (no draft can be made there). */
async function bareOutlet(t: IsolatedTenant = tenant): Promise<string> {
  const outletId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Cafe Legend Senopati', 'Jl. Kopi Legenda No. 12, Jakarta Selatan', 'Asia/Jakarta', $6, 'active')`,
    [
      outletId,
      t.tenantId,
      t.brandId,
      t.legalEntityId,
      `E${outletId.slice(0, 8)}`.toUpperCase(),
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  return outletId;
}

/** An outlet with its own price list, so a draft can be made there. */
async function freshOutlet(): Promise<string> {
  const outletId = await bareOutlet();
  const priceListId = randomUUID();
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

function closeDay(outletId: string, businessDate: string) {
  return manager.client
    .post(`/api/outlets/${encodeURIComponent(outletId)}/pos/day/close`)
    .set(headers)
    .set(originHeader)
    .send({
      businessDate,
      inventoryDeduction: false,
      idempotencyKey: randomUUID(),
    });
}

type RunSeed = {
  prefix: string;
  lastNumber: number;
  present: number[];
  /** Offset in minutes before now, so runs have a stable age order. */
  ageMinutes: number;
  /** Set for a retired run; omitted for the current run. */
  retired?: { reason: string; edgeReportedNumber: number };
};

/**
 * Owner-side seed: one device with several runs. Every receipt gets its own
 * zero-value completed order. `daysBefore` moves those orders to an earlier
 * business date, so the device has no activity on the closing date.
 */
async function seedDevice(
  outletId: string,
  runs: RunSeed[],
  options: { daysBefore?: number } = {},
): Promise<{ deviceId: string; businessDate: string }> {
  const deviceId = randomUUID();
  const daysBefore = options.daysBefore ?? 0;
  const total = runs.reduce((sum, run) => sum + run.present.length, 0);
  const orderIds: string[] = [];
  for (let n = 0; n < total; n += 1) orderIds.push(await draftOrder(outletId));
  let next = 0;
  const businessDate = await asOwnerTenant(tenant.tenantId, async (client) => {
    let date = "";
    for (const run of runs) {
      const sequenceId = randomUUID();
      await client.query(
        `INSERT INTO receipt_sequences
           (id, tenant_id, outlet_id, device_id, prefix, last_number,
            edge_reported_number, retired_at, retired_reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 CASE WHEN $8::text IS NULL THEN NULL ELSE now() END,
                 $8::text,
                 now() - ($9::int * interval '1 minute'))`,
        [
          sequenceId,
          tenant.tenantId,
          outletId,
          deviceId,
          run.prefix,
          run.lastNumber,
          run.retired?.edgeReportedNumber ?? 0,
          run.retired?.reason ?? null,
          run.ageMinutes,
        ],
      );
      for (const ordinal of run.present) {
        const orderUuid = ulidToUuid(orderIds[next]!);
        next += 1;
        await client.query(
          `UPDATE pos_orders SET device_id = $3 WHERE tenant_id = $1 AND order_id = $2::uuid`,
          [tenant.tenantId, orderUuid, deviceId],
        );
        const done = await client.query<{ business_date: string }>(
          `UPDATE orders
              SET subtotal_idr = 0, discount_idr = 0, service_charge_idr = 0,
                  tax_idr = 0, rounding_idr = 0, total_idr = 0, status = 'completed',
                  business_date = business_date - $3::int
            WHERE tenant_id = $1 AND id = $2::uuid
            RETURNING business_date::text AS business_date`,
          [tenant.tenantId, orderUuid, daysBefore],
        );
        date = done.rows[0]!.business_date;
        await client.query(
          `INSERT INTO pos_receipts
             (tenant_id, outlet_id, order_id, sequence_id, device_id, number, sequence_number, status, issued_at, outlet_snapshot)
           VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, 'issued', now(), $8::jsonb)`,
          [
            tenant.tenantId,
            outletId,
            orderUuid,
            sequenceId,
            deviceId,
            formatReceiptNumber(run.prefix, ordinal),
            ordinal,
            SEED_SNAPSHOT,
          ],
        );
      }
    }
    return date;
  });
  return { deviceId, businessDate };
}

/** The active device: one clean run, completed orders on the closing date. */
function seedActiveDevice(outletId: string) {
  return seedDevice(outletId, [
    { prefix: "AC", lastNumber: 2, present: [1, 2], ageMinutes: 10 },
  ]);
}

/** An open shift of the device (owner SQL; the shift report reads it). */
async function openShift(
  outletId: string,
  deviceId: string,
  businessDate: string,
): Promise<string> {
  const shiftId = randomUUID();
  await owner.query(
    `INSERT INTO pos_shifts
       (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
        opened_at, opening_float_idr, open_key, open_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', now(), 100000, $7, $8)`,
    [
      shiftId,
      tenant.tenantId,
      outletId,
      deviceId,
      cashier.userId,
      businessDate,
      randomUUID(),
      "0".repeat(64),
    ],
  );
  return shiftId;
}

type ShiftGap = { prefix: string; missing: number[]; writtenOff?: string[] };

async function shiftReportGaps(
  outletId: string,
  deviceId: string,
  businessDate: string,
): Promise<ShiftGap[]> {
  const shiftId = await openShift(outletId, deviceId, businessDate);
  const report = await cashier.client
    .get(
      `/api/outlets/${encodeURIComponent(outletId)}/pos/shifts/${encodeURIComponent(shiftId)}`,
    )
    .set(headers)
    .set(originHeader);
  expect(report.status, JSON.stringify(report.body)).toBe(200);
  return report.body.data.receiptGaps as ShiftGap[];
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

/** Sequences of the outlet that miss ordinals (what the outlet gap port reports). */
async function outletGaps(outletId: string) {
  const context = tenantContext(tenant.tenantId);
  return withTenant(db, context, (tx) =>
    receiptGapsForOutletFast(tx as never, context, outletId),
  );
}

/**
 * Owner SQL: a receipt for `ordinal` arrives after the fact (a device synced
 * late), on the run `prefix` of the outlet. Same shape as seedDevice's rows.
 */
async function insertLateReceipt(
  outletId: string,
  prefix: string,
  ordinal: number,
  daysBefore = 1,
) {
  const orderId = await draftOrder(outletId);
  const orderUuid = ulidToUuid(orderId);
  const { rows } = await owner.query<{ id: string; device_id: string }>(
    `SELECT id, device_id FROM receipt_sequences
      WHERE tenant_id = $1 AND outlet_id = $2 AND prefix = $3`,
    [tenant.tenantId, outletId, prefix],
  );
  const sequence = rows[0]!;
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `UPDATE pos_orders SET device_id = $3 WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [tenant.tenantId, orderUuid, sequence.device_id],
    );
    await client.query(
      `UPDATE orders
          SET subtotal_idr = 0, discount_idr = 0, service_charge_idr = 0,
              tax_idr = 0, rounding_idr = 0, total_idr = 0, status = 'completed',
              business_date = business_date - $3::int
        WHERE tenant_id = $1 AND id = $2::uuid`,
      [tenant.tenantId, orderUuid, daysBefore],
    );
    await client.query(
      `INSERT INTO pos_receipts
         (tenant_id, outlet_id, order_id, sequence_id, device_id, number, sequence_number, status, issued_at, outlet_snapshot)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, 'issued', now(), $8::jsonb)`,
      [
        tenant.tenantId,
        outletId,
        orderUuid,
        sequence.id,
        sequence.device_id,
        formatReceiptNumber(prefix, ordinal),
        ordinal,
        SEED_SNAPSHOT,
      ],
    );
  });
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

// ---- Cloud side: runs and write-offs (direct inserts, the 0156 trigger checks) ---

/** A bare `receipt_sequences` row (no receipts); returns its id. */
async function cloudRun(
  outletId: string,
  prefix: string,
  lastNumber: number,
  t: IsolatedTenant = tenant,
): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant(t.tenantId, (client) =>
    client.query(
      `INSERT INTO receipt_sequences (id, tenant_id, outlet_id, device_id, prefix, last_number)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, t.tenantId, outletId, randomUUID(), prefix, lastNumber],
    ),
  );
  return id;
}

/** The cloud's write-off of `prefix`-`sequenceNumber`; returns the row. */
async function cloudWriteOff(
  outletId: string,
  sequenceId: string,
  prefix: string,
  sequenceNumber: number,
  options: {
    t?: IsolatedTenant;
    createdAt?: Date;
    reason?: string;
    writtenOffBy?: string;
  } = {},
) {
  const t = options.t ?? tenant;
  const row = {
    id: randomUUID(),
    writtenOffBy: options.writtenOffBy ?? randomUUID(),
    reason: options.reason ?? REASON,
    // Millisecond precision so the ISO string of the page equals the column.
    createdAt: options.createdAt ?? new Date(Date.now() - 3_600_000),
  };
  await asOwnerTenant(t.tenantId, (client) =>
    client.query(
      `INSERT INTO receipt_number_writeoffs
         (id, tenant_id, outlet_id, sequence_id, prefix, sequence_number, reason, written_off_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        row.id,
        t.tenantId,
        outletId,
        sequenceId,
        prefix,
        sequenceNumber,
        row.reason,
        row.writtenOffBy,
        row.createdAt,
      ],
    ),
  );
  return { ...row, outletId, sequenceId, prefix, sequenceNumber };
}

type StoredWriteoff = {
  id: string;
  sequence_id: string;
  prefix: string;
  sequence_number: number;
  reason: string;
  written_off_by: string;
  created_at: Date;
};

/** The edge database's own write-off rows for its outlet. */
async function writeoffRows(outletId: string): Promise<StoredWriteoff[]> {
  const { rows } = await owner.query<StoredWriteoff>(
    `SELECT id, sequence_id, prefix, sequence_number, reason, written_off_by, created_at
       FROM receipt_number_writeoffs
      WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY prefix, sequence_number`,
    [tenant.tenantId, outletId],
  );
  return rows;
}

async function sequenceIdOf(outletId: string, prefix: string) {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM receipt_sequences
      WHERE tenant_id = $1 AND outlet_id = $2 AND prefix = $3`,
    [tenant.tenantId, outletId, prefix],
  );
  return rows[0]!.id;
}

// ---- The simulated cloud + edge pair ------------------------------------------------

/**
 * A cloud outlet with a primary node, an edge outlet (the simulated edge
 * database) with an active clean device, and the id maps used when a cloud
 * page is shipped to the edge.
 */
async function scenario() {
  const cloudOutletId = await freshOutlet();
  const edgeOutletId = await freshOutlet();
  const nodeId = randomUUID();
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash)
       VALUES ($1, $2, $3, 'primary', 'active', 'Server lokal', $4)`,
      [nodeId, tenant.tenantId, cloudOutletId, "a".repeat(64)],
    ),
  );
  const own: Binding = { edgeNodeId: nodeId, edgeInstanceId: randomUUID() };
  const active = await seedActiveDevice(edgeOutletId);

  /** cloud id -> id used on the edge database (stable across pulls). */
  const edgeIds = new Map<string, string>();
  const edgeId = (cloudId: string) => {
    if (!edgeIds.has(cloudId)) edgeIds.set(cloudId, randomUUID());
    return edgeIds.get(cloudId)!;
  };
  /** cloud run id -> the edge's own run id (preset for runs the edge holds). */
  const runMap = new Map<string, string>();

  /** The cloud answering one pull (no `edgeInstance`: it claims nothing). */
  function cloudPage(
    options: { writeoffs?: boolean; since?: string | null } = {},
  ): Promise<DeviceSyncPage> {
    const query = deviceSyncQuerySchema.parse({
      limit: 100,
      receiptSequences: "1",
      ...(options.writeoffs === false ? {} : { receiptWriteoffs: "1" }),
      ...(options.since ? { since: options.since } : {}),
    });
    return listDeviceRecordsSince(
      {
        tenantId: tenant.tenantId as TenantId,
        outletId: outletIdSchema.parse(cloudOutletId),
        edgeNodeId: nodeId,
      },
      query,
      { now: new Date(Date.now() + 10 * 60_000), settleMs: 0 },
    );
  }

  /** What the edge database receives: ids and outlet moved to the edge. */
  function ship(page: DeviceSyncPage): Record<string, unknown> {
    const raw = page as DeviceSyncPage & {
      receiptWriteoffs?: Array<Record<string, unknown> & { id: string }>;
    };
    const { receiptWriteoffs, ...rest } = raw;
    return {
      ...rest,
      // Device records belong to the cloud outlet; only write-offs are shipped.
      data: [],
      receiptSequences: [],
      ...(receiptWriteoffs
        ? {
            receiptWriteoffs: receiptWriteoffs.map((w) => ({
              ...w,
              id: edgeId(w.id),
              sequenceId:
                runMap.get(w.sequenceId as string) ??
                edgeId(w.sequenceId as string),
              outletId: edgeOutletId,
            })),
          }
        : {}),
    };
  }

  /** This edge database's own `edge_nodes` row (as the other seq-edge tests do). */
  async function localNode() {
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash, instance_id)
         VALUES ($1, $2, $3, 'primary', 'active', 'Server lokal', $4, $5)
         ON CONFLICT (id) DO UPDATE SET instance_id = EXCLUDED.instance_id`,
        [
          nodeId,
          tenant.tenantId,
          edgeOutletId,
          "b".repeat(64),
          own.edgeInstanceId,
        ],
      ),
    );
  }

  /** The edge applies `shipped` through the real pull. */
  async function applyOnEdge(
    shipped: unknown,
    options: { role?: "primary" | "standby"; binding?: Binding | null } = {},
  ) {
    await localNode();
    const binding = options.binding === undefined ? own : options.binding;
    return inEdgeMode(() =>
      pullDeviceRegistry({
        context: edgeScope(edgeOutletId),
        role: options.role ?? "primary",
        ...(binding ? { binding } : {}),
        fetchPage: async () => shipped,
      }),
    );
  }

  /** One full edge pull: ask the cloud (cloud mode), ship, apply on the edge. */
  async function pull(options: { writeoffs?: boolean } = {}) {
    const page = await cloudPage(options);
    const shipped = ship(page);
    const result = await applyOnEdge(shipped);
    return { page, shipped, result };
  }

  /**
   * A run both databases hold: the edge's copy is retired with receipts 1 and 3
   * (hole 2, last_number 3), the cloud's copy has `cloudLast` and no receipts.
   */
  async function holeRun(prefix: string, cloudLast = 3) {
    const idle = await seedDevice(
      edgeOutletId,
      [
        {
          prefix,
          lastNumber: 3,
          present: [1, 3],
          ageMinutes: 60,
          retired: { reason: "claim_rotated", edgeReportedNumber: 0 },
        },
      ],
      { daysBefore: 1 },
    );
    const edgeRunId = await sequenceIdOf(edgeOutletId, prefix);
    const cloudRunId = await cloudRun(cloudOutletId, prefix, cloudLast);
    runMap.set(cloudRunId, edgeRunId);
    return { idle, edgeRunId, cloudRunId };
  }

  return {
    cloudOutletId,
    edgeOutletId,
    nodeId,
    own,
    closingDate: active.businessDate,
    cloudPage,
    ship,
    applyOnEdge,
    localNode,
    pull,
    holeRun,
    edgeId,
    runMap,
    /** Tutup Hari on the edge database. */
    closeEdgeDay: () => closeDay(edgeOutletId, active.businessDate),
  };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

function scoped(
  tenantId: string,
  source: "session" | "device",
  outletId: string,
): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source,
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );
}
const edgeScope = (outletId: string) =>
  scoped(tenant.tenantId, "device", outletId);

/** The page's write-off list, empty when the field is absent. */
const writeoffsOf = (page: DeviceSyncPage) =>
  (
    page as DeviceSyncPage & {
      receiptWriteoffs?: Array<Record<string, unknown>>;
    }
  ).receiptWriteoffs;

async function expectGapRefused(s: Scenario, prefix: string) {
  const refused = await s.closeEdgeDay();
  expect(refused.status, JSON.stringify(refused.body)).toBe(409);
  expect(errorCode(refused.body)).toBe("RECEIPT_SEQUENCE_GAP");
  expect(refused.body.error?.message ?? refused.body.message).toBe(
    holeMessage(formatReceiptNumber(prefix, 2)),
  );
}

// ---- Setup ------------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  // Same wiring as app.ts (legend-ain0); other test files reset it to null.
  setPosReceiptGapsPort(receiptGapsForDevice);
  setPosOutletReceiptGapsPort((tx, context, { outletId }) =>
    receiptGapsForOutletFast(tx, context, outletId),
  );
  tenant = await createIsolatedTenant(`ewo-${randomUUID().slice(0, 6)}`);
  other = await createIsolatedTenant(`ewp-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  const roles: [string, string, string[]][] = [
    [
      ids.cashierRole,
      "Kasir Edge Write-off",
      ["order.view", "pos.sale.create", "shift.cash.operate"],
    ],
    [ids.managerRole, "Manajer Edge Write-off", ["pos.day.close"]],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  cashier = await member(ids.cashierRole, "Kasir Edge Writeoff");
  manager = await member(ids.managerRole, "Manajer Edge Writeoff");
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Edge Write-off Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    // A draft needs published tax settings and a rule for the item.
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-EWO', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
  });
}, 120_000);

afterEach(() => {
  setEdgeRuntimeStateForTests(cloudState);
});

afterAll(async () => {
  setEdgeRuntimeStateForTests(cloudState);
  setPosReceiptGapsPort(null);
  setPosOutletReceiptGapsPort(null);
  // Final orders and write-off rows are immutable, so the isolated tenants stay
  // in the disposable database; give them a valid creator for the tenant list.
  for (const t of [tenant, other])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      t.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

// ---- Cases ------------------------------------------------------------------------

describe("EDGE-REPRO a write-off made on the cloud reaches the edge and unblocks its Tutup Hari (legend-jcby0)", () => {
  it("EDGE-REPRO POS-06 EDG-02 edge run with receipts 1 and 3 (hole 2), write-off of 2 on the cloud: refused before the pull, Tutup Hari closes after it", async () => {
    const s = await scenario();
    const { idle, cloudRunId } = await s.holeRun("EA");
    const writeoff = await cloudWriteOff(s.cloudOutletId, cloudRunId, "EA", 2);

    // The edge's gap check only counts its own rows: the cloud's write-off does
    // not help yet (this part passes with and without the fix).
    expect(await outletGaps(s.edgeOutletId)).toEqual([
      expect.objectContaining({ prefix: "EA", missing: [2] }),
    ]);
    await expectGapRefused(s, "EA");

    const pulled = await s.pull();
    expect(writeoffsOf(pulled.page)?.map((w) => w.id)).toEqual([writeoff.id]);
    expect(pulled.result).toMatchObject({
      receiptWriteoffsInserted: 1,
      receiptWriteoffsSkipped: 0,
      receiptWriteoffsRefused: 0,
    });

    // The edge now owns a copy of the row, for its own run.
    const rows = await writeoffRows(s.edgeOutletId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: s.edgeId(writeoff.id),
      sequence_id: s.runMap.get(cloudRunId),
      prefix: "EA",
      sequence_number: 2,
      reason: REASON,
      written_off_by: writeoff.writtenOffBy,
    });
    expect(rows[0]!.created_at.toISOString()).toBe(
      writeoff.createdAt.toISOString(),
    );

    // The edge gap port no longer lists the number, and Tutup Hari closes.
    expect(await outletGaps(s.edgeOutletId)).toEqual([]);
    const closed = await s.closeEdgeDay();
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    // The shift report names the number as written off, not as missing.
    expect(
      await shiftReportGaps(s.edgeOutletId, idle.deviceId, s.closingDate),
    ).toEqual([
      expect.objectContaining({
        prefix: "EA",
        missing: [],
        writtenOff: [formatReceiptNumber("EA", 2)],
      }),
    ]);
  });

  it("POS-06 EDG-02 offline after the pull: a later Tutup Hari on the edge needs no further pull", async () => {
    const s = await scenario();
    const { cloudRunId } = await s.holeRun("EB");
    await cloudWriteOff(s.cloudOutletId, cloudRunId, "EB", 2);

    await expectGapRefused(s, "EB");
    const pulled = await s.pull();
    expect(pulled.result).toMatchObject({ receiptWriteoffsInserted: 1 });

    // No more contact with the cloud: the edge's own row is all it needs.
    const closed = await s.closeEdgeDay();
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  });

  it("POS-06 EDG-02 without the pull the write-off stays on the cloud: an old-style page (no write-off field) changes nothing on the edge", async () => {
    const s = await scenario();
    const { cloudRunId } = await s.holeRun("EC");
    await cloudWriteOff(s.cloudOutletId, cloudRunId, "EC", 2);

    const pulled = await s.pull({ writeoffs: false });
    expect(pulled.result).toMatchObject({
      receiptWriteoffsInserted: 0,
      receiptWriteoffsSkipped: 0,
      receiptWriteoffsRefused: 0,
    });
    expect(await writeoffRows(s.edgeOutletId)).toEqual([]);
    await expectGapRefused(s, "EC");
  });
});

describe("late receipts on the edge (a late receipt cancels the write-off)", () => {
  it("POS-06 receipt 2 arrives on the edge after the write-off was copied: the gap check passes, the number is counted once and is not reported as written off", async () => {
    const s = await scenario();
    const { idle, cloudRunId } = await s.holeRun("ED");
    await cloudWriteOff(s.cloudOutletId, cloudRunId, "ED", 2);
    expect((await s.pull()).result).toMatchObject({
      receiptWriteoffsInserted: 1,
    });
    expect(await outletGaps(s.edgeOutletId)).toEqual([]);

    await insertLateReceipt(s.edgeOutletId, "ED", 2);

    // Receipts 1, 2 and 3 plus the now-moot write-off: complete, no gap.
    expect(await outletGaps(s.edgeOutletId)).toEqual([]);
    const closed = await s.closeEdgeDay();
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    const gaps = await shiftReportGaps(
      s.edgeOutletId,
      idle.deviceId,
      s.closingDate,
    );
    const entry = gaps.find((gap) => gap.prefix === "ED");
    // No entry at all is as good as an entry that lists nothing.
    if (entry) {
      expect(entry.missing).toEqual([]);
      expect(entry.writtenOff ?? []).toEqual([]);
    }

    // The number exists once as a receipt; the record of the write-off stays.
    const { rows: receipts } = await owner.query(
      `SELECT 1 FROM pos_receipts WHERE tenant_id = $1 AND outlet_id = $2
          AND number = $3`,
      [tenant.tenantId, s.edgeOutletId, formatReceiptNumber("ED", 2)],
    );
    expect(receipts).toHaveLength(1);
    expect(await writeoffRows(s.edgeOutletId)).toHaveLength(1);
  });

  it("POS-06 a pull when the edge already holds receipt 2 skips the row: nothing is inserted, the run stays complete", async () => {
    const s = await scenario();
    const { cloudRunId } = await s.holeRun("EE");
    await cloudWriteOff(s.cloudOutletId, cloudRunId, "EE", 2);
    await insertLateReceipt(s.edgeOutletId, "EE", 2);

    const pulled = await s.pull();
    expect(pulled.result).toMatchObject({
      receiptWriteoffsInserted: 0,
      receiptWriteoffsSkipped: 1,
      receiptWriteoffsRefused: 0,
    });
    expect(await writeoffRows(s.edgeOutletId)).toEqual([]);
    expect(await outletGaps(s.edgeOutletId)).toEqual([]);
    const closed = await s.closeEdgeDay();
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  });
});

describe("idempotent pulls", () => {
  it("POS-06 EDG-02 two pulls leave exactly one edge row per write-off, and Tutup Hari still closes", async () => {
    const s = await scenario();
    const { cloudRunId } = await s.holeRun("EF");
    const first = await cloudWriteOff(s.cloudOutletId, cloudRunId, "EF", 2);

    const one = await s.pull();
    expect(one.result).toMatchObject({ receiptWriteoffsInserted: 1 });
    const two = await s.pull();
    expect(two.result).toMatchObject({
      receiptWriteoffsInserted: 0,
      receiptWriteoffsRefused: 0,
    });
    const rows = await writeoffRows(s.edgeOutletId);
    expect(rows.map((r) => [r.prefix, r.sequence_number])).toEqual([["EF", 2]]);
    expect(rows[0]!.id).toBe(s.edgeId(first.id));

    const closed = await s.closeEdgeDay();
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  });
});

describe("isolation: only this outlet's write-offs reach this edge", () => {
  it("EDG-02 TEN-01 a write-off of another outlet of the same tenant and one of another tenant are not in the page nor on the edge", async () => {
    const s = await scenario();
    const { cloudRunId } = await s.holeRun("EG");
    const mine = await cloudWriteOff(s.cloudOutletId, cloudRunId, "EG", 2);

    // Another outlet of the same tenant, with a write-off of its own.
    const siblingOutlet = await bareOutlet();
    const siblingRun = await cloudRun(siblingOutlet, "EH", 3);
    const sibling = await cloudWriteOff(siblingOutlet, siblingRun, "EH", 2);

    // Another tenant, with a write-off of its own.
    const foreignOutlet = await bareOutlet(other);
    const foreignRun = await cloudRun(foreignOutlet, "EI", 3, other);
    const foreign = await cloudWriteOff(foreignOutlet, foreignRun, "EI", 2, {
      t: other,
    });

    const pulled = await s.pull();
    const listed = writeoffsOf(pulled.page) ?? [];
    expect(listed.map((w) => w.id)).toEqual([mine.id]);
    expect(listed.map((w) => w.id)).not.toContain(sibling.id);
    expect(listed.map((w) => w.id)).not.toContain(foreign.id);

    const rows = await writeoffRows(s.edgeOutletId);
    expect(rows.map((r) => r.prefix)).toEqual(["EG"]);
    // Neither foreign write-off was copied anywhere.
    expect(await writeoffRows(siblingOutlet)).toHaveLength(1);
    const { rows: leaked } = await owner.query(
      `SELECT 1 FROM receipt_number_writeoffs WHERE prefix IN ('EH', 'EI')
          AND outlet_id = $1`,
      [s.edgeOutletId],
    );
    expect(leaked).toEqual([]);
  });

  it("EDG-02 TEN-01 a forged list that contains a row of another outlet is refused as a whole: not even the good row is inserted", async () => {
    const s = await scenario();
    const { cloudRunId } = await s.holeRun("EJ");
    await cloudWriteOff(s.cloudOutletId, cloudRunId, "EJ", 2);
    const page = await s.cloudPage();
    const shipped = s.ship(page) as {
      receiptWriteoffs: Array<Record<string, unknown>>;
    };
    const good = shipped.receiptWriteoffs[0]!;
    const elsewhere = await bareOutlet();
    const forged = {
      ...shipped,
      receiptWriteoffs: [
        good,
        { ...good, id: randomUUID(), outletId: elsewhere, sequenceNumber: 3 },
      ],
    };

    const result = await s.applyOnEdge(forged);
    expect(result.receiptWriteoffsInserted).toBe(0);
    expect(result.receiptWriteoffsRefused).toBeGreaterThanOrEqual(1);
    expect(await writeoffRows(s.edgeOutletId)).toEqual([]);
    expect(await writeoffRows(elsewhere)).toEqual([]);
    await expectGapRefused(s, "EJ");
  });

  it("EDG-02 TEN-01 a row for a run of another tenant is skipped (invisible to this edge); the good row is still inserted", async () => {
    const s = await scenario();
    const { cloudRunId } = await s.holeRun("EK");
    await cloudWriteOff(s.cloudOutletId, cloudRunId, "EK", 2);
    const foreignOutlet = await bareOutlet(other);
    const foreignRun = await cloudRun(foreignOutlet, "EK", 3, other);
    const page = await s.cloudPage();
    const shipped = s.ship(page) as {
      receiptWriteoffs: Array<Record<string, unknown>>;
    };
    const good = shipped.receiptWriteoffs[0]!;
    const forged = {
      ...shipped,
      receiptWriteoffs: [
        {
          ...good,
          id: randomUUID(),
          sequenceId: foreignRun,
          sequenceNumber: 3,
        },
        good,
      ],
    };

    const result = await s.applyOnEdge(forged);
    expect(result).toMatchObject({
      receiptWriteoffsInserted: 1,
      receiptWriteoffsSkipped: 1,
      receiptWriteoffsRefused: 0,
    });
    const { rows: foreignRows } = await owner.query(
      `SELECT 1 FROM receipt_number_writeoffs WHERE tenant_id = $1 AND sequence_id = $2`,
      [tenant.tenantId, foreignRun],
    );
    expect(foreignRows).toEqual([]);
    expect((await writeoffRows(s.edgeOutletId)).map((r) => r.prefix)).toEqual([
      "EK",
    ]);
  });
});

describe("skip and fail closed", () => {
  it("POS-06 EDG-02 a write-off for a run the edge does not hold, or above the edge run's last_number, is skipped and counted; the other row is still inserted", async () => {
    const s = await scenario();
    // Edge holds EL (last 3, hole 2); the cloud's EL is further ahead (last 5).
    const held = await s.holeRun("EL", 5);
    const fits = await cloudWriteOff(s.cloudOutletId, held.cloudRunId, "EL", 2);
    // Number 4 is within the cloud run but above the edge run's last_number 3.
    await cloudWriteOff(s.cloudOutletId, held.cloudRunId, "EL", 4);
    // A run the edge never received (no edge row for prefix EM at all).
    const unknownRun = await cloudRun(s.cloudOutletId, "EM", 3);
    await cloudWriteOff(s.cloudOutletId, unknownRun, "EM", 2);

    const pulled = await s.pull();
    expect(writeoffsOf(pulled.page)).toHaveLength(3);
    expect(pulled.result).toMatchObject({
      receiptWriteoffsInserted: 1,
      receiptWriteoffsSkipped: 2,
      receiptWriteoffsRefused: 0,
    });
    const rows = await writeoffRows(s.edgeOutletId);
    expect(rows.map((r) => [r.prefix, r.sequence_number])).toEqual([["EL", 2]]);
    expect(rows[0]!.id).toBe(s.edgeId(fits.id));

    // The skipped numbers are not written off here: nothing is hidden.
    const { rows: others } = await owner.query(
      `SELECT 1 FROM receipt_number_writeoffs WHERE tenant_id = $1 AND outlet_id = $2
          AND prefix = 'EM'`,
      [tenant.tenantId, s.edgeOutletId],
    );
    expect(others).toEqual([]);
    const closed = await s.closeEdgeDay();
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  });

  it("POS-06 a write-off of a run the edge does not hold never hides the gap of another run", async () => {
    const s = await scenario();
    await s.holeRun("EN");
    // The write-off is for the cloud's run of ANOTHER prefix that has the same
    // number of receipts missing: it must not count for the edge's EN run.
    const otherRun = await cloudRun(s.cloudOutletId, "EO", 3);
    await cloudWriteOff(s.cloudOutletId, otherRun, "EO", 2);

    const pulled = await s.pull();
    expect(pulled.result).toMatchObject({
      receiptWriteoffsInserted: 0,
      receiptWriteoffsSkipped: 1,
    });
    await expectGapRefused(s, "EN");
  });
});

describe("old edges and non-primary roles", () => {
  it("EDG-02 an old edge (request without receiptWriteoffs) gets no receiptWriteoffs field and its strict page parse still passes", async () => {
    const s = await scenario();
    const { cloudRunId } = await s.holeRun("EP");
    await cloudWriteOff(s.cloudOutletId, cloudRunId, "EP", 2);

    const old = await s.cloudPage({ writeoffs: false });
    expect("receiptWriteoffs" in old).toBe(false);
    expect(() => deviceSyncPageSchema.parse(old)).not.toThrow();

    // Control: the same cloud answers a new edge with the field.
    const current = await s.cloudPage();
    expect(writeoffsOf(current)).toHaveLength(1);
    expect(() => deviceSyncPageSchema.parse(current)).not.toThrow();
  });

  it('EDG-02 the query accepts receiptWriteoffs only as "1" (like receiptSequences)', () => {
    expect(() =>
      deviceSyncQuerySchema.parse({ limit: 100, receiptWriteoffs: "1" }),
    ).not.toThrow();
    expect(() =>
      deviceSyncQuerySchema.parse({ limit: 100, receiptWriteoffs: "0" }),
    ).toThrow();
    expect(() =>
      deviceSyncQuerySchema.parse({ limit: 100, receiptWriteoffs: "true" }),
    ).toThrow();
  });

  it("EDG-02 a standby edge applies no write-off", async () => {
    const s = await scenario();
    const { cloudRunId } = await s.holeRun("EQ");
    await cloudWriteOff(s.cloudOutletId, cloudRunId, "EQ", 2);

    const shipped = s.ship(await s.cloudPage());
    await s.applyOnEdge(shipped, { role: "standby" });
    expect(await writeoffRows(s.edgeOutletId)).toEqual([]);
    await expectGapRefused(s, "EQ");
  });

  it("EDG-02 a primary without a binding applies no write-off either (same condition as the sequences)", async () => {
    const s = await scenario();
    const { cloudRunId } = await s.holeRun("ER");
    await cloudWriteOff(s.cloudOutletId, cloudRunId, "ER", 2);

    const shipped = s.ship(await s.cloudPage());
    await s.applyOnEdge(shipped, { role: "primary", binding: null });
    expect(await writeoffRows(s.edgeOutletId)).toEqual([]);
    await expectGapRefused(s, "ER");
  });
});

describe("the page the cloud sends", () => {
  it("EDG-02 carries the outlet's full list ordered by created_at then id, with the brief's fields and no tenant", async () => {
    const s = await scenario();
    const runId = await cloudRun(s.cloudOutletId, "ES", 5);
    const now = Date.now();
    // Inserted newest first, so the order cannot be the insertion order.
    const newest = await cloudWriteOff(s.cloudOutletId, runId, "ES", 4, {
      createdAt: new Date(now - 60_000),
    });
    const oldest = await cloudWriteOff(s.cloudOutletId, runId, "ES", 2, {
      createdAt: new Date(now - 3 * 3_600_000),
    });
    const middle = await cloudWriteOff(s.cloudOutletId, runId, "ES", 3, {
      createdAt: new Date(now - 3_600_000),
    });

    const page = await s.cloudPage();
    const listed = writeoffsOf(page) ?? [];
    expect(listed.map((w) => w.id)).toEqual([oldest.id, middle.id, newest.id]);
    expect(Object.keys(listed[0]!).sort()).toEqual(
      [
        "createdAt",
        "id",
        "outletId",
        "prefix",
        "reason",
        "sequenceId",
        "sequenceNumber",
        "writtenOffBy",
      ].sort(),
    );
    expect(listed[0]).toEqual({
      id: oldest.id,
      outletId: s.cloudOutletId,
      sequenceId: runId,
      prefix: "ES",
      sequenceNumber: 2,
      reason: REASON,
      writtenOffBy: oldest.writtenOffBy,
      createdAt: oldest.createdAt.toISOString(),
    });
    expect(() => deviceSyncPageSchema.parse(page)).not.toThrow();

    // An outlet without write-offs gets an empty list (field present), not a failure.
    const quiet = await scenario();
    expect(writeoffsOf(await quiet.cloudPage())).toEqual([]);
  });
});

// ---- Fix round 1 (legend-jcby0, review F1/F3/F4) ------------------------------------

describe("skips that are not errors (F4)", () => {
  it("POS-06 EDG-02 a write-off whose prefix differs from the edge run with the same id is skipped, not inserted", async () => {
    const s = await scenario();
    const { cloudRunId } = await s.holeRun("EX");
    await cloudWriteOff(s.cloudOutletId, cloudRunId, "EX", 2);
    const shipped = s.ship(await s.cloudPage()) as {
      receiptWriteoffs: Array<Record<string, unknown>>;
    };
    // Same run id as the edge holds, but the row claims another prefix.
    const forged = {
      ...shipped,
      receiptWriteoffs: shipped.receiptWriteoffs.map((w) => ({
        ...w,
        prefix: "ZZ",
      })),
    };

    const result = await s.applyOnEdge(forged);
    expect(result).toMatchObject({
      receiptWriteoffsInserted: 0,
      receiptWriteoffsSkipped: 1,
      receiptWriteoffsRefused: 0,
    });
    expect(await writeoffRows(s.edgeOutletId)).toEqual([]);
    await expectGapRefused(s, "EX");
  });

  it("POS-06 EDG-02 a second pull with everything already copied inserts nothing and skips every listed row", async () => {
    const s = await scenario();
    const first = await s.holeRun("EV");
    const second = await s.holeRun("EW");
    await cloudWriteOff(s.cloudOutletId, first.cloudRunId, "EV", 2);
    await cloudWriteOff(s.cloudOutletId, second.cloudRunId, "EW", 2);

    const one = await s.pull();
    expect(writeoffsOf(one.page)).toHaveLength(2);
    expect(one.result).toMatchObject({
      receiptWriteoffsInserted: 2,
      receiptWriteoffsSkipped: 0,
      receiptWriteoffsRefused: 0,
    });

    const two = await s.pull();
    expect(writeoffsOf(two.page)).toHaveLength(2);
    expect(two.result).toMatchObject({
      receiptWriteoffsInserted: 0,
      receiptWriteoffsSkipped: 2,
      receiptWriteoffsRefused: 0,
    });
    expect(await writeoffRows(s.edgeOutletId)).toHaveLength(2);
    const closed = await s.closeEdgeDay();
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  });
});

describe("a failing insert refuses the list, not the pull (F3)", () => {
  it("EDG-02 a row the database refuses (not a trigger refusal) refuses the whole list; the pull still succeeds and nothing is stored", async () => {
    const s = await scenario();
    const first = await s.holeRun("EY");
    const second = await s.holeRun("EZ");
    await cloudWriteOff(s.cloudOutletId, first.cloudRunId, "EY", 2);
    await cloudWriteOff(s.cloudOutletId, second.cloudRunId, "EZ", 2);
    const shipped = s.ship(await s.cloudPage()) as {
      receiptWriteoffs: Array<Record<string, unknown>>;
    };
    const [good, bad] = shipped.receiptWriteoffs;
    // The NUL passes the zod schema (a string of 10..500) but PostgreSQL text
    // cannot store it.
    const forged = {
      ...shipped,
      receiptWriteoffs: [
        good!,
        { ...bad!, reason: "Struk hilang\u0000 bersama printer" },
      ],
    };

    // The pull resolves (it never throws because of the write-off list).
    const result = await s.applyOnEdge(forged);
    expect(result.receiptWriteoffsInserted).toBe(0);
    expect(result.receiptWriteoffsRefused).toBeGreaterThanOrEqual(1);
    expect(await writeoffRows(s.edgeOutletId)).toEqual([]);
    // Both runs keep their hole (EY and EZ), so the close stays refused.
    const refused = await s.closeEdgeDay();
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(errorCode(refused.body)).toBe("RECEIPT_SEQUENCE_GAP");

    // Fail closed, not stuck: the next honest pull copies both rows.
    const retry = await s.applyOnEdge(s.ship(await s.cloudPage()));
    expect(retry).toMatchObject({
      receiptWriteoffsInserted: 2,
      receiptWriteoffsRefused: 0,
    });
  });
});

describe("the cap keeps the newest (F1)", () => {
  it("EDG-02 more than RECEIPT_WRITEOFF_SYNC_MAX write-offs: the page lists exactly MAX, the newest included, the oldest left out, oldest first", async () => {
    const s = await scenario();
    const total = RECEIPT_WRITEOFF_SYNC_MAX + 1;
    const runId = await cloudRun(s.cloudOutletId, "EU", total + 1_000);
    const base = new Date(Date.now() - 24 * 3_600_000);
    // Number n is written off n seconds after `base`: number 1 is the oldest.
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO receipt_number_writeoffs
           (id, tenant_id, outlet_id, sequence_id, prefix, sequence_number, reason, written_off_by, created_at)
         SELECT gen_random_uuid(), $1, $2, $3, 'EU', n, $4, gen_random_uuid(),
                $5::timestamptz + n * interval '1 second'
           FROM generate_series(1, $6::int) AS n`,
        [tenant.tenantId, s.cloudOutletId, runId, REASON, base, total],
      ),
    );

    const page = await s.cloudPage();
    const listed = (writeoffsOf(page) ?? []) as Array<{
      sequenceNumber: number;
      createdAt: string;
    }>;
    expect(listed).toHaveLength(RECEIPT_WRITEOFF_SYNC_MAX);
    const numbers = listed.map((w) => w.sequenceNumber);
    expect(numbers).not.toContain(1);
    expect(numbers).toContain(total);
    // Oldest first: numbers 2..1001 in order.
    expect(numbers).toEqual(
      Array.from({ length: RECEIPT_WRITEOFF_SYNC_MAX }, (_, i) => i + 2),
    );
    const times = listed.map((w) => Date.parse(w.createdAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(() => deviceSyncPageSchema.parse(page)).not.toThrow();
  }, 60_000);
});

describe("a pull over several pages applies the write-offs once (F4)", () => {
  it("EDG-02 device records over two pages, each page carrying the list: one insert and no repeated skip", async () => {
    const s = await scenario();
    const { cloudRunId } = await s.holeRun("FA");
    await cloudWriteOff(s.cloudOutletId, cloudRunId, "FA", 2);
    const shipped = s.ship(await s.cloudPage()) as {
      receiptWriteoffs: Array<Record<string, unknown>>;
    };

    const now = new Date().toISOString();
    const record = (label: string) =>
      deviceSyncRecordSchema.parse({
        tenantId: tenant.tenantId,
        outletId: s.edgeOutletId,
        id: randomUUID(),
        type: "kds",
        stationId: null,
        label,
        version: "1.0.0",
        capabilities: [],
        lastSeenAt: null,
        revokedAt: null,
        status: "active",
        trainingMode: false,
        updatedAt: now,
        tokenIssuedAt: now,
      });
    const withList = (
      data: unknown[],
      nextCursor: string | null,
    ): Record<string, unknown> => ({
      ...shipped,
      data,
      meta: { limit: 1, nextCursor, watermark: null },
    });
    const pages = new Map<string | null, Record<string, unknown>>([
      [null, withList([record("Halaman 1")], "cursor-1")],
      ["cursor-1", withList([record("Halaman 2")], null)],
    ]);

    await s.localNode();
    const requested: Array<string | null> = [];
    const result = await inEdgeMode(() =>
      pullDeviceRegistry({
        context: edgeScope(s.edgeOutletId),
        role: "primary",
        binding: s.own,
        fetchPage: async (since: string | null) => {
          requested.push(since);
          const page = pages.get(since);
          if (!page) throw new Error(`unexpected cursor ${since}`);
          return page;
        },
      }),
    );

    // Both pages were fetched, both carried the list, the list was applied once.
    expect(requested).toEqual([null, "cursor-1"]);
    expect(result).toMatchObject({
      receiptWriteoffsInserted: 1,
      receiptWriteoffsSkipped: 0,
      receiptWriteoffsRefused: 0,
    });
    expect(await writeoffRows(s.edgeOutletId)).toHaveLength(1);
    const closed = await s.closeEdgeDay();
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  });
});
