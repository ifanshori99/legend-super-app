// legend-fbf4v: cloud printer registry reaches the edge through the catalog
// pipeline. Written from docs/CONTRACT-style reasoning and the shared catalog
// contract (`packages/shared/src/edge/catalog-sync.ts`), NOT from the
// implementation (the design does not exist yet). Fail-first: the `printers`
// stream is missing today.
//
// ASSUMED CONTRACT (the implementer follows this, or tells the test-writer):
//  1. New catalog stream named "printers", appended to CATALOG_SYNC_STREAMS
//     (after "stations": printers point at stations by plain uuid, so order is
//     free; the tests do not depend on position). Same page shape, `cat2`
//     cursor and `sync_txid` rules as every other stream, served by
//     `listCatalogRecordsSince(db, { tenantId, outletId, query })` and applied
//     on the edge by `pullCatalog` (stream list passed in `streams`).
//     Why catalog and not the older device-registry pull: it has txid-safe
//     cursors, checkpoints, per-stream errors and the CLOUD_OUTDATED gate.
//  2. Scope: outlet scoped. The edge of outlet O in tenant T receives exactly
//     the printers with tenant_id = T and outlet_id = O. Nothing else, ever.
//  3. Record (strict object, added to `catalogSyncRecordSchemas`):
//       { id, tenantId, outletId, label, role: "receipt"|"station",
//         stationId: uuid|null, transport: "network"|"usb", host: string|null,
//         port: number|null, devicePath: string|null, paperWidth: 32|48,
//         fallbackPrinterId: uuid|null, createdAt, updatedAt,
//         deletedAt: iso|null, syncTxid }
//     `status`, `lastSeenAt`, `offlineSince` are NOT in the record: they are
//     measured by the print agent on the edge (edge-owned runtime state). A
//     cloud update must therefore never overwrite the edge's own status.
//  4. Delete: the cloud CRUD deletes the row (hard delete, see
//     printer-registry.test.ts), so the stream carries a TOMBSTONE: a record
//     with the printer's `id`, `tenantId`, `outletId` and a non-null
//     `deletedAt`. The edge removes its `edge_printers` row. A tombstone for a
//     printer the edge never had is a harmless no-op (the pull does not fail).
//     (Other fields of a tombstone are not asserted.)
//  5. Edge apply is idempotent and keeps the edge row under the SAME id as the
//     cloud printer (so print jobs and the station's printer_device_id match).
//
// Setup: cloud = main test database (tenant A with outlets A1, A2; tenant B
// with its own outlet). Edge = second database (helpers/edge-database.ts) for
// outlet A1. Cloud writes go through the public HTTP CRUD (as in
// printer-registry.test.ts), so the tests do not depend on how the
// implementation tracks changes or tombstones. The cloud is read through
// `listCatalogRecordsSince` and fed to `pullCatalog` as its `fetchPage`.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
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
  CATALOG_SYNC_STREAMS,
  catalogSyncPageSchema,
  catalogSyncQuerySchema,
} from "@starter/shared/edge";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { pullCatalog } from "../edge/catalog-puller.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { listCatalogRecordsSince } from "../services/edge-catalog-sync.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { settleCloud } from "./helpers/catalog-cloud.ts";
import {
  createEdgeDatabase,
  type EdgeDatabase,
} from "./helpers/edge-database.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

type Rec = Record<string, unknown>;
type Page = {
  protocolVersion: number;
  stream: string;
  records: Rec[];
  nextCursor: string | null;
  hasMore: boolean;
};
type Member = { client: ReturnType<typeof agent>; userId: string };
type Headers = { Host: string };
type PullResult = {
  streams: Record<string, { error?: unknown } | undefined>;
};

const STREAM = "printers";
const CHECKPOINT = `catalog:${STREAM}`;

let app: Express;
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let headersA: Headers;
let headersB: Headers;
let outletA1 = "";
let outletA2 = "";
let outletA3Empty = ""; // an outlet of tenant A that never gets a printer
let managerA: Member;
let managerB: Member;
let stationA1 = "";
let edge: EdgeDatabase;
let nodeId = "";

// ---------------------------------------------------------------- helpers

const norm = (id: string) =>
  id.includes("-") ? id.toLowerCase() : ulidToUuid(id);
const sameId = (a: unknown, b: unknown) => norm(String(a)) === norm(String(b));

const scope = (source: "session" | "device") =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantA.tenantId),
      brandId: null,
      source,
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletA1)] },
  );

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

async function insertRole(tenantId: string, permissions: string[]) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Pengelola Perangkat', false, NULL, $3, false, '["tenant","outlet"]')`,
    [id, tenantId, JSON.stringify(permissions)],
  );
  return id;
}

async function member(
  tenant: IsolatedTenant,
  roleId: string,
  label: string,
): Promise<Member> {
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

async function insertOutlet(tenant: IsolatedTenant, code: string) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $5, 'Jl. Uji', 'Asia/Jakarta', $6, 'active')`,
    [
      id,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      code,
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  return id;
}

let sequence = 0;
const networkBody = (outletId: string, over: Rec = {}): Rec => {
  sequence += 1;
  return {
    outletId,
    label: `Printer sync ${sequence}`,
    role: "receipt",
    transport: "network",
    host: "192.168.1.50",
    port: 9100,
    paperWidth: 48,
    ...over,
  };
};

/** Cloud create through HTTP; returns the printer id as a uuid. */
async function cloudCreate(
  who: Member,
  headers: Headers,
  body: Rec,
): Promise<string> {
  const response = await who.client
    .post("/api/printers")
    .set(headers)
    .set(originHeader)
    .send(body);
  expect(response.status).toBe(201);
  return norm(String(response.body.data.id));
}

async function cloudPatch(id: string, body: Rec) {
  const response = await managerA.client
    .patch(`/api/printers/${encodeURIComponent(id)}`)
    .set(headersA)
    .set(originHeader)
    .send(body);
  expect(response.status).toBe(200);
}

async function cloudDelete(id: string) {
  const response = await managerA.client
    .delete(`/api/printers/${encodeURIComponent(id)}`)
    .set(headersA)
    .set(originHeader);
  expect([200, 204]).toContain(response.status);
}

/** One page of the cloud's `printers` stream for an edge of (tenant, outlet). */
async function cloudPage(
  input: { tenantId: string; outletId: string },
  since?: string,
  limit = 100,
): Promise<Page> {
  // Explicit first assertion: the missing stream must fail as "missing stream",
  // not as an obscure schema error from the query parser.
  expect(CATALOG_SYNC_STREAMS).toContain(STREAM);
  return (await listCatalogRecordsSince(db, {
    tenantId: tenantIdSchema.parse(input.tenantId),
    outletId: outletIdSchema.parse(input.outletId),
    query: catalogSyncQuerySchema.parse({
      stream: STREAM,
      protocolVersion: CATALOG_PROTOCOL_VERSION,
      limit,
      ...(since === undefined ? {} : { since }),
    }),
  })) as unknown as Page;
}

async function allCloudRecords(
  input: { tenantId: string; outletId: string },
  limit = 100,
): Promise<Rec[]> {
  const records: Rec[] = [];
  let since: string | undefined;
  for (let count = 0; count < 1000; count += 1) {
    const next = await cloudPage(input, since, limit);
    records.push(...next.records);
    if (!next.hasMore) return records;
    expect(next.nextCursor).not.toBeNull();
    since = next.nextCursor!;
  }
  throw new Error("Printer stream did not finish paging");
}

const edgeScopeInput = () => ({
  tenantId: tenantA.tenantId,
  outletId: outletA1,
});

/** Waits for the cloud's commit-safe boundary, then pulls the stream. */
async function pull(limit = 100): Promise<PullResult> {
  await settleCloud(owner);
  const result = (await pullCatalog({
    database: edge.database as typeof db,
    context: scope("device"),
    edgeNodeId: nodeId,
    // "printers" is not in the stream union until it is implemented.
    streams: [STREAM] as never,
    fetchPage: (stream: string, since: string | null) =>
      cloudPage(edgeScopeInput(), since ?? undefined, limit),
  })) as unknown as PullResult;
  expect(result.streams[STREAM]?.error).toBeUndefined();
  return result;
}

const edgePrinter = async (id: string) =>
  (await edge.rows("SELECT * FROM edge_printers WHERE id = $1::uuid", [id]))[0];

const edgePrinterIds = async () =>
  (await edge.rows("SELECT id FROM edge_printers")).map((r) => String(r.id));

const checkpoint = async () =>
  (
    await edge.rows(
      "SELECT watermark FROM edge_pull_checkpoints WHERE edge_node_id = $1 AND stream = $2",
      [nodeId, CHECKPOINT],
    )
  )[0]?.watermark as string | undefined;

async function resetEdge() {
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("DELETE FROM edge_printers");
    await client.query("DELETE FROM edge_pull_checkpoints");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------------ setup

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setAuditWriter(coreAuditWriter);
  tenantA = await createIsolatedTenant(`prs-a-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`prs-b-${randomUUID().slice(0, 6)}`);
  headersA = { Host: tenantA.hostname };
  headersB = { Host: tenantB.hostname };
  outletA1 = tenantA.outletId;
  outletA2 = await insertOutlet(tenantA, "PRS-A2");
  outletA3Empty = await insertOutlet(tenantA, "PRS-A3");
  stationA1 = randomUUID();
  await asOwnerTenant(tenantA.tenantId, (client) =>
    client.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'Bar A1', 'beverage_bar')`,
      [stationA1, tenantA.tenantId, outletA1],
    ),
  );
  managerA = await member(
    tenantA,
    await insertRole(tenantA.tenantId, ["device.registry.manage"]),
    "Manajer sync A",
  );
  managerB = await member(
    tenantB,
    await insertRole(tenantB.tenantId, ["device.registry.manage"]),
    "Manajer sync B",
  );

  const registered = await registerEdgeNode(scope("session"), randomUUID(), {
    outletId: outletA1,
    role: "standby",
    label: "Edge sync printer",
  });
  nodeId = registered.edgeNode.id;
  edge = await createEdgeDatabase({
    tenantId: tenantA.tenantId,
    outletId: outletA1,
  });
  const node = await owner.query(
    "SELECT row_to_json(t) AS row FROM edge_nodes t WHERE id = $1",
    [nodeId],
  );
  await edge.owner.query(
    "INSERT INTO edge_nodes SELECT * FROM json_populate_record(NULL::edge_nodes, $1::json)",
    [JSON.stringify(node.rows[0].row)],
  );
}, 240_000);

beforeEach(async () => {
  await resetEdge();
});

afterAll(async () => {
  setAuditWriter(null);
  await edge?.cleanup();
  // Edge and audit rows are append-only, so the isolated tenants stay in the
  // disposable database; give them a valid creator (as printer-registry.test).
  for (const tenant of [tenantA, tenantB])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      tenant.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

// ------------------------------------------------------------- main flow

describe("legend-fbf4v printers stream: cloud to edge", () => {
  it("the cloud serves a printer record that passes the shared page schema", async () => {
    const id = await cloudCreate(
      managerA,
      headersA,
      networkBody(outletA1, {
        label: "Kasir Depan",
        host: "10.1.2.3",
        port: 9101,
        paperWidth: 32,
      }),
    );
    await settleCloud(owner);
    const page = await cloudPage(edgeScopeInput());
    // Validates the whole page, record included, with the shared contract.
    expect(() => catalogSyncPageSchema.parse(page)).not.toThrow();
    const record = page.records.find((r) => sameId(r.id, id));
    expect(record).toMatchObject({
      label: "Kasir Depan",
      role: "receipt",
      transport: "network",
      host: "10.1.2.3",
      port: 9101,
      devicePath: null,
      paperWidth: 32,
      stationId: null,
      fallbackPrinterId: null,
      deletedAt: null,
    });
    expect(sameId(record!.tenantId, tenantA.tenantId)).toBe(true);
    expect(sameId(record!.outletId, outletA1)).toBe(true);
    // Edge-owned runtime state never travels.
    for (const key of ["status", "lastSeenAt", "offlineSince"])
      expect(record).not.toHaveProperty(key);
  });

  it("a new cloud printer lands on the edge with the same id and fields", async () => {
    const id = await cloudCreate(
      managerA,
      headersA,
      networkBody(outletA1, {
        label: "Bar Utama",
        host: "172.16.4.9",
        port: 9102,
        paperWidth: 32,
      }),
    );
    expect(await edgePrinter(id)).toBeUndefined();
    await pull();
    expect(await edgePrinter(id)).toMatchObject({
      id,
      tenant_id: tenantA.tenantId,
      outlet_id: outletA1,
      label: "Bar Utama",
      role: "receipt",
      station_id: null,
      transport: "network",
      host: "172.16.4.9",
      port: 9102,
      device_path: null,
      paper_width: 32,
      fallback_printer_id: null,
    });
    expect(await checkpoint()).toBeTruthy();
  });

  it("a usb station printer keeps its station, device path and fallback", async () => {
    const fallbackId = await cloudCreate(
      managerA,
      headersA,
      networkBody(outletA1, { label: "Cadangan" }),
    );
    const id = await cloudCreate(managerA, headersA, {
      outletId: outletA1,
      label: "Printer bar USB",
      role: "station",
      stationId: stationA1,
      transport: "usb",
      devicePath: "/dev/usb/lp0",
      paperWidth: 48,
      fallbackPrinterId: fallbackId,
    });
    await pull();
    expect(await edgePrinter(fallbackId)).toBeDefined();
    expect(await edgePrinter(id)).toMatchObject({
      role: "station",
      station_id: stationA1,
      transport: "usb",
      device_path: "/dev/usb/lp0",
      host: null,
      port: null,
      fallback_printer_id: fallbackId,
    });
  });

  it("a cloud update reaches the edge and a second pull is idempotent", async () => {
    const id = await cloudCreate(
      managerA,
      headersA,
      networkBody(outletA1, { label: "Sebelum" }),
    );
    await pull();
    expect((await edgePrinter(id))?.label).toBe("Sebelum");

    await cloudPatch(id, {
      label: "Sesudah",
      transport: "network",
      host: "192.168.77.8",
      port: 9101,
    });
    await pull();
    expect(await edgePrinter(id)).toMatchObject({
      label: "Sesudah",
      host: "192.168.77.8",
      port: 9101,
    });

    const before = (await edgePrinterIds()).length;
    await pull();
    await pull();
    expect((await edgePrinterIds()).length).toBe(before);
    expect((await edgePrinter(id))?.label).toBe("Sesudah");
  });

  it("a cloud update never overwrites the status the edge measured itself", async () => {
    const id = await cloudCreate(
      managerA,
      headersA,
      networkBody(outletA1, { label: "Status lokal" }),
    );
    await pull();
    await edge.owner.query(
      "UPDATE edge_printers SET status = 'online', last_seen_at = now() WHERE id = $1::uuid",
      [id],
    );
    await cloudPatch(id, { label: "Status lokal diganti" });
    await pull();
    expect(await edgePrinter(id)).toMatchObject({
      label: "Status lokal diganti",
      status: "online",
    });
    expect((await edgePrinter(id))?.last_seen_at).not.toBeNull();
  });

  it("a status update by the edge print agent keeps the cloud's sync_txid (only the registry fields restamp)", async () => {
    const id = await cloudCreate(
      managerA,
      headersA,
      networkBody(outletA1, { label: "Detak jantung" }),
    );
    await pull();
    const stamp = async () => String((await edgePrinter(id))?.sync_txid);
    const before = await stamp();
    // Edge-local writes without skip_sync_txid, as the print agent does.
    await edge.owner.query(
      "UPDATE edge_printers SET status = 'online', last_seen_at = now(), updated_at = now() WHERE id = $1::uuid",
      [id],
    );
    await edge.owner.query(
      "UPDATE edge_printers SET status = 'offline', offline_since = now() WHERE id = $1::uuid",
      [id],
    );
    expect(await stamp()).toBe(before);
    // A registry change made on the edge is still stamped (not a heartbeat).
    await edge.owner.query(
      "UPDATE edge_printers SET label = 'Lokal' WHERE id = $1::uuid",
      [id],
    );
    expect(await stamp()).not.toBe(before);
  });

  it("a cloud update after an edge status update still reaches the edge", async () => {
    const id = await cloudCreate(
      managerA,
      headersA,
      networkBody(outletA1, { label: "Setelah detak" }),
    );
    await pull();
    await edge.owner.query(
      "UPDATE edge_printers SET status = 'online', last_seen_at = now() WHERE id = $1::uuid",
      [id],
    );
    await cloudPatch(id, { label: "Cloud menang" });
    await pull();
    expect(await edgePrinter(id)).toMatchObject({
      label: "Cloud menang",
      status: "online",
    });
  });

  it("a fallback that arrives on a later page is linked afterwards", async () => {
    const fallbackId = await cloudCreate(
      managerA,
      headersA,
      networkBody(outletA1, { label: "Cadangan terlambat" }),
    );
    const id = await cloudCreate(
      managerA,
      headersA,
      networkBody(outletA1, {
        label: "Utama",
        fallbackPrinterId: fallbackId,
      }),
    );
    // Restamp the fallback so it sorts after the printer that points at it.
    await cloudPatch(fallbackId, { label: "Cadangan terlambat 2" });
    await pull(1);
    expect(await edgePrinter(fallbackId)).toBeDefined();
    expect((await edgePrinter(id))?.fallback_printer_id).toBe(fallbackId);
    // Idempotent: nothing left to repair, nothing changes.
    await pull(1);
    expect((await edgePrinter(id))?.fallback_printer_id).toBe(fallbackId);
  });

  it("deleting a printer in the cloud removes it from the edge", async () => {
    const keep = await cloudCreate(managerA, headersA, networkBody(outletA1));
    const gone = await cloudCreate(managerA, headersA, networkBody(outletA1));
    await pull();
    expect(await edgePrinter(gone)).toBeDefined();

    await cloudDelete(gone);
    await settleCloud(owner);
    // The cloud announces the deletion as a tombstone.
    const tombstone = (await allCloudRecords(edgeScopeInput())).find((r) =>
      sameId(r.id, gone),
    );
    expect(tombstone?.deletedAt).toEqual(expect.any(String));

    await pull();
    expect(await edgePrinter(gone)).toBeUndefined();
    expect(await edgePrinter(keep)).toBeDefined();
  });

  it("a printer created and deleted before the first pull does not break the pull", async () => {
    const id = await cloudCreate(managerA, headersA, networkBody(outletA1));
    await cloudDelete(id);
    await pull();
    expect(await edgePrinter(id)).toBeUndefined();
  });

  it("pages through printers with a small limit without losing or repeating any", async () => {
    const created = [
      await cloudCreate(managerA, headersA, networkBody(outletA1)),
      await cloudCreate(managerA, headersA, networkBody(outletA1)),
      await cloudCreate(managerA, headersA, networkBody(outletA1)),
    ];
    await settleCloud(owner);
    const records = await allCloudRecords(edgeScopeInput(), 1);
    const ids = records.map((r) => String(r.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of created)
      expect(ids.some((seen) => sameId(seen, id))).toBe(true);
  });
});

// ------------------------------------------------------------- isolation

describe("legend-fbf4v printers stream: tenant and outlet isolation", () => {
  it("the edge of outlet A1 gets only A1 printers, never another outlet or tenant", async () => {
    const own = await cloudCreate(
      managerA,
      headersA,
      networkBody(outletA1, { label: "Milik A1" }),
    );
    const sibling = await cloudCreate(
      managerA,
      headersA,
      networkBody(outletA2, { label: "Milik A2" }),
    );
    const foreign = await cloudCreate(
      managerB,
      headersB,
      networkBody(tenantB.outletId, { label: "Milik tenant B" }),
    );
    await settleCloud(owner);

    const records = await allCloudRecords(edgeScopeInput());
    expect(records.some((r) => sameId(r.id, own))).toBe(true);
    expect(records.some((r) => sameId(r.id, sibling))).toBe(false);
    expect(records.some((r) => sameId(r.id, foreign))).toBe(false);
    for (const record of records) {
      expect(sameId(record.tenantId, tenantA.tenantId)).toBe(true);
      expect(sameId(record.outletId, outletA1)).toBe(true);
    }

    await pull();
    const ids = await edgePrinterIds();
    expect(ids).toContain(own);
    expect(ids).not.toContain(sibling);
    expect(ids).not.toContain(foreign);
    const rows = await edge.rows(
      "SELECT tenant_id, outlet_id FROM edge_printers",
    );
    for (const row of rows) {
      expect(row.tenant_id).toBe(tenantA.tenantId);
      expect(row.outlet_id).toBe(outletA1);
    }
  });

  it("deleting a printer of another outlet or tenant does not touch the edge", async () => {
    const own = await cloudCreate(managerA, headersA, networkBody(outletA1));
    const sibling = await cloudCreate(
      managerA,
      headersA,
      networkBody(outletA2),
    );
    await pull();
    await cloudDelete(sibling);
    await pull();
    expect(await edgePrinter(own)).toBeDefined();
    expect(await edgePrinterIds()).not.toContain(sibling);
    // Tombstones of other outlets are not announced to this edge either.
    await settleCloud(owner);
    const records = await allCloudRecords(edgeScopeInput());
    expect(records.some((r) => sameId(r.id, sibling))).toBe(false);
  });

  it("an update of another outlet's printer does not appear in this edge's stream", async () => {
    const sibling = await cloudCreate(
      managerA,
      headersA,
      networkBody(outletA2, { label: "Awal A2" }),
    );
    await pull();
    await cloudPatch(sibling, { label: "Berubah A2" });
    await pull();
    expect(await edgePrinterIds()).not.toContain(sibling);
    await settleCloud(owner);
    const records = await allCloudRecords(edgeScopeInput());
    expect(records.some((r) => sameId(r.id, sibling))).toBe(false);
  });
});

// ------------------------------------------------------------ empty state

describe("legend-fbf4v printers stream: empty state", () => {
  it("an outlet without printers gets an empty, finished page", async () => {
    await settleCloud(owner);
    const page = await cloudPage({
      tenantId: tenantA.tenantId,
      outletId: outletA3Empty,
    });
    expect(page.records).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it("pulling when the cloud has no printer for the edge leaves the edge empty and does not fail", async () => {
    const result = (await pullCatalog({
      database: edge.database as typeof db,
      context: scope("device"),
      edgeNodeId: nodeId,
      streams: [STREAM] as never,
      // An empty cloud page: no printers for this outlet.
      fetchPage: async (_stream: string, since: string | null) => ({
        protocolVersion: CATALOG_PROTOCOL_VERSION,
        stream: STREAM,
        records: [],
        nextCursor: since,
        hasMore: false,
      }),
    })) as unknown as PullResult;
    expect(result.streams[STREAM]?.error).toBeUndefined();
    expect(await edgePrinterIds()).toEqual([]);
  });
});
