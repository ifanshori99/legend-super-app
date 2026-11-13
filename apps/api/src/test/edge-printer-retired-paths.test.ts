// legend-fbf4v follow-up 2: `retired_at` must be honored on every edge path,
// not only in the printer list. Written from the CTO brief (Kartu 2 lanjutan 2),
// NOT from the implementation. Fail-first: today a retired printer still
// accepts jobs, is a valid reroute target and can be a fallback.
//
// ASSUMED CONTRACT (extends edge-printer-retire.test.ts):
//  1. A RETIRED printer (edge_printers.retired_at NOT NULL) is treated like an
//     unknown printer by the print store and agent: `enqueue` and `reroute`
//     (as target) reject with the same code as for a random printer id
//     (`NOT_FOUND`, as in edge-print-db.test.ts). No job row is created and
//     nothing is printed.
//  2. `fallback_printer_id` never points at a retired printer. When the cloud
//     record of a printer names a retired printer as fallback, the printer is
//     still applied (page accepted, no stream error) with the fallback left
//     NULL (deferred). A live (or revived) fallback links as before.
//  3. Replaying the tombstone of an already retired printer is a no-op: the
//     row keeps the same `retired_at` and `sync_txid`, and the pull has no error.
//  4. Evidence stays readable: `getJob` / `listJobs` of an old job of a retired
//     printer keep working, with the same `printerId`.
//  Cloud records naming a retired fallback are forged: a record copied from the
//  cloud stream with `fallbackPrinterId` replaced (the cloud API itself refuses
//  a deleted printer as fallback).
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
import { createPrintAgent } from "../edge/print/agent.ts";
import { FakePrinterTransport } from "../edge/print/transport.ts";
import type { NewPrintJob } from "../edge/print/types.ts";
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

const edgeStore = () =>
  createDbPrintStore({
    db: edge.database as typeof db,
    context: scope("session"),
    now: () => new Date(),
  });

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
  tenantA = await createIsolatedTenant(`prp-a-${randomUUID().slice(0, 6)}`);
  headersA = { Host: tenantA.hostname };
  outletA1 = tenantA.outletId;
  managerA = await member(
    tenantA,
    await insertRole(tenantA.tenantId, ["device.registry.manage"]),
    "Manajer retire paths A",
  );

  const registered = await registerEdgeNode(scope("session"), randomUUID(), {
    outletId: outletA1,
    role: "standby",
    label: "Edge retire paths",
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

// ------------------------------------------------------------- test helpers

function edgeAgent() {
  const transport = new FakePrinterTransport();
  const printAgent = createPrintAgent({
    store: edgeStore(),
    transportFor: () => transport,
    notify: () => undefined,
  });
  return { printAgent, transport };
}

const newJob = (printerId: string, key: string): NewPrintJob => ({
  printerId,
  kind: "receipt",
  content: new Uint8Array([0x1b, 0x40, ...Buffer.from(key)]),
  idempotencyKey: `${key}-${randomUUID()}`,
});

const jobsOf = async (printerId: string) =>
  edge.rows("SELECT id FROM edge_print_jobs WHERE printer_id = $1::uuid", [
    printerId,
  ]);

/** A printer that was used (has one job) and is then deleted in the cloud. */
async function retiredPrinter(): Promise<{ id: string; jobId: string }> {
  const id = await cloudCreate(networkBody({ label: "Dihapus cloud" }));
  await pull();
  const jobId = await edgeJob(id);
  await cloudDelete(id);
  await pull();
  expect((await edgePrinter(id))?.retired_at).not.toBeNull();
  return { id, jobId };
}

/** Applies a cloud record of `id` whose fallback is replaced, as a forged page. */
async function pullForgedFallback(id: string, fallbackId: string | null) {
  await settleCloud(owner);
  const record = (await allCloudRecords()).find((r) => sameId(r.id, id));
  expect(record).toBeDefined();
  return pullWith(async () => ({
    protocolVersion: CATALOG_PROTOCOL_VERSION,
    stream: STREAM,
    records: [{ ...record, fallbackPrinterId: fallbackId }],
    nextCursor: null,
    hasMore: false,
  }));
}

async function expectJobReadable(jobId: string, printerId: string) {
  const store = edgeStore();
  const found = await store.getJob(jobUlid(jobId));
  expect(found).not.toBeNull();
  expect(sameId(found?.printerId, printerId)).toBe(true);
  const listed = await store.listJobs({ limit: 200 });
  expect(listed.items.some((item) => sameId(item.id, jobId))).toBe(true);
}

// ------------------------------------------------------------------ enqueue

describe("legend-fbf4v retired printer: enqueue is refused", () => {
  it("the store refuses a job for a retired printer like for an unknown one", async () => {
    const retired = await retiredPrinter();
    const store = edgeStore();

    const unknown = await store
      .enqueue(newJob(randomUUID(), "ghost"))
      .catch((error: unknown) => error);
    expect(unknown).toMatchObject({ code: "NOT_FOUND" });

    const refused = await store
      .enqueue(newJob(retired.id, "late"))
      .then(() => null)
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: (unknown as { code: string }).code,
    });
    // No new job; the old one is the only one left.
    expect(await jobsOf(retired.id)).toHaveLength(1);
  });

  it("the print agent refuses a job for a retired printer and prints nothing", async () => {
    const retired = await retiredPrinter();
    const { printAgent, transport } = edgeAgent();

    const unknown = await printAgent
      .enqueue(newJob(randomUUID(), "ghost"))
      .catch((error: unknown) => error);
    expect(unknown).toMatchObject({ code: "NOT_FOUND" });

    const refused = await printAgent
      .enqueue(newJob(retired.id, "late"))
      .then(() => null)
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: (unknown as { code: string }).code,
    });

    await printAgent.tick();
    expect(transport.printed).toHaveLength(0);
    expect(await jobsOf(retired.id)).toHaveLength(1);
  });

  it("a live printer still accepts jobs, and a retired one that the cloud revives does too", async () => {
    const live = await cloudCreate();
    await pull();
    const store = edgeStore();
    const accepted = await store.enqueue(newJob(live, "ok"));
    expect(sameId(accepted.job.printerId, live)).toBe(true);

    // Revival: edge-owned retired_at is cleared by a live cloud record.
    const used = await cloudCreate(networkBody({ label: "Sebelum" }));
    await pull();
    await edgeJob(used);
    await edge.owner.query(
      "UPDATE edge_printers SET retired_at = now() WHERE id = $1::uuid",
      [used],
    );
    await expect(store.enqueue(newJob(used, "x"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const response = await managerA.client
      .patch(`/api/printers/${encodeURIComponent(used)}`)
      .set(headersA)
      .set(originHeader)
      .send({ label: "Sesudah" });
    expect(response.status).toBe(200);
    await pull();
    const revived = await store.enqueue(newJob(used, "again"));
    expect(sameId(revived.job.printerId, used)).toBe(true);
  });

  it("old jobs of a retired printer stay readable after refused enqueues", async () => {
    const retired = await retiredPrinter();
    await edgeStore()
      .enqueue(newJob(retired.id, "late"))
      .catch(() => undefined);
    await expectJobReadable(retired.jobId, retired.id);
  });
});

// ------------------------------------------------------------------ reroute

describe("legend-fbf4v retired printer: reroute is refused", () => {
  it("rerouting queued jobs to a retired printer is refused and the jobs stay put", async () => {
    const retired = await retiredPrinter();
    const main = await cloudCreate(networkBody({ label: "Utama reroute" }));
    await pull();
    const store = edgeStore();
    const queued = (await store.enqueue(newJob(main, "q1"))).job;

    const unknown = await store
      .reroute(main, randomUUID())
      .catch((error: unknown) => error);
    expect(unknown).toMatchObject({ code: "NOT_FOUND" });

    const refused = await store
      .reroute(main, retired.id)
      .then(() => null)
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: (unknown as { code: string }).code,
    });

    const after = await store.getJob(queued.id);
    expect(sameId(after?.printerId, main)).toBe(true);
    expect(await jobsOf(retired.id)).toHaveLength(1);
  });

  it("rerouting to a live printer still works", async () => {
    const main = await cloudCreate(networkBody({ label: "Utama ok" }));
    const backup = await cloudCreate(networkBody({ label: "Cadangan ok" }));
    await pull();
    const store = edgeStore();
    const queued = (await store.enqueue(newJob(main, "q"))).job;
    expect(await store.reroute(main, backup)).toBe(1);
    const after = await store.getJob(queued.id);
    expect(sameId(after?.printerId, backup)).toBe(true);
  });
});

// ----------------------------------------------------------------- fallback

describe("legend-fbf4v retired printer: never a fallback", () => {
  it("a cloud printer that names a retired printer as fallback is applied with no fallback", async () => {
    const retired = await retiredPrinter();
    const id = await cloudCreate(networkBody({ label: "Pakai cadangan mati" }));

    const result = await pullForgedFallback(id, retired.id);

    expect(result.streams[STREAM]?.error).toBeUndefined();
    const row = await edgePrinter(id);
    expect(row).toBeDefined();
    expect(row?.fallback_printer_id).toBeNull();
    // Still nothing after another look at the same record (repair pass).
    await pullForgedFallback(id, retired.id);
    expect((await edgePrinter(id))?.fallback_printer_id).toBeNull();
    // The retired printer and its job are untouched.
    expect((await edgePrinter(retired.id))?.retired_at).not.toBeNull();
    await expectJobReadable(retired.jobId, retired.id);
  });

  it("a live fallback is still linked", async () => {
    const fallback = await cloudCreate(
      networkBody({ label: "Cadangan hidup" }),
    );
    await pull();
    const id = await cloudCreate(networkBody({ label: "Utama hidup" }));

    const result = await pullForgedFallback(id, fallback);

    expect(result.streams[STREAM]?.error).toBeUndefined();
    expect((await edgePrinter(id))?.fallback_printer_id).toBe(fallback);
  });

  it("a fallback revived by the cloud can be linked again", async () => {
    const fallback = await cloudCreate(
      networkBody({ label: "Cadangan hidup lagi" }),
    );
    const snapshot = await snapshotCloudPrinter(fallback);
    try {
      await pull();
      await edgeJob(fallback);
      await cloudDelete(fallback);
      await pull();
      expect((await edgePrinter(fallback))?.retired_at).not.toBeNull();

      // No forgetCheckpoint here: the re-inserted live row gets a fresh
      // sync_txid, so the normal incremental pull sees it. A full replay would
      // return the live row AND the old tombstone with the same id in one page
      // ("Catalog page repeats a record").
      await reinsertCloudPrinter(snapshot);
      await pull();
      expect((await edgePrinter(fallback))?.retired_at).toBeNull();

      const id = await cloudCreate(
        networkBody({ label: "Utama setelah revive" }),
      );
      await pullForgedFallback(id, fallback);
      expect((await edgePrinter(id))?.fallback_printer_id).toBe(fallback);
    } finally {
      // See edge-printer-retire.test.ts: the append-only tombstone with the
      // re-used id would break later full-stream pulls.
      await asOwnerTenant(tenantA.tenantId, (client) =>
        client.query(
          "DELETE FROM edge_printer_tombstones WHERE id = $1::uuid",
          [fallback],
        ),
      );
    }
  });
});

// ------------------------------------------------------- tombstone replay

describe("legend-fbf4v retired printer: replaying its tombstone is a no-op", () => {
  // sync_txid is deliberately not asserted here: after forgetCheckpoint() the
  // puller resets the edge rows' sync_txid to 0 (resetCatalogSyncTxid) so the
  // cloud wins, which is legitimate behavior. The forged-page test below keeps
  // the sync_txid assertion because it does not go through that reset.
  it("retired_at, updated_at and the job stay as they were after a full replay", async () => {
    const retired = await retiredPrinter();
    const before = await edgePrinter(retired.id);

    await forgetCheckpoint();
    const first = await pull();
    await forgetCheckpoint();
    const second = await pull();

    expect(first.streams[STREAM]?.error).toBeUndefined();
    expect(second.streams[STREAM]?.error).toBeUndefined();
    const after = await edgePrinter(retired.id);
    expect(after).toBeDefined();
    expect(new Date(String(after?.retired_at)).getTime()).toBe(
      new Date(String(before?.retired_at)).getTime(),
    );
    expect(String(after?.updated_at)).toBe(String(before?.updated_at));
    await expectJobReadable(retired.jobId, retired.id);
  });

  it("a forged page repeating the tombstone does not rewrite the row either", async () => {
    const retired = await retiredPrinter();
    const before = await edgePrinter(retired.id);
    await settleCloud(owner);
    const tombstone = (await allCloudRecords()).find((r) =>
      sameId(r.id, retired.id),
    );
    expect(tombstone?.deletedAt).toEqual(expect.any(String));

    const result = await pullWith(async () => ({
      protocolVersion: CATALOG_PROTOCOL_VERSION,
      stream: STREAM,
      records: [tombstone as Rec],
      nextCursor: null,
      hasMore: false,
    }));

    expect(result.streams[STREAM]?.error).toBeUndefined();
    const after = await edgePrinter(retired.id);
    expect(new Date(String(after?.retired_at)).getTime()).toBe(
      new Date(String(before?.retired_at)).getTime(),
    );
    expect(String(after?.sync_txid)).toBe(String(before?.sync_txid));
  });
});
