// Atomic stock-source owner claim (bead legend-ddoy, Tier K). Two outlets'
// edge nodes post lines of the same (tenant, source_type, source_id) at the
// same moment with different locations. The location advisory locks differ
// and the other-outlet check reads committed rows only, so without a lock on
// the source both used to pass and the GL consumer later failed with "Stock
// source spans more than one outlet". Runs against the disposable PostgreSQL
// with one disposable tenant (two outlets, one location each).
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import type { EventEnvelope } from "@starter/shared/events";
import {
  inventoryEvents,
  stockMovedEventPayloadSchema,
} from "@starter/shared/inventory";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { recordReplicatedStockMovementInTransaction } from "../services/inventory.service.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const actor = randomUUID();
const tenantId = randomUUID();
const outletA = randomUUID();
const outletB = randomUUID();
let locationA: string;
let locationB: string;
let itemId: string;
let userId: string;

const scopeOf = (outletId: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

async function createFixture() {
  const brand = randomUUID();
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Balapan Sumber', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tenantId,
      `balapan-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tenantId, `balapan-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tenantId],
  );
  for (const [id, code] of [
    [outletA, "RACE-01"],
    [outletB, "RACE-02"],
  ])
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $5, 'Jl. Uji', '{}', 'active')`,
      [id, tenantId, brand, entity, code],
    );
  const uom = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, 'gr', 'gram') RETURNING id",
    [tenantId],
  );
  const item = await owner.query<{ id: string }>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, 'Kopi Bubuk', 'Bahan Baku', 'raw_material', $2, false) RETURNING id`,
    [tenantId, uom.rows[0]!.id],
  );
  itemId = item.rows[0]!.id;
  userId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [userId, "Race Tester", `${userId}@example.com`],
  );
  const location = async (outletId: string) =>
    (
      await owner.query<{ id: string }>(
        "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, 'Gudang', 'warehouse') RETURNING id",
        [tenantId, outletId],
      )
    ).rows[0]!.id;
  locationA = await location(outletA);
  locationB = await location(outletB);
}

let clock = Date.parse("2026-11-09T09:00:00.000Z");
/** An edge `stock.moved` of one outlet, as the cloud applier receives it. */
function stockMoved(
  outletId: string,
  locationId: string,
  sourceId: string,
  kind: { movementType: string; sourceType: string; quantity: string } = {
    movementType: "sale",
    sourceType: "order",
    quantity: "-1.0000",
  },
) {
  clock += 1_000;
  const ledgerEntryId = createUlid(clock);
  const occurredAt = new Date(clock).toISOString();
  const event = inventoryEvents["stock.moved"].envelopeSchema.parse({
    id: createUlid(clock),
    tenantId,
    outletId,
    name: "stock.moved",
    version: 1,
    aggregateType: "stock",
    aggregateId: ledgerEntryId,
    sequence: 1,
    occurredAt,
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `stock.moved:${ledgerEntryId}`,
    payloadSchemaRef: "stock.moved.v1",
    payload: {
      ledgerEntryId,
      inventoryItemId: itemId,
      locationId,
      movementType: kind.movementType,
      quantity: kind.quantity,
      unitCostIdr: "1000.0000",
      batchId: null,
      sourceType: kind.sourceType,
      sourceId,
      occurredAt,
    },
  }) as EventEnvelope;
  return {
    event,
    ledgerEntryId,
    payload: stockMovedEventPayloadSchema.parse(event.payload),
  };
}

type Moved = ReturnType<typeof stockMoved>;

/**
 * Posts one movement in its own transaction, as the link receive tx does.
 * `hold` keeps the transaction open after the insert (forced overlap) and
 * `onHeld` fires once the movement is written and the locks are held.
 */
function post(
  outletId: string,
  moved: Moved,
  hold?: { until: Promise<void>; onHeld: () => void },
) {
  return withTenant(db, scopeOf(outletId), async (tx) => {
    const result = await recordReplicatedStockMovementInTransaction(
      tx,
      scopeOf(outletId),
      moved.event,
      moved.payload,
    );
    if (hold) {
      hold.onHeld();
      await hold.until;
    }
    return result;
  });
}

async function ledgerOutlets(sourceId: string): Promise<string[]> {
  const { rows } = await owner.query<{ outlet_id: string }>(
    "SELECT DISTINCT outlet_id FROM stock_ledger WHERE tenant_id = $1 AND source_type = 'order' AND source_id = $2::uuid",
    [tenantId, ulidToUuid(sourceId)],
  );
  return rows.map((row) => row.outlet_id);
}

/** Granted flags of the advisory lock `hashtextextended(key, 0)`, from pg_locks. */
async function advisoryLockStates(key: string): Promise<boolean[]> {
  const { rows } = await owner.query<{ granted: boolean }>(
    `SELECT granted FROM pg_locks
      WHERE locktype = 'advisory'
        AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
    [key],
  );
  return rows.map((row) => row.granted);
}

/** Polls (no fixed sleep) until `check` holds or 5 s pass. */
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((done) => setTimeout(done, 20));
  }
}

const sourceKey = (sourceType: string, sourceId: string) =>
  `stock-source:${tenantId}:${sourceType}:${ulidToUuid(sourceId)}`.toLowerCase();

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await createFixture();
});

afterAll(async () => {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "domain_event_outbox",
      "stock_balances",
      "stock_ledger",
      "waste_logs",
      "stock_counts",
      "stock_transfers",
      "production_orders",
      "orders",
      "stock_locations",
      "inventory_items",
      "uoms",
      "audit_logs",
      "outlets",
      "legal_entities",
      "brands",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        tenantId,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await client.query('DELETE FROM "user" WHERE id = $1', [userId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
});

describe("legend-ddoy atomic stock-source owner claim", () => {
  it("two outlets racing on one source: exactly one wins, the other gets 409", async () => {
    const sourceId = createUlid(clock);
    const first = stockMoved(outletA, locationA, sourceId);
    const second = stockMoved(outletB, locationB, sourceId);

    let release!: () => void;
    const until = new Promise<void>((done) => {
      release = done;
    });
    let held!: () => void;
    const aHoldsLocks = new Promise<void>((done) => {
      held = done;
    });
    // Outlet A inserts and stays uncommitted; outlet B starts only then.
    const postA = post(outletA, first, { until, onHeld: held });
    await aHoldsLocks;
    const key = sourceKey("order", sourceId);
    expect(await advisoryLockStates(key)).toEqual([true]);
    const postB = post(outletB, second);
    // B must be parked on the source claim (ungranted), not racing past it.
    await waitFor(async () => (await advisoryLockStates(key)).includes(false));
    release();
    const [resultA, resultB] = await Promise.allSettled([postA, postB]);

    expect(resultA.status).toBe("fulfilled");
    expect(resultB.status).toBe("rejected");
    expect((resultB as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
      code: "CONFLICT",
    });
    expect(await ledgerOutlets(sourceId)).toEqual([outletA]);
  });

  it("the same outlet replaying or extending its own source stays idempotent", async () => {
    const sourceId = createUlid(clock + 100);
    const line = stockMoved(outletA, locationA, sourceId);
    const another = stockMoved(outletA, locationA, sourceId);

    expect(await post(outletA, line)).toBe(true);
    // Replay of the identical row writes nothing and is not a conflict.
    expect(await post(outletA, line)).toBe(false);
    // A second line of the same document on the same outlet is accepted.
    expect(await post(outletA, another)).toBe(true);
    expect(await ledgerOutlets(sourceId)).toEqual([outletA]);
  });

  // Every sourceType the owner check maps to a table (legend-ddoy): a cloud
  // document of outlet A with no ledger rows still refuses edge B.
  const documentCases: {
    sourceType: string;
    movementType: string;
    quantity: string;
    /** Inserts the cloud document for outlet A and returns its source id. */
    insert: (client: PoolClient) => Promise<string>;
  }[] = [
    {
      sourceType: "order",
      movementType: "sale",
      quantity: "-1.0000",
      insert: async (client) => {
        const id = createUlid();
        await client.query(
          `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
             subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
             status, business_date, placed_at)
           VALUES ($1::uuid, $2, $3, $4, 'qr', 'dine_in', 'pay_first', 0, 0, 0, 0, 0, 0,
             'sent', '2026-11-09', now())`,
          [
            ulidToUuid(id),
            tenantId,
            outletA,
            `R-${randomBytes(4).toString("hex")}`,
          ],
        );
        return id;
      },
    },
    {
      sourceType: "waste_log",
      movementType: "waste",
      quantity: "-1.0000",
      insert: async (client) => {
        const id = randomUUID();
        await client.query(
          `INSERT INTO waste_logs (id, tenant_id, outlet_id, location_id, target_type, target_id, quantity, reason, value_idr, logged_by, occurred_at)
           VALUES ($1, $2, $3, $4, 'inventory_item', $5, 1, 'spoiled', 1000, $6, now())`,
          [id, tenantId, outletA, locationA, itemId, userId],
        );
        return id;
      },
    },
    {
      sourceType: "stock_count",
      movementType: "adjustment",
      quantity: "1.0000",
      insert: async (client) => {
        const id = randomUUID();
        await client.query(
          `INSERT INTO stock_counts (id, tenant_id, outlet_id, location_id, type, status, blind, business_date,
             counted_by, create_idempotency_key, create_fingerprint)
           VALUES ($1, $2, $3, $4, 'full', 'draft', false, '2026-11-09', $5, $6, $6)`,
          [
            id,
            tenantId,
            outletA,
            locationA,
            userId,
            randomBytes(8).toString("hex"),
          ],
        );
        return id;
      },
    },
    {
      sourceType: "stock_transfer",
      movementType: "transfer_out",
      quantity: "-1.0000",
      insert: async (client) => {
        const id = createUlid();
        // One outlet_id: both locations belong to the owning outlet.
        const second = await client.query<{ id: string }>(
          "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, 'Gudang 2', 'warehouse') RETURNING id",
          [tenantId, outletA],
        );
        await client.query(
          `INSERT INTO stock_transfers (id, tenant_id, outlet_id, from_location_id, to_location_id, moved_by)
           VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
          [
            ulidToUuid(id),
            tenantId,
            outletA,
            locationA,
            second.rows[0]!.id,
            userId,
          ],
        );
        return id;
      },
    },
    {
      sourceType: "production_order",
      movementType: "production_out",
      quantity: "-1.0000",
      insert: async (client) => {
        const id = randomUUID();
        await client.query(
          `INSERT INTO production_orders (id, tenant_id, outlet_id, location_id, recipe_id, output_item_id, planned_qty, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, 1, $7)`,
          [id, tenantId, outletA, locationA, randomUUID(), itemId, userId],
        );
        return id;
      },
    },
  ];

  it.each(documentCases)(
    "refuses a cloud $sourceType of another outlet with no ledger rows",
    async ({ sourceType, movementType, quantity, insert }) => {
      const client = await owner.connect();
      let sourceId: string;
      try {
        await client.query("BEGIN");
        // The production recipe is not part of this fixture; only the owner
        // column matters to the check under test.
        await client.query("SET LOCAL session_replication_role = replica");
        sourceId = await insert(client);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      const kind = { movementType, sourceType, quantity };
      const line = stockMoved(outletB, locationB, sourceId, kind);
      await expect(post(outletB, line)).rejects.toMatchObject({
        status: 409,
        code: "CONFLICT",
      });
      const { rows } = await owner.query(
        "SELECT 1 FROM stock_ledger WHERE tenant_id = $1 AND id = $2::uuid",
        [tenantId, ulidToUuid(line.ledgerEntryId)],
      );
      expect(rows).toHaveLength(0);
      // The owning outlet posts its own document.
      expect(
        await post(outletA, stockMoved(outletA, locationA, sourceId, kind)),
      ).toBe(true);
    },
  );

  it("passes a source id the cloud does not hold", async () => {
    expect(
      await post(
        outletB,
        stockMoved(outletB, locationB, randomUUID(), {
          movementType: "waste",
          sourceType: "waste_log",
          quantity: "-1.0000",
        }),
      ),
    ).toBe(true);
  });
});
