// legend-3k41y second opinion finding 2 (docs/briefs/789-edge-master-sync-ordering.md):
// a printer deletion applied from the catalog HTTP pull must keep its version
// durably, so a later live event with an older (or equal) version cannot bring
// the printer back. Spec: "versi <= tombstone ditolak", for a row that was
// deleted and for a row kept (retired) because print jobs still reference it.
// Contract assumption: the event `sequence` is the record's `syncTxid`, as in
// edge-master-data-applier.test.ts. A newer version (> tombstone) may revive.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createUlid,
  encodeCursor,
  outletIdSchema,
  tenantIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { CATALOG_PROTOCOL_VERSION } from "@starter/shared/edge";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { db } from "../db/index.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { pullCatalog } from "../edge/catalog-puller.ts";
import {
  catalogRecordAggregateId,
  registerMasterDataEdgeApplier,
} from "../edge/master-data-applier.ts";
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
    label: "Printer tombstone version test",
  });
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Test node did not authenticate");
  node = authenticated;
});

afterEach(() => resetEdgeApplierRegistryForTests());
afterAll(async () => owner.end());

function printer(syncTxid: string, label: string, id = randomUUID()) {
  return {
    id,
    tenantId: world.tenantId,
    outletId: world.outletA,
    label,
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
    syncTxid,
  } satisfies CatalogRecord;
}

function tombstoneOf(id: string, syncTxid: string): CatalogRecord {
  return {
    id,
    tenantId: world.tenantId,
    outletId: world.outletA,
    deletedAt: NOW,
    syncTxid,
  };
}

function liveEvent(record: CatalogRecord): EventEnvelope {
  const id = createUlid();
  return eventEnvelopeSchema.parse({
    id,
    tenantId: world.tenantId,
    outletId: world.outletA,
    name: "catalog_record.updated",
    version: 1,
    aggregateType: "catalog_record",
    aggregateId: catalogRecordAggregateId("printers", record),
    sequence: Number(record.syncTxid),
    occurredAt: NOW,
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `printer-tombstone:${id}`,
    payloadSchemaRef: "catalog_record.updated.v1",
    payload: { stream: "printers", record },
  });
}

async function deliverLive(record: CatalogRecord) {
  const link = createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "edge_to_cloud",
  });
  const fromSeq = await link.lastReceivedInbound();
  await link.applyInbound({
    fromSeq,
    toSeq: fromSeq + 1,
    events: [{ linkSeq: fromSeq + 1, event: liveEvent(record) }],
  });
}

/** The tombstone arrives through the HTTP catalog pull. */
async function pullTombstone(id: string, syncTxid: string) {
  const result = await pullCatalog({
    database: db,
    context: node.context,
    edgeNodeId: node.scope.edgeNodeId,
    streams: ["printers"],
    fetchPage: async (stream) => ({
      protocolVersion: CATALOG_PROTOCOL_VERSION,
      stream,
      records: [tombstoneOf(id, syncTxid)],
      nextCursor: encodeCursor(["cat2", syncTxid, id]),
      hasMore: false,
    }),
  });
  expect(result.streams.printers?.error).toBeUndefined();
}

async function printerRow(id: string) {
  const result = await owner.query<{
    label: string;
    retired_at: Date | null;
  }>(
    "SELECT label, retired_at FROM edge_printers WHERE tenant_id = $1 AND id = $2",
    [world.tenantId, id],
  );
  return result.rows;
}

async function addPrintJob(printerId: string) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO edge_print_jobs (id, tenant_id, outlet_id, printer_id, kind, content, idempotency_key)
       VALUES ($1, $2, $3, $4, 'receipt', '\\x1b40', $5)`,
      [
        randomUUID(),
        world.tenantId,
        world.outletA,
        printerId,
        `job-${randomUUID()}`,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("legend-3k41y printer tombstone keeps its version", () => {
  it("a printer deleted through the HTTP pull stays deleted when an older live event arrives", async () => {
    const live = printer("1", "Receipt printer");
    await deliverLive(live);
    expect(await printerRow(live.id)).toHaveLength(1);

    await pullTombstone(live.id, "9");
    expect(await printerRow(live.id)).toEqual([]);

    await deliverLive({ ...live, label: "Stale live event", syncTxid: "5" });
    expect(await printerRow(live.id)).toEqual([]);
  });

  it("a live event with the same version as the tombstone is rejected too", async () => {
    const live = printer("1", "Receipt printer");
    await deliverLive(live);
    await pullTombstone(live.id, "9");

    await deliverLive({ ...live, label: "Same version", syncTxid: "9" });
    expect(await printerRow(live.id)).toEqual([]);
  });

  it("a newer live event after the tombstone brings the printer back", async () => {
    const live = printer("1", "Receipt printer");
    await deliverLive(live);
    await pullTombstone(live.id, "9");
    await deliverLive({ ...live, label: "Stale live event", syncTxid: "5" });

    await deliverLive({ ...live, label: "Printer version 12", syncTxid: "12" });
    expect(await printerRow(live.id)).toMatchObject([
      { label: "Printer version 12", retired_at: null },
    ]);
  });

  it("a printer kept for its print jobs stays retired when an older live event arrives", async () => {
    const live = printer("1", "Receipt printer");
    await deliverLive(live);
    await addPrintJob(live.id);

    await pullTombstone(live.id, "9");
    const retired = await printerRow(live.id);
    expect(retired).toHaveLength(1);
    expect(retired[0]?.retired_at).not.toBeNull();

    await deliverLive({ ...live, label: "Stale live event", syncTxid: "5" });
    const after = await printerRow(live.id);
    expect(after).toHaveLength(1);
    expect(after[0]?.retired_at).not.toBeNull();
    expect(after[0]?.label).toBe("Receipt printer");
  });

  it("a retired printer ignores a live event with the same version as the tombstone", async () => {
    const live = printer("1", "Receipt printer");
    await deliverLive(live);
    await addPrintJob(live.id);
    await pullTombstone(live.id, "9");

    await deliverLive({ ...live, label: "Same version", syncTxid: "9" });
    const after = await printerRow(live.id);
    expect(after[0]?.retired_at).not.toBeNull();
    expect(after[0]?.label).toBe("Receipt printer");
  });

  it("a newer live event revives a retired printer", async () => {
    const live = printer("1", "Receipt printer");
    await deliverLive(live);
    await addPrintJob(live.id);
    await pullTombstone(live.id, "9");
    await deliverLive({ ...live, label: "Stale live event", syncTxid: "5" });

    await deliverLive({ ...live, label: "Printer version 12", syncTxid: "12" });
    expect(await printerRow(live.id)).toMatchObject([
      { label: "Printer version 12", retired_at: null },
    ]);
  });
});
