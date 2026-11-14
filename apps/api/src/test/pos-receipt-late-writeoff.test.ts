// Late device receipt vs write-off of the same number (bead legend-refx7,
// card B of 850). Fail-first tests written from the brief, not from the code.
//
// Problem: `mergeDeviceReceiptRun` stores receipts a device syncs late without
// seeing a write-off of that number, because it reads the device's
// `receipt_sequences` rows without a lock while the write-off service locks the
// sequence row first (FOR UPDATE) and then inserts the write-off. Decided design:
//  1. merge locks the device's sequence rows FOR UPDATE first (same order as
//     the write-off: sequence row first, then everything else);
//  2. after the lock, a receipt whose number has a write-off is STILL stored
//     (data is never lost), an audit row `pos_receipt.arrived_after_writeoff`
//     is written and supervisors of the outlet get an alarm (Indonesian text,
//     deduped per sequence + number);
//  3. gap counting is unchanged.
//
// Assumptions (stated, the brief does not pin them down):
//  - Alarm channel is the notification adapter; its tables are not fixed, so
//    "an alarm was raised" = new rows in notification_outbox / domain_event_outbox /
//    notifications for the tenant, compared with a control merge without a
//    write-off in the same tenant (the control may write other rows; the late
//    receipt must add more). The alarm text is Indonesian: the new rows mention
//    "struk" (case-insensitive).
//  - The audit row is read from audit_logs: event.action =
//    'pos_receipt.arrived_after_writeoff'; its serialized event mentions the
//    outlet id or the receipt number (safe fields). One row per sequence+number.
//  - The write-off is done through the real `writeOffReceiptNumber` service (the
//    HTTP route with owner template and MFA is covered by
//    pos-receipt-writeoff.test.ts), with the signed-up cashier as caller, like
//    pos-receipt-writeoff-edge-run.test.ts.
//  - The write-off trigger (0166) only guards INSERTs into the write-off table,
//    not receipts; the late receipt must store (insert not rejected).
//  - Race: "tx A" is a plain owner transaction holding the sequence row lock
//    (what the write-off holds while it runs). The real write-off and the real
//    merge then queue behind it in that order (observed with pg_blocking_pids,
//    never with sleeps for the positive path). When A commits the write-off
//    wins the queue; the merge must therefore see the write-off.
//  - Lock order of OTHER paths (pos_receipts first, sequence second) is
//    implementation knowledge and is not proven here; the both-ways concurrency
//    test only covers write-off <-> merge.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/pos-receipt-late-writeoff.test.ts" heavy pnpm test

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { formatReceiptNumber, type PosReceipt } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { setPosReceiptPort } from "../services/pos-order-ports.ts";
import {
  createPosReceiptPort,
  mergeDeviceReceiptRun,
  provisionReceiptSequence,
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
const SEED_SNAPSHOT = JSON.stringify({
  outletName: "Cafe Legend Senopati",
  outletAddress: "Jl. Kopi Legenda No. 12, Jakarta Selatan",
  legalName: null,
  npwpLast4: null,
});
const LATE_ACTION = "pos_receipt.arrived_after_writeoff";

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  cashierRole: randomUUID(),
};

let tenant: IsolatedTenant;
let headers: { Host: string };
let cashier: { client: ReturnType<typeof agent>; userId: string };
let supervisorUserId: string;
let supervisorRoleId: string;

// ---- Fixtures (copied from pos-receipt-kfix.test.ts) -------------------------------

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

async function rows<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const result = await client.query(text, params);
    return result.rows as T[];
  });
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

/** An outlet with its own price list; a supervisor is assigned to it (alarm recipient). */
async function freshOutlet(): Promise<string> {
  const outletId = randomUUID();
  const priceListId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Cafe Legend Senopati', 'Jl. Kopi Legenda No. 12, Jakarta Selatan', 'Asia/Jakarta', $6, 'active')`,
    [
      outletId,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `L${outletId.slice(0, 8)}`.toUpperCase(),
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
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [tenant.tenantId, supervisorUserId, supervisorRoleId, outletId],
  );
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

/** A merge-ready order: owned by `deviceId`, completed, no receipt yet. */
async function deviceOrder(outletId: string, deviceId: string) {
  const orderId = await draftOrder(outletId);
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `UPDATE pos_orders SET device_id = $3 WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(orderId), deviceId],
    );
    await client.query(
      `UPDATE orders SET status = 'completed' WHERE tenant_id = $1 AND id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(orderId)],
    );
  });
  return orderId;
}

type ServiceTx = Parameters<typeof mergeDeviceReceiptRun>[0];

function inTx<T>(
  run: (tx: ServiceTx, context: ScopedTenantContext) => Promise<T>,
): Promise<T> {
  const context = tenantContext(tenant.tenantId);
  return withTenant(db, context, (tx) => run(tx as ServiceTx, context));
}

function provision(outletId: string, deviceId: string, prefix: string) {
  return inTx((tx, c) =>
    provisionReceiptSequence(tx, c, { outletId, deviceId, prefix }),
  );
}

function offlineReceipt(input: {
  outletId: string;
  deviceId: string;
  orderId: string;
  prefix: string;
  ordinal: number;
}): PosReceipt {
  return {
    id: randomUUID(),
    tenantId: tenant.tenantId,
    outletId: input.outletId,
    orderId: input.orderId,
    deviceId: input.deviceId,
    number: formatReceiptNumber(input.prefix, input.ordinal),
    sequenceNumber: input.ordinal,
    status: "issued",
    issuedAt: new Date().toISOString(),
    voidedAt: null,
    voidReason: null,
    voidedBy: null,
    reprintCount: 0,
  } as unknown as PosReceipt;
}

function mergeRun(
  outletId: string,
  deviceId: string,
  prefix: string,
  lastNumber: number,
  receipts: PosReceipt[],
) {
  return inTx((tx, context) =>
    mergeDeviceReceiptRun(tx, context, {
      sequence: { outletId, deviceId, prefix, lastNumber },
      receipts,
    }),
  );
}

/** The real write-off service, as the route calls it. */
function writeOff(outletId: string, sequenceNumber: number, prefix = "P1") {
  return writeOffReceiptNumber(
    tenantContext(tenant.tenantId),
    { userId: userIdSchema.parse(cashier.userId) },
    outletIdSchema.parse(outletId),
    { prefix, sequenceNumber, reason: REASON } as never,
  );
}

async function storedNumbers(outletId: string): Promise<string[]> {
  return (
    await rows<{ number: string }>(
      `SELECT number FROM pos_receipts WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY number`,
      [tenant.tenantId, outletId],
    )
  ).map((row) => row.number);
}

async function writeoffNumbers(outletId: string): Promise<string[]> {
  return (
    await rows<{ prefix: string; sequence_number: number }>(
      `SELECT prefix, sequence_number FROM receipt_number_writeoffs
        WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY prefix, sequence_number`,
      [tenant.tenantId, outletId],
    )
  ).map((row) => formatReceiptNumber(row.prefix, row.sequence_number));
}

async function lateAuditEvents(): Promise<string[]> {
  return (
    await rows<{ event: string }>(
      `SELECT event::text AS event FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = $2
        ORDER BY created_at`,
      [tenant.tenantId, LATE_ACTION],
    )
  ).map((row) => row.event);
}

/** Every alarm-channel row of the tenant, serialized (schema-agnostic snapshot). */
async function alarmRows(): Promise<string[]> {
  const out: string[] = [];
  for (const table of [
    "notification_outbox",
    "domain_event_outbox",
    "notifications",
  ]) {
    out.push(
      ...(
        await rows<{ row: string }>(
          `SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE tenant_id = $1`,
          [tenant.tenantId],
        )
      ).map((row) => row.row),
    );
  }
  return out;
}

/** Alarm rows that exist after `run` and not before it. */
async function newAlarmRows(run: () => Promise<unknown>): Promise<string[]> {
  const before = new Set(await alarmRows());
  await run();
  return (await alarmRows()).filter((row) => !before.has(row));
}

/**
 * An outlet where device P1 merged receipts 1 and 3 (last_number 3): number 2
 * is the hole. Returns the order for the late receipt of number 2.
 */
async function outletWithHole() {
  const outletId = await freshOutlet();
  const deviceId = randomUUID();
  await provision(outletId, deviceId, "P1");
  const o1 = await deviceOrder(outletId, deviceId);
  const o3 = await deviceOrder(outletId, deviceId);
  const o2 = await deviceOrder(outletId, deviceId);
  const base = { outletId, deviceId, prefix: "P1" };
  // A merge refuses a run with a hole (RECEIPT_SEQUENCE_GAP), so the hole is
  // seeded with owner SQL like pos-receipt-writeoff.test.ts: last_number 3 with
  // receipts 1 and 3 stored.
  const [sequence] = await rows<{ id: string }>(
    `SELECT id FROM receipt_sequences WHERE tenant_id = $1 AND outlet_id = $2 AND prefix = 'P1'`,
    [tenant.tenantId, outletId],
  );
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `UPDATE receipt_sequences SET last_number = 3 WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, sequence!.id],
    );
    for (const [ordinal, orderId] of [
      [1, o1],
      [3, o3],
    ] as const)
      await client.query(
        `INSERT INTO pos_receipts
           (tenant_id, outlet_id, order_id, sequence_id, device_id, number, sequence_number, status, issued_at, outlet_snapshot)
         VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, 'issued', now(), $8::jsonb)`,
        [
          tenant.tenantId,
          outletId,
          ulidToUuid(orderId),
          sequence!.id,
          deviceId,
          formatReceiptNumber("P1", ordinal),
          ordinal,
          SEED_SNAPSHOT,
        ],
      );
  });
  const late = () => offlineReceipt({ ...base, orderId: o2, ordinal: 2 });
  return {
    outletId,
    deviceId,
    late,
    spareOrder: () => deviceOrder(outletId, deviceId),
  };
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Race helpers --------------------------------------------------------------------

type Holder = { client: PoolClient; pid: number };

/** Opens a transaction that holds FOR UPDATE on the device's sequence row. */
async function holdSequenceLock(
  outletId: string,
  deviceId: string,
): Promise<Holder> {
  const client = await owner.connect();
  await client.query("BEGIN");
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
    [tenant.tenantId],
  );
  const locked = await client.query(
    `SELECT id FROM receipt_sequences
      WHERE tenant_id = $1 AND outlet_id = $2 AND device_id = $3 FOR UPDATE`,
    [tenant.tenantId, outletId, deviceId],
  );
  expect(locked.rowCount).toBe(1);
  const { rows: pidRows } = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  return { client, pid: pidRows[0]!.pid };
}

async function release(holder: Holder, how: "COMMIT" | "ROLLBACK") {
  try {
    await holder.client.query(how);
  } finally {
    holder.client.release();
  }
}

async function blockedBy(pid: number): Promise<number> {
  const { rows: waiting } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))`,
    [pid],
  );
  return waiting[0]!.n;
}

async function waitUntilBlockedBy(pid: number, min: number) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if ((await blockedBy(pid)) >= min) return;
    await sleep(25);
  }
  throw new Error(`fewer than ${min} backends are waiting for backend ${pid}`);
}

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const app = createApp();
  setAuditWriter(coreAuditWriter);
  setPosReceiptPort(createPosReceiptPort());
  tenant = await createIsolatedTenant(`rlw-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Kasir Late Writeoff', false, NULL, $3, false, '["tenant","outlet"]')`,
    [
      ids.cashierRole,
      tenant.tenantId,
      JSON.stringify(["order.view", "pos.sale.create"]),
    ],
  );
  const client = agent(app);
  await signUp(client, "Kasir Late Writeoff");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, ids.cashierRole],
  );
  cashier = { client, userId };

  // Supervisor of each outlet (alarm recipient): the seeded supervisor template.
  supervisorRoleId = randomUUID();
  const copied = await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, $2, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $3 AND template_key = 'supervisor'`,
    [supervisorRoleId, tenant.tenantId, fixtures.tenant.id],
  );
  if (copied.rowCount !== 1) throw new Error("No supervisor role template");
  const supervisorClient = agent(app);
  await signUp(supervisorClient, "Supervisor Late Writeoff");
  const supervisorSession = await supervisorClient.get("/api/auth/get-session");
  supervisorUserId = supervisorSession.body.user.id as string;

  await asOwnerTenant(tenant.tenantId, async (c) => {
    await c.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Late Writeoff Uji', 0)`,
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
       VALUES ($1, $2, NULL, 'PBJT-RLW', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
  });
}, 120_000);

afterAll(async () => {
  setAuditWriter(null);
  setPosReceiptPort(null);
  // Final orders, receipts and audit rows are append-only: the tenant stays in
  // the disposable database with a valid creator.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ---- legend-refx7: receipt arrives for a written-off number --------------------------

describe("legend-refx7 late receipt for a written-off number", () => {
  it("is stored, writes an audit row and alarms supervisors (Indonesian text)", async () => {
    const { outletId, deviceId, late } = await outletWithHole();
    await writeOff(outletId, 2);
    expect(await writeoffNumbers(outletId)).toEqual(["P1-000002"]);
    const auditBefore = (await lateAuditEvents()).length;

    const fresh = await newAlarmRows(async () => {
      const merged = await mergeRun(outletId, deviceId, "P1", 3, [late()]);
      // Data is never lost: the receipt is stored although its number was written off.
      expect(merged.inserted).toBe(1);
    });
    expect(await storedNumbers(outletId)).toEqual([
      "P1-000001",
      "P1-000002",
      "P1-000003",
    ]);

    const audit = await lateAuditEvents();
    expect(audit).toHaveLength(auditBefore + 1);
    const event = audit[audit.length - 1]!;
    expect(event.includes(outletId) || event.includes("P1-000002")).toBe(true);

    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.join("\n")).toMatch(/struk/i);

    // Gap counting is unchanged: 1, 2 (now a real receipt) and 3 are all there.
    const gaps = await inTx((tx, context) =>
      receiptGapsForOutletFast(tx as never, context, outletId),
    );
    expect(gaps).toEqual([]);
  });

  it("alarms more than a plain merge of the same shape (control without a write-off)", async () => {
    const control = await outletWithHole();
    const auditBeforeControl = (await lateAuditEvents()).length;
    const controlRows = await newAlarmRows(async () => {
      await mergeRun(control.outletId, control.deviceId, "P1", 3, [
        control.late(),
      ]);
    });
    expect((await lateAuditEvents()).length).toBe(auditBeforeControl);

    const written = await outletWithHole();
    await writeOff(written.outletId, 2);
    const lateRows = await newAlarmRows(async () => {
      await mergeRun(written.outletId, written.deviceId, "P1", 3, [
        written.late(),
      ]);
    });

    expect((await lateAuditEvents()).length).toBe(auditBeforeControl + 1);
    expect(lateRows.length).toBeGreaterThan(controlRows.length);
  });

  it("a receipt for a number WITHOUT a write-off writes no audit row and no alarm", async () => {
    // Number 2 of P1 is written off; the receipt that arrives is number 2 of
    // ANOTHER device (prefix P2): same ordinal, other sequence, no write-off.
    // (The merge itself refuses a run with a hole, so a different ordinal of
    // P1 cannot be merged; the per-sequence key is what this proves.)
    const { outletId } = await outletWithHole();
    await writeOff(outletId, 2);
    const otherDevice = randomUUID();
    await provision(outletId, otherDevice, "P2");
    const o1 = await deviceOrder(outletId, otherDevice);
    const o2 = await deviceOrder(outletId, otherDevice);
    const base = { outletId, deviceId: otherDevice, prefix: "P2" };
    const auditBefore = (await lateAuditEvents()).length;
    const fresh = await newAlarmRows(async () => {
      const merged = await mergeRun(outletId, otherDevice, "P2", 2, [
        offlineReceipt({ ...base, orderId: o1, ordinal: 1 }),
        offlineReceipt({ ...base, orderId: o2, ordinal: 2 }),
      ]);
      expect(merged.inserted).toBe(2);
    });
    expect((await lateAuditEvents()).length).toBe(auditBefore);
    // The alarm itself is compared with a control in the test above.
    expect(fresh.join("\n")).not.toMatch(/struk.*(terlambat|dihapus)/i);
    expect(await storedNumbers(outletId)).toContain("P2-000002");
  });

  it("re-delivering the same late receipt stores nothing new and raises no second audit or alarm", async () => {
    const { outletId, deviceId, late } = await outletWithHole();
    await writeOff(outletId, 2);
    const receipt = late();
    await mergeRun(outletId, deviceId, "P1", 3, [receipt]);
    const auditAfterFirst = (await lateAuditEvents()).length;

    const fresh = await newAlarmRows(async () => {
      const replay = await mergeRun(outletId, deviceId, "P1", 3, [receipt]);
      expect(replay.inserted).toBe(0);
    });
    expect((await lateAuditEvents()).length).toBe(auditAfterFirst);
    // Whatever else a replay writes, it is not a second alarm.
    expect(fresh.join("\n")).not.toMatch(/struk/i);
    expect(await storedNumbers(outletId)).toHaveLength(3);
  });
});

// ---- legend-refx7: merge takes the sequence lock first --------------------------------

describe("legend-refx7 merge vs write-off locking", () => {
  it("merge waits while a write-off holds the sequence lock and then sees the write-off (never an audit-less store)", async () => {
    const { outletId, deviceId, late } = await outletWithHole();
    const auditBefore = (await lateAuditEvents()).length;
    const holder = await holdSequenceLock(outletId, deviceId);
    let releasedAs: "COMMIT" | "ROLLBACK" | null = null;
    const finish = async (how: "COMMIT" | "ROLLBACK") => {
      if (releasedAs) return;
      releasedAs = how;
      await release(holder, how);
    };
    let writeOffRun: ReturnType<typeof settle> | undefined;
    let mergeRunning: ReturnType<typeof settle> | undefined;
    try {
      // The write-off queues first (it owns the sequence row first in its design).
      writeOffRun = settle(writeOff(outletId, 2));
      await waitUntilBlockedBy(holder.pid, 1);
      mergeRunning = settle(mergeRun(outletId, deviceId, "P1", 3, [late()]));

      // While the lock is held the merge must not complete: it may not read
      // the sequence rows (or store the receipt) before it owns the lock. The
      // wait below is only a settle time for the merge to start (it ends early
      // when the merge queues behind the lock or finishes); a correct merge
      // passes whatever the timing, a merge that does not lock reads the state
      // before the write-off commits.
      let mergeFinished = false;
      void mergeRunning.then(() => {
        mergeFinished = true;
      });
      for (let attempt = 0; attempt < 60 && !mergeFinished; attempt += 1) {
        if ((await blockedBy(holder.pid)) >= 2) break;
        await sleep(25);
      }
      expect(
        mergeFinished,
        "merge finished while the write-off still held the sequence lock",
      ).toBe(false);
      expect(await storedNumbers(outletId)).not.toContain("P1-000002");

      await finish("COMMIT");
      const wrote = await writeOffRun;
      const merged = await mergeRunning;
      expect(wrote.ok, JSON.stringify(wrote)).toBe(true);
      expect(merged.ok, JSON.stringify(merged)).toBe(true);
    } finally {
      await finish("ROLLBACK");
      await Promise.all([writeOffRun, mergeRunning]);
    }

    expect(await writeoffNumbers(outletId)).toEqual(["P1-000002"]);
    expect(await storedNumbers(outletId)).toContain("P1-000002");
    expect((await lateAuditEvents()).length).toBe(auditBefore + 1);
  });

  it("merge of another device is not blocked by a lock on a different device's sequence", async () => {
    const first = await outletWithHole();
    const otherDevice = randomUUID();
    await provision(first.outletId, otherDevice, "P2");
    const order = await deviceOrder(first.outletId, otherDevice);
    const holder = await holdSequenceLock(first.outletId, first.deviceId);
    try {
      const merged = await Promise.race([
        mergeRun(first.outletId, otherDevice, "P2", 1, [
          offlineReceipt({
            outletId: first.outletId,
            deviceId: otherDevice,
            orderId: order,
            prefix: "P2",
            ordinal: 1,
          }),
        ]),
        sleep(5_000).then(() => "blocked" as const),
      ]);
      expect(merged).not.toBe("blocked");
      expect(merged).toMatchObject({ inserted: 1 });
    } finally {
      await release(holder, "ROLLBACK");
    }
  });

  it("write-off and merge started together, in either order, never deadlock and never store without the audit", async () => {
    for (const writeOffFirst of [true, false, true, false]) {
      const { outletId, deviceId, late } = await outletWithHole();
      const auditBefore = (await lateAuditEvents()).length;
      const runs = writeOffFirst
        ? [
            settle(writeOff(outletId, 2)),
            settle(mergeRun(outletId, deviceId, "P1", 3, [late()])),
          ]
        : [
            settle(mergeRun(outletId, deviceId, "P1", 3, [late()])),
            settle(writeOff(outletId, 2)),
          ];
      const results = await Promise.all(runs);
      const [wrote, merged] = writeOffFirst
        ? [results[0]!, results[1]!]
        : [results[1]!, results[0]!];

      // No deadlock (SQLSTATE 40P01) and the merge never fails: data is never lost.
      for (const result of results)
        if (!result.ok)
          expect((result.error as { code?: string }).code).not.toBe("40P01");
      expect(merged.ok, JSON.stringify(merged)).toBe(true);
      expect(await storedNumbers(outletId)).toContain("P1-000002");

      const audits = (await lateAuditEvents()).length - auditBefore;
      if (wrote.ok) {
        // The write-off won the sequence lock: the merge must have seen it.
        expect(await writeoffNumbers(outletId)).toEqual(["P1-000002"]);
        expect(audits).toBe(1);
      } else {
        // The receipt won: the write-off of a number with a receipt is refused
        // (the existing rule) and nothing says "arrived after write-off".
        expect(await writeoffNumbers(outletId)).toEqual([]);
        expect(audits).toBe(0);
      }
    }
  });
});
