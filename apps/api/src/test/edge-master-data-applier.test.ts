// legend-3x9l: catalog events are full records, so missing intermediate
// versions are safe. Exercise the installed ports through the real receive
// transaction: catalog writes, receipts and the inbound cursor commit together.
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { sql } from "drizzle-orm";
import {
  createUlid,
  encodeCursor,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  CATALOG_PROTOCOL_VERSION,
  type CatalogSyncStream,
} from "@starter/shared/edge";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { EdgeCloudHttpError } from "../edge/cloud-http.ts";
import { pullCatalog } from "../edge/catalog-puller.ts";
import {
  catalogRecordAggregateId,
  registerMasterDataEdgeApplier,
} from "../edge/master-data-applier.ts";
import { classifyEdgeEvent } from "../edge/ports.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import { createWorld, owner, type World } from "./member-loyalty-helpers.ts";

type CatalogRecord = Record<string, unknown>;

let world: World;
let node: AuthenticatedEdgeNode;
const NOW = "2026-11-14T12:00:00.000Z";

beforeEach(async () => {
  resetEdgeApplierRegistryForTests();
  registerMasterDataEdgeApplier();
  world = await createWorld();
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(world.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(world.outletA)] },
  );
  const registered = await registerEdgeNode(context, randomUUID(), {
    outletId: world.outletA,
    role: "primary",
    label: "Master data test",
  });
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Test node did not authenticate");
  node = authenticated;
});

afterEach(() => resetEdgeApplierRegistryForTests());
afterAll(async () => owner.end());

function station(overrides: CatalogRecord = {}): CatalogRecord {
  return {
    id: randomUUID(),
    tenantId: world.tenantId,
    outletId: world.outletA,
    name: "Coffee bar",
    type: "coffee_bar",
    printerDeviceId: null,
    targetSeconds: 120,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    syncTxid: "1",
    ...overrides,
  };
}

function category(overrides: CatalogRecord = {}): CatalogRecord {
  return {
    id: randomUUID(),
    tenantId: world.tenantId,
    brandId: world.brandId,
    name: "Category",
    parentId: null,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    syncTxid: "1",
    ...overrides,
  };
}

function catalogEvent(
  record: CatalogRecord,
  overrides: Partial<EventEnvelope> = {},
  stream: CatalogSyncStream = "stations",
): EventEnvelope {
  const id = createUlid();
  return eventEnvelopeSchema.parse({
    id,
    tenantId: world.tenantId,
    outletId: world.outletA,
    name: "catalog_record.updated",
    version: 1,
    aggregateType: "catalog_record",
    aggregateId: catalogRecordAggregateId(stream, record),
    sequence: Number(record.syncTxid),
    occurredAt: NOW,
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `master-test:${id}`,
    payloadSchemaRef: "catalog_record.updated.v1",
    payload: { stream, record },
    ...overrides,
  });
}

function store() {
  return createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "edge_to_cloud",
  });
}

async function deliver(...events: EventEnvelope[]) {
  const link = store();
  const fromSeq = await link.lastReceivedInbound();
  await link.applyInbound({
    fromSeq,
    toSeq: fromSeq + events.length,
    events: events.map((event, index) => ({
      linkSeq: fromSeq + index + 1,
      event,
    })),
  });
}

async function storedStation(id: unknown) {
  const result = await owner.query<{
    name: string;
    type: string;
    target_seconds: number;
    printer_device_id: string | null;
    deleted_at: Date | null;
    sync_txid: string;
  }>(
    `SELECT name, type, target_seconds, printer_device_id, deleted_at, sync_txid::text
       FROM stations WHERE tenant_id = $1 AND id = $2`,
    [world.tenantId, id],
  );
  return result.rows[0];
}

async function receipts() {
  const result = await owner.query<{
    event_id: string;
    aggregate_sequence: string;
    kind: string;
    outcome: string;
  }>(
    `SELECT event_id::text, aggregate_sequence, kind, outcome
       FROM edge_inbound_events WHERE edge_node_id = $1 ORDER BY link_seq`,
    [node.scope.edgeNodeId],
  );
  return result.rows.map((row) => ({
    ...row,
    aggregate_sequence: Number(row.aggregate_sequence),
  }));
}

describe("legend-3x9l full-state master-data down-sync", () => {
  it("defers a missing item without blocking later records and wakes after commit", async () => {
    const record = {
      id: randomUUID(),
      tenantId: world.tenantId,
      menuItemId: randomUUID(),
      name: "Variant",
      recipeId: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      syncTxid: "1",
    };
    const deferred = catalogEvent(record, {}, "item_variants");
    const next = station();
    const afterCommit = vi.fn(async () => {
      expect(await receipts()).toMatchObject([
        { outcome: "deferred" },
        { outcome: "applied" },
      ]);
    });
    const options = {
      database: db,
      context: node.context,
      node: node.scope,
      outboundDirection: "edge_to_cloud" as const,
      onDeferred: afterCommit,
    };
    const link = createDbLinkStore(options);
    await link.applyInbound({
      fromSeq: 0,
      toSeq: 2,
      events: [
        { linkSeq: 1, event: deferred },
        { linkSeq: 2, event: catalogEvent(next) },
      ],
    });
    expect(await link.lastReceivedInbound()).toBe(2);
    expect(await storedStation(next.id)).toMatchObject({ name: "Coffee bar" });
    expect(await receipts()).toMatchObject([
      { outcome: "deferred" },
      { outcome: "applied" },
    ]);
    expect(afterCommit).toHaveBeenCalledOnce();
    expect(afterCommit).toHaveBeenCalledWith(["item_variants"]);
  });

  it("defers a real missing category foreign key without blocking the next event", async () => {
    const parent = category();
    const item = {
      id: randomUUID(),
      tenantId: world.tenantId,
      brandId: world.brandId,
      categoryId: parent.id,
      name: "Drink",
      description: "",
      type: "single",
      stationId: null,
      stationType: null,
      course: null,
      recipeId: null,
      taxRuleId: null,
      labels: [],
      allergens: [],
      mediaId: null,
      isActive: true,
      sortOrder: 0,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      syncTxid: "1",
    };
    await deliver(
      catalogEvent(item, {}, "menu_items"),
      catalogEvent(parent, {}, "menu_categories"),
    );
    expect(await store().lastReceivedInbound()).toBe(2);
    expect(await receipts()).toMatchObject([
      { outcome: "deferred" },
      { outcome: "applied" },
    ]);
    const rows = await owner.query(
      `SELECT id FROM menu_categories WHERE id = $1`,
      [parent.id],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("does not hold a newer event after a deferred version or allow an older HTTP version to overwrite it", async () => {
    const itemId = randomUUID();
    const record = {
      id: randomUUID(),
      tenantId: world.tenantId,
      menuItemId: itemId,
      name: "Deferred",
      recipeId: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      syncTxid: "1",
    };
    await deliver(catalogEvent(record, {}, "item_variants"));
    const categoryId = randomUUID();
    await owner.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Category')`,
      [categoryId, world.tenantId, world.brandId],
    );
    await owner.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name) VALUES ($1, $2, $3, $4, 'Item')`,
      [itemId, world.tenantId, world.brandId, categoryId],
    );
    await deliver(
      catalogEvent(
        { ...record, name: "Newer", syncTxid: "9" },
        {},
        "item_variants",
      ),
    );
    const result = await pullCatalog({
      database: db,
      context: node.context,
      edgeNodeId: node.scope.edgeNodeId,
      streams: ["item_variants"],
      fetchPage: async (stream) => ({
        protocolVersion: CATALOG_PROTOCOL_VERSION,
        stream,
        records: [record],
        nextCursor: encodeCursor(["cat2", "1", record.id]),
        hasMore: false,
      }),
    });
    expect(result.streams.item_variants?.error).toBeUndefined();
    const stored = await owner.query(
      `SELECT name, sync_txid::text FROM item_variants WHERE id = $1`,
      [record.id],
    );
    expect(stored.rows).toEqual([{ name: "Newer", sync_txid: "9" }]);
    expect(await receipts()).toMatchObject([
      { outcome: "deferred" },
      { outcome: "applied" },
    ]);
  });

  it("applies a deferred tombstone during catalog pull after its missing parent arrives", async () => {
    const itemId = randomUUID();
    const record = {
      id: randomUUID(),
      tenantId: world.tenantId,
      menuItemId: itemId,
      name: "Deleted variant",
      recipeId: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: NOW,
      syncTxid: "7",
    };
    await deliver(catalogEvent(record, {}, "item_variants"));
    expect(await receipts()).toMatchObject([{ outcome: "deferred" }]);
    const categoryId = randomUUID();
    await owner.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Category')`,
      [categoryId, world.tenantId, world.brandId],
    );
    await owner.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name) VALUES ($1, $2, $3, $4, 'Item')`,
      [itemId, world.tenantId, world.brandId, categoryId],
    );
    const result = await pullCatalog({
      database: db,
      context: node.context,
      edgeNodeId: node.scope.edgeNodeId,
      streams: ["item_variants"],
      fetchPage: async (stream) => ({
        protocolVersion: CATALOG_PROTOCOL_VERSION,
        stream,
        records: [record],
        nextCursor: encodeCursor(["cat2", "7", record.id]),
        hasMore: false,
      }),
    });
    expect(result.streams.item_variants?.error).toBeUndefined();
    const stored = await owner.query(
      `SELECT deleted_at FROM item_variants WHERE id = $1`,
      [record.id],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].deleted_at).not.toBeNull();
  });

  it("restricts deferred receipts to the correct tenant and outlet", async () => {
    const record = {
      id: randomUUID(),
      tenantId: world.tenantId,
      menuItemId: randomUUID(),
      name: "Variant",
      recipeId: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      syncTxid: "1",
    };
    await deliver(catalogEvent(record, {}, "item_variants"));
    const otherWorld = await createWorld();
    const scoped = (tenant: string, outlet: string) =>
      establishScopedTenantContext(
        establishTenantContext({
          tenantId: tenantIdSchema.parse(tenant),
          brandId: null,
          source: "session",
        }),
        { kind: "outlets", outletIds: [outletIdSchema.parse(outlet)] },
      );
    const visible = async (tenant: string, outlet: string) =>
      withTenant(db, scoped(tenant, outlet), async (tx) => {
        const rows = await tx.execute(
          sql`SELECT event_id FROM edge_inbound_events WHERE edge_node_id = ${node.scope.edgeNodeId}::uuid AND outcome = 'deferred'`,
        );
        return rows.rows;
      });
    expect(await visible(world.tenantId, world.outletA)).toHaveLength(1);
    expect(await visible(world.tenantId, world.outletB)).toHaveLength(0);
    expect(await visible(otherWorld.tenantId, otherWorld.outletA)).toHaveLength(
      0,
    );
  });
  it("classifies the dedicated catalog aggregate as master_data", () => {
    expect(classifyEdgeEvent(catalogEvent(station()), "cloud_to_edge")).toBe(
      "master_data",
    );
  });

  it("applies a complete master record through the installed cloud_to_edge port", async () => {
    const record = station();
    await deliver(catalogEvent(record));
    expect(await storedStation(record.id)).toEqual({
      name: "Coffee bar",
      type: "coffee_bar",
      target_seconds: 120,
      printer_device_id: null,
      deleted_at: null,
      sync_txid: "1",
    });
    expect(await receipts()).toMatchObject([
      { aggregate_sequence: 1, kind: "master_data", outcome: "applied" },
    ]);
    expect(await store().lastReceivedInbound()).toBe(1);
  });

  it("safely jumps from version 1 to 9 using the full replacement state", async () => {
    const initial = station();
    const latest = {
      ...initial,
      name: "Hot kitchen",
      type: "hot_kitchen",
      targetSeconds: 450,
      printerDeviceId: randomUUID(),
      syncTxid: "9",
    };
    await deliver(catalogEvent(initial));
    await deliver(catalogEvent(latest));
    expect(await storedStation(initial.id)).toMatchObject({
      name: "Hot kitchen",
      type: "hot_kitchen",
      target_seconds: 450,
      printer_device_id: latest.printerDeviceId,
      sync_txid: "9",
    });
    expect(await receipts()).toMatchObject([
      { aggregate_sequence: 1, outcome: "applied" },
      { aggregate_sequence: 9, outcome: "applied" },
    ]);
  });

  it("never restores stale state after a newer full-state event or its replay", async () => {
    const latest = station({ name: "Newest", syncTxid: "9" });
    const event = catalogEvent(latest);
    await deliver(event);
    await deliver(
      catalogEvent({ ...latest, name: "Old", syncTxid: "5" }),
      event,
    );
    expect(await storedStation(latest.id)).toMatchObject({
      name: "Newest",
      sync_txid: "9",
    });
    expect(await receipts()).toMatchObject([
      { aggregate_sequence: 9, outcome: "applied" },
      { aggregate_sequence: 5, outcome: "superseded" },
    ]);
    expect(await store().lastReceivedInbound()).toBe(3);
  });

  it.each(["initial", "rejected-cursor", "existing-current-cursor"] as const)(
    "preserves event version 9 through a stale version 5 %s HTTP pull and event replay",
    async (mode) => {
      const latest = station({ name: "Newest event state", syncTxid: "9" });
      const event = catalogEvent(latest);
      await deliver(event);
      const storedCursor = encodeCursor([
        "cat2",
        mode === "existing-current-cursor" ? "4" : "9",
        String(latest.id),
      ]);
      if (mode !== "initial")
        await owner.query(
          `INSERT INTO edge_pull_checkpoints
             (tenant_id, outlet_id, edge_node_id, stream, watermark, last_success_at)
           VALUES ($1, $2, $3, 'catalog:stations', $4, $5)`,
          [
            world.tenantId,
            world.outletA,
            node.scope.edgeNodeId,
            storedCursor,
            NOW,
          ],
        );
      // Rollout from an earlier build: a valid HTTP cursor proves the local
      // versions came from cloud even though that build had no init marker.
      if (mode === "existing-current-cursor")
        await owner.query(
          `DELETE FROM edge_pull_checkpoints
            WHERE edge_node_id = $1 AND stream = 'catalog:init:stations'`,
          [node.scope.edgeNodeId],
        );
      const fetchedCursors: (string | null)[] = [];
      const result = await pullCatalog({
        database: db,
        context: node.context,
        edgeNodeId: node.scope.edgeNodeId,
        streams: ["stations"],
        fetchPage: async (stream, since) => {
          fetchedCursors.push(since);
          if (mode === "rejected-cursor" && since === storedCursor)
            throw new EdgeCloudHttpError("HTTP_400");
          return {
            protocolVersion: CATALOG_PROTOCOL_VERSION,
            stream,
            records: [{ ...latest, name: "Stale HTTP state", syncTxid: "5" }],
            nextCursor: encodeCursor(["cat2", "5", String(latest.id)]),
            hasMore: false,
          };
        },
      });
      expect(result.streams.stations?.error).toBeUndefined();
      expect(fetchedCursors).toEqual(
        mode === "initial"
          ? [null]
          : mode === "rejected-cursor"
            ? [storedCursor, null]
            : [storedCursor],
      );
      // A repeated event is already acknowledged. The pull must preserve the
      // version itself; replay cannot repair a regression after deduplication.
      await deliver(event);
      expect(await storedStation(latest.id)).toMatchObject({
        name: "Newest event state",
        sync_txid: "9",
      });
      expect(await receipts()).toMatchObject([
        { aggregate_sequence: 9, outcome: "applied" },
      ]);
      const initialized = await owner.query(
        `SELECT stream FROM edge_pull_checkpoints
          WHERE edge_node_id = $1 AND stream = 'catalog:init:stations'`,
        [node.scope.edgeNodeId],
      );
      expect(initialized.rows).toEqual([{ stream: "catalog:init:stations" }]);
    },
  );

  it("preserves a later HTTP version 12 for an event-backed record during a rewind to version 5", async () => {
    const record = station({ name: "Event version 9", syncTxid: "9" });
    const event = catalogEvent(record);
    await deliver(event);
    const cursor12 = encodeCursor(["cat2", "12", String(record.id)]);
    const first = await pullCatalog({
      database: db,
      context: node.context,
      edgeNodeId: node.scope.edgeNodeId,
      streams: ["stations"],
      fetchPage: async (stream) => ({
        protocolVersion: CATALOG_PROTOCOL_VERSION,
        stream,
        records: [{ ...record, name: "HTTP version 12", syncTxid: "12" }],
        nextCursor: cursor12,
        hasMore: false,
      }),
    });
    expect(first.streams.stations?.error).toBeUndefined();
    expect(await storedStation(record.id)).toMatchObject({
      name: "HTTP version 12",
      sync_txid: "12",
    });
    const fetchedCursors: (string | null)[] = [];
    const rewound = await pullCatalog({
      database: db,
      context: node.context,
      edgeNodeId: node.scope.edgeNodeId,
      streams: ["stations"],
      fetchPage: async (stream, since) => {
        fetchedCursors.push(since);
        if (since === cursor12) throw new EdgeCloudHttpError("HTTP_400");
        return {
          protocolVersion: CATALOG_PROTOCOL_VERSION,
          stream,
          records: [{ ...record, name: "Stale HTTP version 5", syncTxid: "5" }],
          nextCursor: encodeCursor(["cat2", "5", String(record.id)]),
          hasMore: false,
        };
      },
    });
    expect(rewound.streams.stations?.error).toBeUndefined();
    expect(fetchedCursors).toEqual([cursor12, null]);
    await deliver(event);
    expect(await storedStation(record.id)).toMatchObject({
      name: "HTTP version 12",
      sync_txid: "12",
    });
  });

  it("keeps independent master records separate even with the same version", async () => {
    const first = station({ name: "First", syncTxid: "9" });
    const second = station({ name: "Second", syncTxid: "9" });
    await deliver(catalogEvent(first), catalogEvent(second));
    expect(await storedStation(first.id)).toMatchObject({ name: "First" });
    expect(await storedStation(second.id)).toMatchObject({ name: "Second" });
    expect(await receipts()).toMatchObject([
      { outcome: "applied" },
      { outcome: "applied" },
    ]);
  });

  it("never resurrects a printer deleted by event version 9 from a stale HTTP version 5", async () => {
    const initial = {
      id: randomUUID(),
      tenantId: world.tenantId,
      outletId: world.outletA,
      label: "Receipt printer",
      role: "receipt",
      stationId: null,
      transport: "network",
      host: "192.168.1.50",
      port: 9100,
      devicePath: null,
      paperWidth: 48,
      fallbackPrinterId: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      syncTxid: "1",
    };
    const printerRows = async () =>
      (
        await owner.query(
          "SELECT id FROM edge_printers WHERE tenant_id = $1 AND id = $2",
          [world.tenantId, initial.id],
        )
      ).rows;
    await deliver(catalogEvent(initial, {}, "printers"));
    expect(await printerRows()).toEqual([{ id: initial.id }]);
    const tombstone = {
      id: initial.id,
      tenantId: world.tenantId,
      outletId: world.outletA,
      deletedAt: NOW,
      syncTxid: "9",
    };
    await deliver(catalogEvent(tombstone, {}, "printers"));
    expect(await printerRows()).toEqual([]);

    const result = await pullCatalog({
      database: db,
      context: node.context,
      edgeNodeId: node.scope.edgeNodeId,
      streams: ["printers"],
      fetchPage: async (stream) => ({
        protocolVersion: CATALOG_PROTOCOL_VERSION,
        stream,
        records: [{ ...initial, label: "Stale printer", syncTxid: "5" }],
        nextCursor: encodeCursor(["cat2", "5", initial.id]),
        hasMore: false,
      }),
    });
    expect(result.streams.printers?.error).toBeUndefined();
    expect(await printerRows()).toEqual([]);
    expect(await receipts()).toMatchObject([
      { aggregate_sequence: 1, outcome: "applied" },
      { aggregate_sequence: 9, outcome: "applied" },
    ]);

    const newer = await pullCatalog({
      database: db,
      context: node.context,
      edgeNodeId: node.scope.edgeNodeId,
      streams: ["printers"],
      fetchPage: async (stream) => ({
        protocolVersion: CATALOG_PROTOCOL_VERSION,
        stream,
        records: [
          { ...initial, label: "New printer version 12", syncTxid: "12" },
        ],
        nextCursor: encodeCursor(["cat2", "12", initial.id]),
        hasMore: false,
      }),
    });
    expect(newer.streams.printers?.error).toBeUndefined();
    const recreated = await owner.query(
      `SELECT label, sync_txid::text FROM edge_printers
        WHERE tenant_id = $1 AND id = $2`,
      [world.tenantId, initial.id],
    );
    expect(recreated.rows).toEqual([
      { label: "New printer version 12", sync_txid: "12" },
    ]);
  });

  it("rolls back a printer deletion blocked by a foreign key instead of treating it as a missing reference", async () => {
    const printer = {
      id: randomUUID(),
      tenantId: world.tenantId,
      outletId: world.outletA,
      label: "Fallback",
      role: "receipt",
      stationId: null,
      transport: "network",
      host: "192.168.1.50",
      port: 9100,
      devicePath: null,
      paperWidth: 48,
      fallbackPrinterId: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      syncTxid: "1",
    };
    const dependent = {
      ...printer,
      id: randomUUID(),
      label: "Main",
      host: "192.168.1.51",
      fallbackPrinterId: printer.id,
    };
    await deliver(
      catalogEvent(printer, {}, "printers"),
      catalogEvent(dependent, {}, "printers"),
    );
    const tombstone = {
      id: printer.id,
      tenantId: world.tenantId,
      outletId: world.outletA,
      deletedAt: NOW,
      syncTxid: "9",
    };
    await owner.query(
      `CREATE TABLE edge_test_delete_ref (printer_id uuid REFERENCES edge_printers(id))`,
    );
    try {
      await owner.query(
        `INSERT INTO edge_test_delete_ref (printer_id) VALUES ($1)`,
        [printer.id],
      );
      await expect(
        deliver(catalogEvent(tombstone, {}, "printers")),
      ).rejects.toThrow();
      expect(await store().lastReceivedInbound()).toBe(2);
      expect(await receipts()).toMatchObject([
        { outcome: "applied" },
        { outcome: "applied" },
      ]);
      const remaining = await owner.query(
        `SELECT id FROM edge_printers WHERE tenant_id = $1 AND id = $2`,
        [world.tenantId, printer.id],
      );
      expect(remaining.rows).toHaveLength(1);
    } finally {
      await owner.query(`DROP TABLE edge_test_delete_ref`);
    }
  });

  it("rejects an envelope for a sibling outlet without moving the cursor", async () => {
    const record = station({ outletId: world.outletB });
    await expect(
      deliver(
        catalogEvent(record, {
          outletId: outletIdSchema.parse(world.outletB),
        }),
      ),
    ).rejects.toThrow("outside the node scope");
    expect(await storedStation(record.id)).toBeUndefined();
    expect(await receipts()).toEqual([]);
    expect(await store().lastReceivedInbound()).toBe(0);
  });

  it("refuses a foreign outlet hidden in the full record and persists no master row", async () => {
    const record = station({ outletId: world.outletB });
    const event = catalogEvent(record);
    await deliver(event);
    expect(await storedStation(record.id)).toBeUndefined();
    expect(await receipts()).toEqual([
      {
        event_id: ulidToUuid(event.id),
        aggregate_sequence: 1,
        kind: "master_data",
        outcome: "conflict",
      },
    ]);
  });

  it.each([
    "menu_categories",
    "item_variants",
    "menu_item_modifier_groups",
  ] as const)(
    "refuses %s from another brand of the same tenant, including inherited brand scope",
    async (stream) => {
      const foreignBrand = randomUUID();
      const foreignCategory = randomUUID();
      const foreignItem = randomUUID();
      const groupId = randomUUID();
      await owner.query(
        `INSERT INTO brands (id, tenant_id, slug, name)
         VALUES ($1, $2, $3, 'Foreign brand')`,
        [foreignBrand, world.tenantId, `foreign-${foreignBrand}`],
      );
      await owner.query(
        `INSERT INTO menu_categories (id, tenant_id, brand_id, name)
         VALUES ($1, $2, $3, 'Foreign category')`,
        [foreignCategory, world.tenantId, foreignBrand],
      );
      await owner.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name)
         VALUES ($1, $2, $3, $4, 'Foreign item')`,
        [foreignItem, world.tenantId, foreignBrand, foreignCategory],
      );
      await owner.query(
        `INSERT INTO modifier_groups (id, tenant_id, name, min_select, max_select)
         VALUES ($1, $2, 'Shared modifiers', 0, 1)`,
        [groupId, world.tenantId],
      );
      const id = randomUUID();
      const stamps = {
        tenantId: world.tenantId,
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
        syncTxid: "1",
      };
      const record =
        stream === "menu_categories"
          ? category({ id, brandId: foreignBrand })
          : stream === "item_variants"
            ? {
                ...stamps,
                id,
                menuItemId: foreignItem,
                name: "Foreign variant",
                recipeId: null,
              }
            : {
                ...stamps,
                menuItemId: foreignItem,
                groupId,
                sortOrder: 0,
              };
      await deliver(catalogEvent(record, {}, stream));
      const inserted =
        stream === "menu_item_modifier_groups"
          ? await owner.query(
              `SELECT 1 FROM menu_item_modifier_groups
                WHERE tenant_id = $1 AND menu_item_id = $2 AND group_id = $3`,
              [world.tenantId, foreignItem, groupId],
            )
          : await owner.query(
              `SELECT 1 FROM ${stream} WHERE tenant_id = $1 AND id = $2`,
              [world.tenantId, id],
            );
      expect(inserted.rows).toEqual([]);
      expect(await receipts()).toMatchObject([{ outcome: "conflict" }]);
    },
  );

  it("refuses an envelope version that differs from its record version", async () => {
    const record = station({ syncTxid: "9" });
    await deliver(catalogEvent(record, { sequence: 100 }));
    expect(await storedStation(record.id)).toBeUndefined();
    expect(await receipts()).toMatchObject([{ outcome: "conflict" }]);
    await deliver(catalogEvent(record));
    expect(await storedStation(record.id)).toMatchObject({ sync_txid: "9" });
    expect(await receipts()).toMatchObject([
      { aggregate_sequence: 100, outcome: "conflict" },
      { aggregate_sequence: 9, outcome: "applied" },
    ]);
  });

  it("refuses an aggregate id that does not identify the payload record", async () => {
    const record = station();
    await deliver(catalogEvent(record, { aggregateId: randomUUID() }));
    expect(await storedStation(record.id)).toBeUndefined();
    expect(await receipts()).toMatchObject([{ outcome: "conflict" }]);
  });

  it("defers a child until its parent arrives and HTTP pull restores the child", async () => {
    const parent = category({ name: "Parent", syncTxid: "9" });
    const child = category({ name: "Child", parentId: parent.id });
    const readChild = async () => {
      const result = await owner.query<{
        parent_id: string | null;
        sync_txid: string;
      }>(
        `SELECT parent_id::text, sync_txid::text FROM menu_categories
          WHERE tenant_id = $1 AND id = $2`,
        [world.tenantId, child.id],
      );
      return result.rows[0];
    };
    await deliver(catalogEvent(child, {}, "menu_categories"));
    expect(await readChild()).toBeUndefined();
    await deliver(catalogEvent(parent, {}, "menu_categories"));
    const result = await pullCatalog({
      database: db,
      context: node.context,
      edgeNodeId: node.scope.edgeNodeId,
      streams: ["menu_categories"],
      fetchPage: async (stream) => ({
        protocolVersion: CATALOG_PROTOCOL_VERSION,
        stream,
        records: [child],
        nextCursor: encodeCursor(["cat2", "1", String(child.id)]),
        hasMore: false,
      }),
    });
    expect(result.streams.menu_categories?.error).toBeUndefined();
    expect(await readChild()).toEqual({ parent_id: parent.id, sync_txid: "1" });
    expect(await receipts()).toMatchObject([
      { outcome: "deferred" },
      { outcome: "applied" },
    ]);
  });

  it("refuses a partial record instead of treating a change hint as full state", async () => {
    const record = station();
    const event = catalogEvent(record);
    await expect(
      deliver(
        eventEnvelopeSchema.parse({
          ...event,
          payload: {
            stream: "stations",
            record: { id: record.id, tenantId: world.tenantId, syncTxid: "1" },
          },
        }),
      ),
    ).rejects.toThrow();
    expect(await storedStation(record.id)).toBeUndefined();
    expect(await receipts()).toEqual([]);
    expect(await store().lastReceivedInbound()).toBe(0);
  });
});
