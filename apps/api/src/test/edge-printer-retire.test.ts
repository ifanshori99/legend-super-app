// legend-fbf4v follow-up: a printer deleted in the cloud but still referenced by
// print jobs on the edge is RETIRED on the edge, not deleted. Written from the
// CTO decision in the brief (option 1), NOT from the implementation. Fail-first:
// the `retired_at` column and the retire behavior do not exist yet.
//
// ASSUMED CONTRACT:
//  1. Column `edge_printers.retired_at timestamptz NULL` (migration 0338).
//     Edge-owned state, like status/last_seen_at: it is never part of the cloud
//     record and never changes `sync_txid` (neither when the edge sets it nor
//     when the print agent updates status/last_seen_at/offline_since).
//  2. Tombstone (cloud record with the printer `id` and non-null `deletedAt`)
//     applied on the edge by `pullCatalog`:
//       - printer has NO row in `edge_print_jobs`: row is deleted (as before);
//       - printer HAS at least one job: row stays, `retired_at` is set (not
//         null), the job stays readable through the print store (`getJob`,
//         `listJobs`) with the same `printerId`.
//     Re-applying the same tombstone is idempotent (row stays, still retired).
//  3. `createDbPrintStore(...).listPrinters()` (edge/print/store.ts) excludes
//     retired printers; live printers stay listed. `getJob`/`listJobs` of old
//     jobs are unaffected. (`getPrinter` of a retired printer is NOT asserted.)
//  4. A live cloud record with the SAME id as a retired printer (cloud update or
//     cloud re-insert) clears `retired_at` back to NULL and restores the fields
//     from the cloud record. Re-insert is simulated by copying the cloud rows
//     (`devices` and `edge_printers`, same id) back with `json_populate_record`
//     and without `sync_txid`, assuming the insert stamps a fresh `sync_txid`
//     like every other catalog table.
//  5. Isolation: apply is keyed on (tenant, outlet, id). A tombstone retires or
//     deletes only the edge's own printer; printers of another outlet or tenant
//     already in the edge database are untouched (row, `retired_at`, jobs), even
//     when a (forged) tombstone names their id. Those foreign rows and jobs are
//     seeded as the edge superuser with `session_replication_role = replica`
//     (skips FKs and triggers), omitting `sync_txid`.
//
// Setup mirrors edge-printer-registry-sync.test.ts: cloud = main test database
// written through the HTTP CRUD, edge = second database for outlet A1, fed by
// `pullCatalog` with the cloud's `listCatalogRecordsSince` as `fetchPage`.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  uuidToUlid,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  CATALOG_PROTOCOL_VERSION,
  catalogSyncQuerySchema,
} from "@starter/shared/edge";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { pullCatalog } from "../edge/catalog-puller.ts";
import { createDbPrintStore } from "../edge/print/store.ts";
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
type FetchPage = (stream: string, since: string | null) => Promise<Page>;

const STREAM = "printers";
const CHECKPOINT = `catalog:${STREAM}`;

let app: Express;
let tenantA: IsolatedTenant;
let headersA: Headers;
let outletA1 = "";
let managerA: Member;
let edge: EdgeDatabase;
let nodeId = "";

// Foreign scopes that only ever exist as edge rows (see assumption 5).
const siblingOutlet = randomUUID(); // other outlet, same tenant
const foreignTenant = randomUUID();
const foreignTenantOutlet = randomUUID();

// ---------------------------------------------------------------- helpers

const norm = (id: string) =>
  id.includes("-") ? id.toLowerCase() : ulidToUuid(id);
const sameId = (a: unknown, b: unknown) => norm(String(a)) === norm(String(b));
// The print store takes job ids as ULID (it applies ulidToUuid); the edge_print_jobs
// column holds the UUID form. Ids the store returns may be either form, so
// comparisons go through sameId.
const jobUlid = (uuid: string) => uuidToUlid(uuid);

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

let sequence = 0;
const networkBody = (over: Rec = {}): Rec => {
  sequence += 1;
  return {
    outletId: outletA1,
    label: `Printer retire ${sequence}`,
    role: "receipt",
    transport: "network",
    host: "192.168.1.60",
    port: 9100,
    paperWidth: 48,
    ...over,
  };
};

async function cloudCreate(body: Rec = networkBody()): Promise<string> {
  const response = await managerA.client
    .post("/api/printers")
    .set(headersA)
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

async function cloudPage(since?: string, limit = 100): Promise<Page> {
  return (await listCatalogRecordsSince(db, {
    tenantId: tenantIdSchema.parse(tenantA.tenantId),
    outletId: outletIdSchema.parse(outletA1),
    query: catalogSyncQuerySchema.parse({
      stream: STREAM,
      protocolVersion: CATALOG_PROTOCOL_VERSION,
      limit,
      ...(since === undefined ? {} : { since }),
    }),
  })) as unknown as Page;
}

async function allCloudRecords(): Promise<Rec[]> {
  const records: Rec[] = [];
  let since: string | undefined;
  for (let count = 0; count < 1000; count += 1) {
    const next = await cloudPage(since);
    records.push(...next.records);
    if (!next.hasMore) return records;
    since = next.nextCursor!;
  }
  throw new Error("Printer stream did not finish paging");
}

const realFetchPage: FetchPage = (_stream, since) =>
  cloudPage(since ?? undefined);

async function pullWith(fetchPage: FetchPage): Promise<PullResult> {
  return (await pullCatalog({
    database: edge.database as typeof db,
    context: scope("device"),
    edgeNodeId: nodeId,
    streams: [STREAM] as never,
    fetchPage,
  })) as unknown as PullResult;
}

/** Waits for the cloud's commit-safe boundary, then pulls the real stream. */
async function pull(): Promise<PullResult> {
  await settleCloud(owner);
  const result = await pullWith(realFetchPage);
  expect(result.streams[STREAM]?.error).toBeUndefined();
  return result;
}

/** Forces the next pull to replay the whole stream (idempotency of apply). */
async function forgetCheckpoint() {
  await edge.owner.query(
    "DELETE FROM edge_pull_checkpoints WHERE edge_node_id = $1 AND stream = $2",
    [nodeId, CHECKPOINT],
  );
}

const edgePrinter = async (id: string) =>
  (await edge.rows("SELECT * FROM edge_printers WHERE id = $1::uuid", [id]))[0];

/** Edge job inserted as the superuser (the print agent's enqueue is not under test). */
async function edgeJob(
  printerId: string,
  tenantId = tenantA.tenantId,
  outletId = outletA1,
): Promise<string> {
  const id = randomUUID();
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO edge_print_jobs (id, tenant_id, outlet_id, printer_id, kind, content, idempotency_key)
       VALUES ($1, $2, $3, $4, 'receipt', '\\x1b40', $5)`,
      [id, tenantId, outletId, printerId, `retire-${randomUUID()}`],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return id;
}

/** A printer row that only exists on the edge, in a scope the edge does not own. */
async function foreignEdgePrinter(
  tenantId: string,
  outletId: string,
  withJob: boolean,
): Promise<{ id: string; jobId: string | null }> {
  const id = randomUUID();
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO edge_printers (id, tenant_id, outlet_id, label, role, transport, host, port, paper_width)
       VALUES ($1, $2, $3, 'Printer asing', 'receipt', 'network', '10.9.9.9', 9100, 48)`,
      [id, tenantId, outletId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const jobId = withJob ? await edgeJob(id, tenantId, outletId) : null;
  return { id, jobId };
}

const edgeStore = () =>
  createDbPrintStore({
    db: edge.database as typeof db,
    context: scope("session"),
    now: () => new Date(),
  });

const activeIds = async () =>
  (await edgeStore().listPrinters()).map((printer) => String(printer.id));

/** Cloud rows of a printer (devices + edge_printers share the id), as JSON. */
async function snapshotCloudPrinter(id: string) {
  return asOwnerTenant(tenantA.tenantId, async (client) => {
    const devices = await client.query(
      "SELECT row_to_json(t) AS row FROM devices t WHERE id = $1::uuid",
      [id],
    );
    const printers = await client.query(
      "SELECT row_to_json(t) AS row FROM edge_printers t WHERE id = $1::uuid",
      [id],
    );
    return {
      device: devices.rows[0]?.row as Rec | undefined,
      printer: printers.rows[0]?.row as Rec,
    };
  });
}

async function reinsertCloudPrinter(snapshot: {
  device: Rec | undefined;
  printer: Rec;
}) {
  await asOwnerTenant(tenantA.tenantId, async (client) => {
    if (snapshot.device) {
      const device = { ...snapshot.device };
      delete device.sync_txid;
      await client.query(
        "INSERT INTO devices SELECT * FROM json_populate_record(NULL::devices, $1::json) ON CONFLICT DO NOTHING",
        [JSON.stringify(device)],
      );
    }
    const printer = { ...snapshot.printer };
    delete printer.sync_txid;
    await client.query(
      "INSERT INTO edge_printers SELECT * FROM json_populate_record(NULL::edge_printers, $1::json)",
      [JSON.stringify(printer)],
    );
  });
}

async function resetEdge() {
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("DELETE FROM edge_print_jobs");
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
  tenantA = await createIsolatedTenant(`prr-a-${randomUUID().slice(0, 6)}`);
  headersA = { Host: tenantA.hostname };
  outletA1 = tenantA.outletId;
  managerA = await member(
    tenantA,
    await insertRole(tenantA.tenantId, ["device.registry.manage"]),
    "Manajer retire A",
  );

  const registered = await registerEdgeNode(scope("session"), randomUUID(), {
    outletId: outletA1,
    role: "standby",
    label: "Edge retire printer",
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
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenantA.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ------------------------------------------------------------- main flow

describe("legend-fbf4v printer retire: tombstone on the edge", () => {
  it("a deleted printer without print jobs is removed from the edge", async () => {
    const keep = await cloudCreate();
    const gone = await cloudCreate();
    await pull();
    expect(await edgePrinter(gone)).toBeDefined();

    await cloudDelete(gone);
    await pull();

    expect(await edgePrinter(gone)).toBeUndefined();
    expect(await edgePrinter(keep)).toBeDefined();
    expect(await activeIds()).toEqual([keep]);
  });

  it("a deleted printer with print jobs stays as a retired row and its job stays readable", async () => {
    const keep = await cloudCreate();
    const used = await cloudCreate(networkBody({ label: "Pernah mencetak" }));
    await pull();
    const jobId = await edgeJob(used);
    expect((await edgePrinter(used))?.retired_at).toBeNull();

    await cloudDelete(used);
    await pull();

    const row = await edgePrinter(used);
    expect(row).toBeDefined();
    expect(row?.retired_at).not.toBeNull();
    expect(row?.label).toBe("Pernah mencetak");
    // The live printer is untouched.
    expect((await edgePrinter(keep))?.retired_at).toBeNull();

    // Old job is still readable, still tied to the same printer id.
    const store = edgeStore();
    const job = await store.getJob(jobUlid(jobId));
    expect(job).not.toBeNull();
    expect(sameId(job?.printerId, used)).toBe(true);
    const listed = await store.listJobs({ limit: 200 });
    expect(listed.items.some((item) => sameId(item.id, jobId))).toBe(true);
  });

  it("a retired printer disappears from the active printer list, live ones stay", async () => {
    const keep = await cloudCreate();
    const used = await cloudCreate();
    await pull();
    await edgeJob(used);
    expect(await activeIds()).toEqual(expect.arrayContaining([keep, used]));

    await cloudDelete(used);
    await pull();

    const ids = await activeIds();
    expect(ids).toContain(keep);
    expect(ids).not.toContain(used);
  });

  it("replaying the tombstone keeps the printer retired and the job readable", async () => {
    const used = await cloudCreate();
    await pull();
    const jobId = await edgeJob(used);
    await cloudDelete(used);
    await pull();
    expect((await edgePrinter(used))?.retired_at).not.toBeNull();

    await forgetCheckpoint();
    await pull();

    expect((await edgePrinter(used))?.retired_at).not.toBeNull();
    const job = await edgeStore().getJob(jobUlid(jobId));
    expect(job).not.toBeNull();
    expect(sameId(job?.printerId, used)).toBe(true);
    expect(await activeIds()).not.toContain(used);
  });

  it("a tombstone for a printer the edge never had stays a no-op", async () => {
    const id = await cloudCreate();
    await cloudDelete(id);
    await pull();
    expect(await edgePrinter(id)).toBeUndefined();
  });
});

// -------------------------------------------- edge-owned state is preserved

describe("legend-fbf4v printer retire: retired_at belongs to the edge", () => {
  it("a status update from the print agent keeps retired_at and sync_txid", async () => {
    const used = await cloudCreate();
    await pull();
    await edgeJob(used);
    await cloudDelete(used);
    await pull();
    const before = await edgePrinter(used);
    expect(before?.retired_at).not.toBeNull();

    // Edge-local writes without skip_sync_txid, as the print agent does.
    await edge.owner.query(
      "UPDATE edge_printers SET status = 'online', last_seen_at = now(), updated_at = now() WHERE id = $1::uuid",
      [used],
    );
    await edge.owner.query(
      "UPDATE edge_printers SET status = 'offline', offline_since = now() WHERE id = $1::uuid",
      [used],
    );

    const after = await edgePrinter(used);
    expect(after?.status).toBe("offline");
    expect(after?.retired_at).not.toBeNull();
    expect(new Date(String(after?.retired_at)).getTime()).toBe(
      new Date(String(before?.retired_at)).getTime(),
    );
    expect(String(after?.sync_txid)).toBe(String(before?.sync_txid));
  });

  it("setting retired_at on the edge does not restamp sync_txid", async () => {
    const id = await cloudCreate();
    await pull();
    const before = String((await edgePrinter(id))?.sync_txid);
    await edge.owner.query(
      "UPDATE edge_printers SET retired_at = now() WHERE id = $1::uuid",
      [id],
    );
    const row = await edgePrinter(id);
    expect(row?.retired_at).not.toBeNull();
    expect(String(row?.sync_txid)).toBe(before);
  });

  it("the cloud record never carries retired_at", async () => {
    const id = await cloudCreate();
    await settleCloud(owner);
    const record = (await allCloudRecords()).find((r) => sameId(r.id, id));
    expect(record).toBeDefined();
    for (const key of ["retiredAt", "retired_at"])
      expect(record).not.toHaveProperty(key);
  });
});

// ------------------------------------------------------------- revival

describe("legend-fbf4v printer retire: the cloud brings a printer back", () => {
  it("a cloud update of a retired printer clears retired_at and applies the new fields", async () => {
    const id = await cloudCreate(networkBody({ label: "Sebelum hidup" }));
    await pull();
    await edgeJob(id);
    // Retired on the edge by the print flow's own rule (edge-owned column).
    await edge.owner.query(
      "UPDATE edge_printers SET retired_at = now() WHERE id = $1::uuid",
      [id],
    );
    expect(await activeIds()).not.toContain(id);

    await cloudPatch(id, { label: "Sesudah hidup" });
    await pull();

    expect(await edgePrinter(id)).toMatchObject({
      label: "Sesudah hidup",
      retired_at: null,
    });
    expect(await activeIds()).toContain(id);
  });

  it("a cloud printer re-created with the same id after retirement is active again", async () => {
    const id = await cloudCreate(networkBody({ label: "Kembali lagi" }));
    const snapshot = await snapshotCloudPrinter(id);
    try {
      await pull();
      const jobId = await edgeJob(id);

      await cloudDelete(id);
      await pull();
      expect((await edgePrinter(id))?.retired_at).not.toBeNull();
      expect(await activeIds()).not.toContain(id);

      await reinsertCloudPrinter(snapshot);
      await pull();

      expect(await edgePrinter(id)).toMatchObject({
        label: "Kembali lagi",
        retired_at: null,
      });
      expect(await activeIds()).toContain(id);
      // The old job still belongs to it.
      const job = await edgeStore().getJob(jobUlid(jobId));
      expect(job).not.toBeNull();
      expect(sameId(job?.printerId, id)).toBe(true);
    } finally {
      // Re-creating with the same id leaves a live cloud row AND the old
      // tombstone with that id. The shared cloud stream then returns both in one
      // page for every later test (resetEdge pulls from scratch), which fails
      // with "Catalog page repeats a record." The tombstone table is append-only
      // for legend_app, so clean it up through the owner connection.
      await asOwnerTenant(tenantA.tenantId, (client) =>
        client.query(
          "DELETE FROM edge_printer_tombstones WHERE id = $1::uuid",
          [id],
        ),
      );
    }
  });
});

// ------------------------------------------------------------- isolation

describe("legend-fbf4v printer retire: tenant and outlet isolation", () => {
  it("retiring or deleting an own printer leaves printers of other outlets and tenants untouched", async () => {
    const withJob = await cloudCreate();
    const withoutJob = await cloudCreate();
    await pull();
    await edgeJob(withJob);

    const siblingJob = await foreignEdgePrinter(
      tenantA.tenantId,
      siblingOutlet,
      true,
    );
    const siblingFree = await foreignEdgePrinter(
      tenantA.tenantId,
      siblingOutlet,
      false,
    );
    const foreignJob = await foreignEdgePrinter(
      foreignTenant,
      foreignTenantOutlet,
      true,
    );
    const foreignFree = await foreignEdgePrinter(
      foreignTenant,
      foreignTenantOutlet,
      false,
    );
    const others = [siblingJob, siblingFree, foreignJob, foreignFree];

    await cloudDelete(withJob);
    await cloudDelete(withoutJob);
    await pull();

    expect((await edgePrinter(withJob))?.retired_at).not.toBeNull();
    expect(await edgePrinter(withoutJob)).toBeUndefined();
    for (const other of others) {
      const row = await edgePrinter(other.id);
      expect(row).toBeDefined();
      expect(row?.retired_at).toBeNull();
      expect(row?.label).toBe("Printer asing");
    }
    const jobs = await edge.rows(
      "SELECT id FROM edge_print_jobs WHERE id = ANY($1::uuid[])",
      [[siblingJob.jobId, foreignJob.jobId]],
    );
    expect(jobs).toHaveLength(2);
  });

  it("a forged tombstone naming a printer of another outlet or tenant does not touch it", async () => {
    const own = await cloudCreate();
    await pull();
    await cloudDelete(own);
    await settleCloud(owner);
    const tombstone = (await allCloudRecords()).find((r) => sameId(r.id, own));
    expect(tombstone?.deletedAt).toEqual(expect.any(String));

    const siblingJob = await foreignEdgePrinter(
      tenantA.tenantId,
      siblingOutlet,
      true,
    );
    const siblingFree = await foreignEdgePrinter(
      tenantA.tenantId,
      siblingOutlet,
      false,
    );
    const foreignFree = await foreignEdgePrinter(
      foreignTenant,
      foreignTenantOutlet,
      false,
    );
    const forged: Rec[] = [siblingJob, siblingFree, foreignFree].map(
      (target) => ({ ...tombstone, id: target.id }),
    );

    // The edge may reject the page or ignore the records: both are fine. What
    // must hold is that no foreign row is deleted or retired. A rejected page
    // may come back as a stream error or as a thrown error.
    await pullWith(async () => ({
      protocolVersion: CATALOG_PROTOCOL_VERSION,
      stream: STREAM,
      records: forged,
      nextCursor: null,
      hasMore: false,
    })).catch(() => undefined);

    for (const target of [siblingJob, siblingFree, foreignFree]) {
      const row = await edgePrinter(target.id);
      expect(row).toBeDefined();
      expect(row?.retired_at).toBeNull();
    }
  });
});
