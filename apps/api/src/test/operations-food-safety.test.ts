// Daily-operations food safety against PostgreSQL (PRD v1.7 §3 F41 "Log
// Keamanan Pangan, Label Prep, Daftar Prep Harian", §6 L; OPS-02, OPS-03;
// TEN-01..03; bead legend-sdet, WS-14).
//
// Runs the real services in the restricted app role (RLS enforced). The
// services own their tenant transaction, so the tests call them directly with a
// server-minted context; only the tx-taking sweep and the raw RLS probes run
// inside `withTenant`. Every test seeds its own equipment or batch through the
// owner connection, so assertions never depend on another test's rows.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decimal4Schema, outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  equipmentIdSchema,
  positiveDecimal4Schema,
  type EquipmentId,
} from "@starter/shared/operations";
import {
  inventoryItemIdSchema,
  stockBatchIdSchema,
  type InventoryItemId,
  type StockBatchId,
} from "@starter/shared/inventory";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  createPrepLabel,
  createPrepList,
  createTemperatureLog,
  getPrepList,
  listPrepLabels,
  listPrepLists,
  listTemperatureLogs,
  printPrepLabel,
  sweepExpiredPrepLabels,
  transitionPrepList,
} from "../services/operations-food-safety.service.ts";
import {
  setPrepProductionOrderCreator,
  type PrepProductionOrderInput,
} from "../services/operations-prep-production.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const outletB = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[1].id);
const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherEntity = randomUUID();
const otherOutlet = randomUUID();

/** 2030-01-15 10:00 in Asia/Jakarta (UTC+7). */
const NOW = new Date("2030-01-15T03:00:00.000Z");
const MINUTE = 60_000;
const at = (minutes: number) =>
  new Date(NOW.getTime() + minutes * MINUTE).toISOString();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 6,
});

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEquipmentIds: string[] = [];
const createdUomIds: string[] = [];
const createdItemIds: string[] = [];
const createdLocationIds: string[] = [];
const createdBatchIds: string[] = [];
const createdLabelIds: string[] = [];
const createdTemperatureLogIds: string[] = [];
const createdPrepListIds: string[] = [];

let operator = "";
let otherEquipmentId = "";

const base = (tenant: string = tenantId) =>
  establishTenantContext({
    tenantId: tenant,
    brandId: null,
    source: "session",
  });
const tenantScope = (tenant: string = tenantId) =>
  establishScopedTenantContext(base(tenant), { kind: "tenant" });
const outletScope = (outletId: string, tenant: string = tenantId) =>
  establishScopedTenantContext(base(tenant), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });

/** Owner connection with the tenant settings FORCE RLS requires. */
async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
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

/** A user holding a custom role with exactly `permissions` at `scope`. */
async function seedActor(
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Ops sdet', $2)`,
    [userId, `${userId}@example.test`],
  );
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asOwner(tenantId, async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenantId,
        `Ops sdet ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        tenantId,
        userId,
        roleId,
        scope.type,
        scope.type === "outlet" ? scope.id : null,
      ],
    );
  });
  return userId;
}

async function seedEquipment(
  options: {
    tenant?: string;
    outletId?: string;
    threshold?: { minCelsius: string; maxCelsius: string } | null;
  } = {},
): Promise<EquipmentId> {
  const tenant = options.tenant ?? tenantId;
  const outlet = options.outletId ?? outletA;
  const id = randomUUID();
  createdEquipmentIds.push(id);
  const threshold =
    options.threshold === undefined
      ? { minCelsius: "2.0000", maxCelsius: "8.0000" }
      : options.threshold;
  await asOwner(tenant, (client) =>
    client.query(
      `INSERT INTO equipment (id, tenant_id, outlet_id, name, category, status, temperature_threshold)
       VALUES ($1, $2, $3, $4, 'chiller', 'operational', $5)`,
      [
        id,
        tenant,
        outlet,
        `Chiller ${id.slice(0, 8)}`,
        threshold === null ? null : JSON.stringify(threshold),
      ],
    ),
  );
  return equipmentIdSchema.parse(id);
}

async function seedInventoryItem(
  name: string,
  tenant: string = tenantId,
): Promise<InventoryItemId> {
  const uomId = randomUUID();
  createdUomIds.push(uomId);
  const itemId = randomUUID();
  createdItemIds.push(itemId);
  await asOwner(tenant, async (client) => {
    await client.query(
      `INSERT INTO uoms (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)`,
      [uomId, tenant, `U${uomId.slice(0, 8)}`, `Unit ${uomId.slice(0, 8)}`],
    );
    await client.query(
      `INSERT INTO inventory_items (id, tenant_id, name, category, type, base_uom_id)
       VALUES ($1, $2, $3, 'Bahan Baku', 'raw_material', $4)`,
      [itemId, tenant, name, uomId],
    );
  });
  return inventoryItemIdSchema.parse(itemId);
}

async function seedStockBatch(
  outletId: string,
  inventoryItemId: InventoryItemId,
  tenant: string = tenantId,
): Promise<StockBatchId> {
  const locationId = randomUUID();
  createdLocationIds.push(locationId);
  const batchId = randomUUID();
  createdBatchIds.push(batchId);
  await asOwner(tenant, async (client) => {
    await client.query(
      `INSERT INTO stock_locations (id, tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, $4, 'chiller')`,
      [locationId, tenant, outletId, `Chiller ${locationId.slice(0, 8)}`],
    );
    await client.query(
      `INSERT INTO stock_batches (id, tenant_id, outlet_id, location_id, inventory_item_id, batch_code)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        batchId,
        tenant,
        outletId,
        locationId,
        inventoryItemId,
        `B${batchId.slice(0, 8)}`,
      ],
    );
  });
  return stockBatchIdSchema.parse(batchId);
}

let keySequence = 0;
const nextKey = (label: string) =>
  `sdet-${label}-${(keySequence += 1)}-${randomUUID().slice(0, 8)}`;

/** Decimal4 readings and quantities are branded at the contract boundary. */
const reading = (value: string) => decimal4Schema.parse(value);
const qty = (value: string) => positiveDecimal4Schema.parse(value);

type TemperatureInput = Parameters<typeof createTemperatureLog>[2];
type PrepLabelInput = Parameters<typeof createPrepLabel>[2];
type PrepListInput = Parameters<typeof createPrepList>[2];

async function outboxEvents(
  name: string,
  aggregateId: string,
  tenant: string = tenantId,
) {
  const { rows } = await asOwner(tenant, (client) =>
    client.query<{ event: { name: string; payload: Record<string, unknown> } }>(
      `SELECT event FROM domain_event_outbox
       WHERE tenant_id = $1 AND event->>'name' = $2 AND aggregate_id = $3
       ORDER BY sequence`,
      [tenant, name, aggregateId],
    ),
  );
  return rows.map((row) => row.event);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  operator = await seedActor(["ops.food_safety.log", "ops.prep.manage"], {
    type: "tenant",
  });
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Ops sdet RLS tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `ops-sdet-${otherTenant.slice(0, 8)}`, tenantId],
  );
  await asOwner(otherTenant, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'ops-b', 'Brand Ops B')`,
      [otherBrand, otherTenant],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Ops B', false)`,
      [otherEntity, otherTenant],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'OPS-B-01', 'Outlet Ops B', 'Jl. Ops B', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [otherOutlet, otherTenant, otherBrand, otherEntity],
    );
  });
  otherEquipmentId = await seedEquipment({
    tenant: otherTenant,
    outletId: otherOutlet,
  });
});

afterAll(async () => {
  const byIds = async (table: string, ids: readonly string[]) => {
    if (ids.length === 0) return;
    await asOwner(tenantId, (client) =>
      client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [tenantId, [...ids]],
      ),
    );
  };
  if (createdPrepListIds.length > 0)
    await asOwner(tenantId, (client) =>
      client.query(
        `DELETE FROM prep_list_items WHERE tenant_id = $1 AND prep_list_id = ANY($2::uuid[])`,
        [tenantId, createdPrepListIds],
      ),
    );
  await byIds("prep_lists", createdPrepListIds);
  await byIds("prep_labels", createdLabelIds);
  await byIds("temperature_logs", createdTemperatureLogIds);
  const resultIds = [
    ...createdTemperatureLogIds,
    ...createdLabelIds,
    ...createdPrepListIds,
  ];
  if (resultIds.length > 0)
    await asOwner(tenantId, (client) =>
      client.query(
        `DELETE FROM operations_idempotency WHERE tenant_id = $1 AND result_id = ANY($2::uuid[])`,
        [tenantId, resultIds],
      ),
    );
  await byIds("stock_batches", createdBatchIds);
  await byIds("stock_locations", createdLocationIds);
  await byIds("equipment", createdEquipmentIds);
  await byIds("inventory_items", createdItemIds);
  await byIds("uoms", createdUomIds);
  await owner.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [
    createdUsers,
  ]);
  if (createdRoles.length > 0)
    await owner.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, createdRoles],
    );
  if (createdUsers.length > 0)
    await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await asOwner(otherTenant, async (client) => {
    await client.query("DELETE FROM temperature_logs WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM equipment WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM outlets WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM brands WHERE tenant_id = $1", [
      otherTenant,
    ]);
  });
  await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  await owner.end();
});

describe("legend-sdet OPS-02 temperature logs", () => {
  it("[legend-sdet][OPS-02] an out-of-range reading without a corrective action is refused and stores no row", async () => {
    const equipmentId = await seedEquipment();
    const context = outletScope(outletA);
    const input: TemperatureInput = {
      outletId: outletA,
      equipmentId,
      readingCelsius: reading("12.5000"),
      idempotencyKey: nextKey("temp-refused"),
    };
    await expect(
      createTemperatureLog(context, operator, input, NOW),
    ).rejects.toMatchObject({
      code: "TEMPERATURE_CORRECTIVE_ACTION_REQUIRED",
      status: 422,
    });
    // A blank action is not an action (OPS-02).
    await expect(
      createTemperatureLog(
        context,
        operator,
        {
          ...input,
          correctiveAction: "   ",
          idempotencyKey: nextKey("temp-blank-action"),
        },
        NOW,
      ),
    ).rejects.toMatchObject({
      code: "TEMPERATURE_CORRECTIVE_ACTION_REQUIRED",
    });
    const { rows } = await asOwner(tenantId, (client) =>
      client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM temperature_logs WHERE tenant_id = $1 AND equipment_id = $2",
        [tenantId, equipmentId],
      ),
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("[legend-sdet][OPS-02] an in-range reading stores inRange true and no corrective action, and a replay returns the same row", async () => {
    const equipmentId = await seedEquipment();
    const context = outletScope(outletA);
    const input: TemperatureInput = {
      outletId: outletA,
      equipmentId,
      // Exactly the upper bound is still in range (inclusive threshold).
      readingCelsius: reading("8.0000"),
      correctiveAction: "Tidak perlu, suhu aman.",
      recordedAt: NOW.toISOString(),
      idempotencyKey: nextKey("temp-in-range"),
    };
    const log = await createTemperatureLog(context, operator, input, NOW);
    createdTemperatureLogIds.push(log.id);
    expect(log.inRange).toBe(true);
    expect(log.correctiveAction).toBeNull();
    expect(log.recordedBy).toBe(operator);
    expect(log.recordedAt).toBe(NOW.toISOString());
    expect(await outboxEvents("temperature.out_of_range", log.id)).toEqual([]);

    const replay = await createTemperatureLog(context, operator, input, NOW);
    expect(replay.id).toBe(log.id);
    await expect(
      createTemperatureLog(
        context,
        operator,
        { ...input, readingCelsius: reading("5.0000") },
        NOW,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });
  });

  it("[legend-sdet][OPS-02] an out-of-range reading with an action stores inRange false and emits temperature.out_of_range", async () => {
    const equipmentId = await seedEquipment();
    const context = outletScope(outletA);
    const correctiveAction =
      "  Alihkan stok ke freezer cadangan, catat ulang 30 menit.  ";
    const log = await createTemperatureLog(
      context,
      operator,
      {
        outletId: outletA,
        equipmentId,
        readingCelsius: reading("-3.5000"),
        correctiveAction,
        recordedAt: NOW.toISOString(),
        idempotencyKey: nextKey("temp-out-of-range"),
      },
      NOW,
    );
    createdTemperatureLogIds.push(log.id);
    expect(log.inRange).toBe(false);
    expect(log.correctiveAction).toBe(correctiveAction.trim());

    const events = await outboxEvents("temperature.out_of_range", log.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({
      temperatureLogId: log.id,
      equipmentId,
      readingCelsius: "-3.5000",
      minCelsius: "2.0000",
      maxCelsius: "8.0000",
      recordedAt: NOW.toISOString(),
      correctiveAction: correctiveAction.trim(),
    });
  });

  it("[legend-sdet][OPS-02] equipment without a threshold or outside the outlet cannot take a reading", async () => {
    const context = outletScope(outletA);
    const withoutThreshold = await seedEquipment({ threshold: null });
    await expect(
      createTemperatureLog(
        context,
        operator,
        {
          outletId: outletA,
          equipmentId: withoutThreshold,
          readingCelsius: reading("4.0000"),
          idempotencyKey: nextKey("temp-no-threshold"),
        },
        NOW,
      ),
    ).rejects.toMatchObject({
      code: "TEMPERATURE_READING_INVALID",
      status: 422,
    });

    const otherOutletEquipment = await seedEquipment({ outletId: outletB });
    await expect(
      createTemperatureLog(
        context,
        operator,
        {
          outletId: outletA,
          equipmentId: otherOutletEquipment,
          readingCelsius: reading("4.0000"),
          idempotencyKey: nextKey("temp-other-outlet"),
        },
        NOW,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("[legend-sdet][OPS-02] the list filters by equipment and recorded_at range and pages newest first", async () => {
    const equipmentId = await seedEquipment();
    const otherEquipment = await seedEquipment();
    const context = outletScope(outletA);
    const record = (atMinutes: number, equipment = equipmentId) =>
      createTemperatureLog(
        context,
        operator,
        {
          outletId: outletA,
          equipmentId: equipment,
          readingCelsius: reading("4.0000"),
          recordedAt: at(atMinutes),
          idempotencyKey: nextKey("temp-list"),
        },
        NOW,
      );
    const oldest = await record(-120);
    const middle = await record(-60);
    const newest = await record(-30, otherEquipment);
    for (const log of [oldest, middle, newest])
      createdTemperatureLogIds.push(log.id);

    const byEquipment = await listTemperatureLogs(context, {
      outletId: outletA,
      equipmentId,
      limit: 25,
    });
    expect(byEquipment.data.map((log) => log.id)).toEqual([
      middle.id,
      oldest.id,
    ]);

    const windowed = await listTemperatureLogs(context, {
      outletId: outletA,
      equipmentId,
      from: at(-90),
      to: at(-60),
      limit: 25,
    });
    expect(windowed.data.map((log) => log.id)).toEqual([middle.id]);

    const firstPage = await listTemperatureLogs(context, {
      outletId: outletA,
      equipmentId,
      limit: 1,
    });
    expect(firstPage.data.map((log) => log.id)).toEqual([middle.id]);
    expect(firstPage.meta.nextCursor).not.toBeNull();
    const secondPage = await listTemperatureLogs(context, {
      outletId: outletA,
      equipmentId,
      limit: 1,
      cursor: firstPage.meta.nextCursor ?? undefined,
    });
    expect(secondPage.data.map((log) => log.id)).toEqual([oldest.id]);
    expect(secondPage.meta.nextCursor).toBeNull();
  });
});

describe("legend-sdet OPS-03 prep labels", () => {
  it("[legend-sdet][OPS-03] a prep label needs a batch from the same outlet and inventory item", async () => {
    const itemA = await seedInventoryItem(`Susu ${randomUUID().slice(0, 6)}`);
    const itemB = await seedInventoryItem(`Krim ${randomUUID().slice(0, 6)}`);
    const batchA = await seedStockBatch(outletA, itemA);
    const batchB = await seedStockBatch(outletB, itemA);
    const context = outletScope(outletA);
    const labelInput = (
      batchId: StockBatchId,
      inventoryItemId: InventoryItemId,
    ): PrepLabelInput => ({
      outletId: outletA,
      inventoryItemId,
      batchId,
      producedAt: at(-60),
      useBy: at(240),
      idempotencyKey: nextKey("label-mismatch"),
    });
    await expect(
      createPrepLabel(context, operator, labelInput(batchA, itemB), NOW),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
    await expect(
      createPrepLabel(context, operator, labelInput(batchB, itemA), NOW),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
    const { rows } = await asOwner(tenantId, (client) =>
      client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM prep_labels WHERE tenant_id = $1 AND batch_id = ANY($2::uuid[])",
        [tenantId, [batchA, batchB]],
      ),
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("[legend-sdet][OPS-03] the label links to its batch, lists by use-by and prints once", async () => {
    const item = await seedInventoryItem(`Saus ${randomUUID().slice(0, 6)}`);
    const batch = await seedStockBatch(outletA, item);
    const context = outletScope(outletA);
    const label = await createPrepLabel(
      context,
      operator,
      {
        outletId: outletA,
        inventoryItemId: item,
        batchId: batch,
        producedAt: at(-60),
        useBy: at(240),
        idempotencyKey: nextKey("label-create"),
      },
      NOW,
    );
    createdLabelIds.push(label.id);
    expect(label.inventoryItemId).toBe(item);
    expect(label.batchId).toBe(batch);
    expect(label.printedAt).toBeNull();

    const expiring = await listPrepLabels(
      context,
      {
        outletId: outletA,
        inventoryItemId: item,
        expiringBefore: at(300),
        limit: 25,
      },
      NOW,
    );
    expect(expiring.data.map((row) => row.id)).toEqual([label.id]);
    const tooLate = await listPrepLabels(
      context,
      {
        outletId: outletA,
        inventoryItemId: item,
        expiringBefore: NOW.toISOString(),
        limit: 25,
      },
      NOW,
    );
    expect(tooLate.data).toEqual([]);

    const printed = await printPrepLabel(
      context,
      operator,
      label.id,
      { idempotencyKey: nextKey("label-print") },
      NOW,
    );
    expect(printed.printedAt).toBe(NOW.toISOString());
    const reprinted = await printPrepLabel(
      context,
      operator,
      label.id,
      { idempotencyKey: nextKey("label-reprint") },
      new Date(NOW.getTime() + 5 * MINUTE),
    );
    expect(reprinted.printedAt).toBe(NOW.toISOString());
    expect(reprinted.id).toBe(label.id);
  });

  it("[legend-sdet][OPS-03] the expiry sweep alerts each expired label exactly once", async () => {
    const item = await seedInventoryItem(`Bumbu ${randomUUID().slice(0, 6)}`);
    const batch = await seedStockBatch(outletB, item);
    const contextB = outletScope(outletB);
    const label = await createPrepLabel(
      contextB,
      operator,
      {
        outletId: outletB,
        inventoryItemId: item,
        batchId: batch,
        producedAt: at(-240),
        useBy: at(-60),
        idempotencyKey: nextKey("label-expired"),
      },
      NOW,
    );
    createdLabelIds.push(label.id);

    const first = await withTenant(db, contextB, (tx) =>
      sweepExpiredPrepLabels(tx, contextB, NOW),
    );
    expect(first).toBe(1);
    const second = await withTenant(db, contextB, (tx) =>
      sweepExpiredPrepLabels(tx, contextB, NOW),
    );
    expect(second).toBe(0);

    const { rows } = await asOwner(tenantId, (client) =>
      client.query<{ expiry_alerted_at: Date | null }>(
        "SELECT expiry_alerted_at FROM prep_labels WHERE tenant_id = $1 AND id = $2",
        [tenantId, label.id],
      ),
    );
    expect(rows[0]!.expiry_alerted_at?.toISOString()).toBe(NOW.toISOString());

    const events = await outboxEvents("prep_label.expired", label.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({
      prepLabelId: label.id,
      inventoryItemId: item,
      batchId: batch,
      useBy: at(-60),
      detectedAt: NOW.toISOString(),
    });
  });

  it("[legend-sdet][OPS-03] a sweep for another outlet never alerts this outlet's labels", async () => {
    const item = await seedInventoryItem(`Gula ${randomUUID().slice(0, 6)}`);
    const batch = await seedStockBatch(outletA, item);
    const contextA = outletScope(outletA);
    const label = await createPrepLabel(
      contextA,
      operator,
      {
        outletId: outletA,
        inventoryItemId: item,
        batchId: batch,
        producedAt: at(-240),
        useBy: at(-60),
        idempotencyKey: nextKey("label-outlet-scope"),
      },
      NOW,
    );
    createdLabelIds.push(label.id);
    const contextB = outletScope(outletB);
    await withTenant(db, contextB, (tx) =>
      sweepExpiredPrepLabels(tx, contextB, NOW),
    );
    const { rows } = await asOwner(tenantId, (client) =>
      client.query<{ expiry_alerted_at: Date | null }>(
        "SELECT expiry_alerted_at FROM prep_labels WHERE tenant_id = $1 AND id = $2",
        [tenantId, label.id],
      ),
    );
    expect(rows[0]!.expiry_alerted_at).toBeNull();
  });
});

describe("legend-sdet daily prep list from the AI-07 forecast", () => {
  it("[legend-sdet] creates the list and lines, refuses a duplicate item, and replays idempotently", async () => {
    const itemA = await seedInventoryItem(`Ayam ${randomUUID().slice(0, 6)}`);
    const itemB = await seedInventoryItem(`Beras ${randomUUID().slice(0, 6)}`);
    const context = outletScope(outletA);
    const prepDate = "2030-02-10";
    const forecastId = randomUUID();
    const input: PrepListInput = {
      outletId: outletA,
      prepDate,
      lines: [
        { inventoryItemId: itemA, plannedQuantity: qty("2.5000") },
        { inventoryItemId: itemB, plannedQuantity: qty("1.0000") },
      ],
      generatedFromForecastId: forecastId,
      idempotencyKey: nextKey("prep-list"),
    };
    const list = await createPrepList(context, operator, input, NOW);
    createdPrepListIds.push(list.id);
    expect(list.prepDate).toBe(prepDate);
    expect(list.status).toBe("pending");
    expect(list.generatedFromForecastId).toBe(forecastId);
    expect(list.generatedAt).toBe(NOW.toISOString());
    expect(list.lines).toHaveLength(2);

    const replay = await createPrepList(context, operator, input, NOW);
    expect(replay.id).toBe(list.id);

    const fetched = await getPrepList(context, list.id);
    expect(fetched.id).toBe(list.id);
    expect(fetched.lines).toHaveLength(2);

    const listed = await listPrepLists(context, {
      outletId: outletA,
      prepDate,
      limit: 25,
    });
    expect(listed.data.map((row) => row.id)).toEqual([list.id]);

    const invalidDate = "2030-02-11";
    await expect(
      createPrepList(
        context,
        operator,
        {
          outletId: outletA,
          prepDate: invalidDate,
          lines: [
            { inventoryItemId: itemA, plannedQuantity: qty("1.0000") },
            { inventoryItemId: itemA, plannedQuantity: qty("2.0000") },
          ],
          idempotencyKey: nextKey("prep-list-dup"),
        },
        NOW,
      ),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
    const { rows } = await asOwner(tenantId, (client) =>
      client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM prep_lists WHERE tenant_id = $1 AND outlet_id = $2 AND prep_date = $3",
        [tenantId, outletA, invalidDate],
      ),
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("[legend-sdet] completing the list calls the injected production port exactly once", async () => {
    const itemA = await seedInventoryItem(`Tepung ${randomUUID().slice(0, 6)}`);
    const itemB = await seedInventoryItem(
      `Mentega ${randomUUID().slice(0, 6)}`,
    );
    const context = outletScope(outletA);
    const prepDate = "2030-02-12";
    const list = await createPrepList(
      context,
      operator,
      {
        outletId: outletA,
        prepDate,
        lines: [
          { inventoryItemId: itemA, plannedQuantity: qty("3.0000") },
          { inventoryItemId: itemB, plannedQuantity: qty("0.7500") },
        ],
        idempotencyKey: nextKey("prep-list-complete"),
      },
      NOW,
    );
    createdPrepListIds.push(list.id);

    const calls: { input: PrepProductionOrderInput; now: Date }[] = [];
    setPrepProductionOrderCreator((tx, productionContext, input, now) => {
      void tx;
      void productionContext;
      calls.push({ input, now });
      return Promise.resolve();
    });
    try {
      const started = await transitionPrepList(
        context,
        operator,
        list.id,
        { action: "start", idempotencyKey: nextKey("prep-start") },
        NOW,
      );
      expect(started.status).toBe("in_progress");
      const completed = await transitionPrepList(
        context,
        operator,
        list.id,
        { action: "complete", idempotencyKey: nextKey("prep-complete") },
        NOW,
      );
      expect(completed.status).toBe("completed");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.input.prepListId).toBe(list.id);
      expect(calls[0]!.input.outletId).toBe(outletA);
      expect(calls[0]!.input.prepDate).toBe(prepDate);
      expect(calls[0]!.input.lines).toHaveLength(2);
      expect(calls[0]!.now.toISOString()).toBe(NOW.toISOString());
      // No WS-06 production order exists yet: the link stays null (legend-ugo).
      expect(completed.lines.map((line) => line.productionOrderId)).toEqual([
        null,
        null,
      ]);
    } finally {
      setPrepProductionOrderCreator(null);
    }
  });

  it("[legend-sdet] a completed prep list refuses a further transition", async () => {
    const item = await seedInventoryItem(`Garam ${randomUUID().slice(0, 6)}`);
    const context = outletScope(outletA);
    const list = await createPrepList(
      context,
      operator,
      {
        outletId: outletA,
        prepDate: "2030-02-13",
        lines: [{ inventoryItemId: item, plannedQuantity: qty("0.5000") }],
        idempotencyKey: nextKey("prep-list-closed"),
      },
      NOW,
    );
    createdPrepListIds.push(list.id);
    await transitionPrepList(
      context,
      operator,
      list.id,
      { action: "start", idempotencyKey: nextKey("prep-start-closed") },
      NOW,
    );
    await transitionPrepList(
      context,
      operator,
      list.id,
      { action: "complete", idempotencyKey: nextKey("prep-complete-closed") },
      NOW,
    );
    await expect(
      transitionPrepList(
        context,
        operator,
        list.id,
        { action: "start", idempotencyKey: nextKey("prep-reopen") },
        NOW,
      ),
    ).rejects.toMatchObject({
      code: "PREP_LIST_TRANSITION_INVALID",
      status: 409,
    });
  });
});

describe("legend-sdet TEN isolation for the new tables", () => {
  it("[legend-sdet][TEN-01] a second tenant cannot see the first tenant's temperature logs and RLS refuses a forged row", async () => {
    const equipmentId = await seedEquipment();
    const contextA = outletScope(outletA);
    const ownLog = await createTemperatureLog(
      contextA,
      operator,
      {
        outletId: outletA,
        equipmentId,
        readingCelsius: reading("4.0000"),
        idempotencyKey: nextKey("temp-isolation"),
      },
      NOW,
    );
    createdTemperatureLogIds.push(ownLog.id);

    const otherLogId = randomUUID();
    await asOwner(otherTenant, (client) =>
      client.query(
        `INSERT INTO temperature_logs (id, tenant_id, outlet_id, equipment_id, reading_celsius, recorded_at, recorded_by, in_range)
         VALUES ($1, $2, $3, $4, '5.0000', $5, $6, true)`,
        [
          otherLogId,
          otherTenant,
          otherOutlet,
          otherEquipmentId,
          NOW.toISOString(),
          operator,
        ],
      ),
    );

    const otherContext = tenantScope(otherTenant);
    const visible = await listTemperatureLogs(otherContext, {
      outletId: otherOutlet,
      limit: 25,
    });
    expect(visible.data.map((log) => log.id)).toEqual([otherLogId]);

    const raw = await withTenant(db, otherContext, (tx) =>
      tx.execute(sql`SELECT id FROM temperature_logs ORDER BY id`),
    );
    expect(raw.rows.map((row) => (row as { id: string }).id)).toEqual([
      otherLogId,
    ]);

    await expect(
      withTenant(db, otherContext, (tx) =>
        tx.execute(sql`
          INSERT INTO temperature_logs (id, tenant_id, outlet_id, equipment_id, reading_celsius, recorded_at, recorded_by, in_range)
          VALUES (${randomUUID()}, ${tenantId}, ${outletA}, ${equipmentId}, '4.0000', now(), ${operator}, true)`),
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "42501" }),
    });
  });
});
