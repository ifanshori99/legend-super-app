// Card F1 (brief 1269): edge -> cloud command core. One disposable database
// plays both sides (the two tables are separate); the cloud side is the real
// router on a real HTTP server, the edge side the real store and client.
//
// The kind handler counts its effect in a database row (the node's
// cloud_to_edge cursor), so a rolled back execution is visible as no effect.
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import {
  EDGE_COMMAND_INSTANCE_HEADER,
  EDGE_COMMAND_PATH,
  EDGE_COMMAND_TEST_KIND,
  edgeTestEchoPayloadSchema,
} from "@starter/shared/edge";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { createEdgeCommandClient } from "../edge/cloud-command-client.ts";
import {
  freezeEdgeCommand,
  openEdgeCommandFor,
  readEdgeCommand,
  type EdgeCommandNode,
} from "../edge/cloud-command-store.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import { createEdgeCloudCommandRouter } from "../routes/edge-cloud-command.routes.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  EDGE_COMMAND_HANDLERS,
  EdgeCommandRefusal,
  type EdgeCommandHandler,
} from "../services/edge-cloud-command.service.ts";
import {
  edgeNodeContext,
  registerEdgeNode,
  revokeEdgeNode,
  verifyEdgeNodeCredential,
} from "../services/edge-node.service.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";
import {
  createIsolatedTenant,
  owner,
  waitForLockWaiters,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

type Node = EdgeCommandNode & { credential: string; instanceId: string };

const actor = randomUUID();
let tenant: IsolatedTenant;
let outletB: string;
let node: Node;
let nodeB: Node;
let server: Server;
let base: string;

/** What the handler does on the next executions (after its effect). */
let behavior: "ok" | "crash" | "refuse" = "ok";
let gate: Promise<void> | null = null;
let entered = 0;

const countingHandler: EdgeCommandHandler = {
  payload: edgeTestEchoPayloadSchema,
  async execute(tx, input) {
    entered += 1;
    const { note } = edgeTestEchoPayloadSchema.parse(input.payload);
    await tx.execute(
      sql`INSERT INTO sync_cursors (tenant_id, outlet_id, edge_node_id, direction, next_out_seq)
        VALUES (${input.node.tenantId}::uuid, ${input.node.outletId}::uuid, ${input.node.edgeNodeId}::uuid, 'cloud_to_edge', 1)
        ON CONFLICT (tenant_id, edge_node_id, direction) DO UPDATE SET next_out_seq = sync_cursors.next_out_seq + 1`,
    );
    if (gate) await gate;
    if (behavior === "crash") throw new Error("crash after the effect");
    if (behavior === "refuse") throw new EdgeCommandRefusal("TEST_REFUSED");
    return { note };
  },
};

async function effects(of: Node = node): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT next_out_seq AS n FROM sync_cursors WHERE edge_node_id = $1 AND direction = 'cloud_to_edge'",
    [of.edgeNodeId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function execution(id: string) {
  const { rows } = await owner.query(
    "SELECT status, code, edge_node_id FROM edge_command_executions WHERE id = $1",
    [ulidToUuid(id)],
  );
  return rows[0] as
    { status: string; code: string | null; edge_node_id: string } | undefined;
}

async function bindInstance(of: Node, instanceId: string) {
  await owner.query(
    `INSERT INTO sync_cursors (tenant_id, outlet_id, edge_node_id, direction, peer_instance_id)
     VALUES ($1, $2, $3, 'edge_to_cloud', $4)`,
    [of.tenantId, of.outletId, of.edgeNodeId, instanceId],
  );
}

async function createNode(
  outletId: string,
  role: "primary" | "standby" = "primary",
): Promise<Node> {
  const context = edgeNodeContext({ tenantId: tenant.tenantId, outletId });
  const { edgeNode, credential } = await registerEdgeNode(context, actor, {
    outletId,
    role,
    label: `f1-${role}`,
  });
  const created: Node = {
    tenantId: tenant.tenantId,
    outletId,
    edgeNodeId: edgeNode.id,
    credential,
    instanceId: randomUUID(),
  };
  await bindInstance(created, created.instanceId);
  return created;
}

async function secondOutlet(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'F1 B', address, timezone, opening_hours, 'active'
       FROM outlets WHERE id = $3`,
    [id, `F1-${id.slice(0, 8)}`, tenant.outletId],
  );
  return id;
}

/** A frozen command of `of` on a fresh bill. */
async function frozen(
  of: Node = node,
  input: { note?: string; subjectId?: string; now?: Date; ttlMs?: number } = {},
) {
  const context = edgeNodeContext(of);
  return withTenant(db, context, (tx) =>
    freezeEdgeCommand(tx, of, {
      kind: EDGE_COMMAND_TEST_KIND,
      payload: { note: input.note ?? "halo" },
      subject: { type: "order", id: input.subjectId ?? createUlid() },
      ttlMs: input.ttlMs ?? 120_000,
      ...(input.now ? { now: input.now } : {}),
    }),
  );
}

const read = (id: string, of: Node = node) =>
  withTenant(db, edgeNodeContext(of), (tx) => readEdgeCommand(tx, of, id));

function client(
  of: Node = node,
  fetchImpl: typeof fetch = fetch,
  role: "primary" | "standby" = "primary",
) {
  return createEdgeCommandClient({
    database: db,
    node: of,
    role,
    edgeInstanceId: of.instanceId,
    cloudUrl: base.replace("http:", "ws:") + "/api/edge-link",
    credential: of.credential,
    fetchImpl,
    timeoutMs: 5_000,
  });
}

function post(
  body: string,
  of: Node = node,
  overrides: { instance?: string | null; path?: string } = {},
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${of.credential}`,
    "Content-Type": "application/json",
  };
  const instance =
    overrides.instance === undefined ? of.instanceId : overrides.instance;
  if (instance !== null) headers[EDGE_COMMAND_INSTANCE_HEADER] = instance;
  return fetch(`${base}${overrides.path ?? EDGE_COMMAND_PATH}`, {
    method: "POST",
    headers,
    body,
  });
}

const sha = (body: string) => createHash("sha256").update(body).digest("hex");
const dead: typeof fetch = async () => {
  throw new TypeError("fetch failed");
};
/** The cloud receives and executes, the answer never reaches the edge. */
const lostAnswer: typeof fetch = async (...args) => {
  await fetch(...args);
  throw new TypeError("socket hang up");
};

beforeAll(async () => {
  setAuditWriter(coreAuditWriter);
  setEdgeCredentialVerifier(verifyEdgeNodeCredential);
  tenant = await createIsolatedTenant(`f1-${randomUUID().slice(0, 8)}`);
  outletB = await secondOutlet();
  node = await createNode(tenant.outletId);
  nodeB = await createNode(outletB);
  const app = express();
  app.use(
    EDGE_COMMAND_PATH,
    createEdgeCloudCommandRouter({
      database: db,
      handlers: { [EDGE_COMMAND_TEST_KIND]: countingHandler },
    }),
  );
  app.use(errorHandler);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  behavior = "ok";
  gate = null;
  entered = 0;
});

afterAll(async () => {
  setEdgeCredentialVerifier(null);
  await new Promise((resolve) => server.close(resolve));
  await owner.end();
});

describe("[F1] one execution per command key", () => {
  it("[F1] the happy path settles the edge command", async () => {
    const before = await effects();
    const command = await frozen();
    expect(command.status).toBe("pending");
    const settled = await client().send(command.id);
    expect(settled).toMatchObject({
      status: "succeeded",
      result: { note: "halo" },
      attempts: 1,
    });
    expect(await effects()).toBe(before + 1);
  });

  it("[F1] the same bytes replayed answer the same outcome, executed once", async () => {
    const before = await effects();
    const command = await frozen();
    const first = await post(command.body);
    const second = await post(command.body);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await second.json()).toEqual(await first.json());
    expect(await effects()).toBe(before + 1);
  });

  it("[F1] other bytes under the same key are refused, even equal JSON", async () => {
    const before = await effects();
    const command = await frozen();
    await post(command.body);
    const changed = await post(command.body.replace("halo", "lain"));
    const respaced = await post(
      JSON.stringify(JSON.parse(command.body), null, 1),
    );
    for (const response of [changed, respaced]) {
      expect(response.status).toBe(409);
      expect(
        ((await response.json()) as { error: { code: string } }).error.code,
      ).toBe("EDGE_COMMAND_KEY_REUSED");
    }
    expect(await effects()).toBe(before + 1);
    expect(await execution(command.id)).toMatchObject({ status: "succeeded" });
  });

  it("[F1] two concurrent sends execute once", async () => {
    const before = await effects();
    const command = await frozen();
    let open!: () => void;
    gate = new Promise((resolve) => (open = resolve));
    const first = post(command.body);
    const second = post(command.body);
    await waitForLockWaiters(1);
    open();
    const bodies = await Promise.all(
      [first, second].map(async (r) => (await r).json()),
    );
    expect(bodies[0]).toEqual(bodies[1]);
    expect(entered).toBe(1);
    expect(await effects()).toBe(before + 1);
  });

  it("[F1] a crash in the middle keeps nothing; the resend executes once", async () => {
    const before = await effects();
    const command = await frozen();
    behavior = "crash";
    const unknown = await client().send(command.id);
    expect(unknown.status).toBe("unknown");
    expect(await effects()).toBe(before);
    expect(await execution(command.id)).toBeUndefined();
    behavior = "ok";
    const settled = await client().send(command.id);
    expect(settled).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(await effects()).toBe(before + 1);
  });

  it("[F1] a refusal keeps no effect and is final", async () => {
    const before = await effects();
    const command = await frozen();
    behavior = "refuse";
    const settled = await client().send(command.id);
    expect(settled).toMatchObject({ status: "refused", code: "TEST_REFUSED" });
    behavior = "ok";
    const replay = await post(command.body);
    expect(await replay.json()).toMatchObject({ data: { status: "refused" } });
    expect(await effects()).toBe(before);
  });
});

describe("[F1] who may send", () => {
  it("[F1] no or a wrong credential is 401", async () => {
    const command = await frozen();
    const bad = { ...node, credential: `${node.credential.slice(0, -2)}xx` };
    expect((await post(command.body, bad)).status).toBe(401);
    const bare = await fetch(`${base}${EDGE_COMMAND_PATH}`, {
      method: "POST",
      body: command.body,
    });
    expect(bare.status).toBe(401);
    expect(await execution(command.id)).toBeUndefined();
  });

  it("[F1] the key of another outlet is 403 for post and status, and stays theirs", async () => {
    const before = await effects(nodeB);
    const command = await frozen();
    await post(command.body);
    const foreign = await post(command.body, nodeB);
    expect(foreign.status).toBe(403);
    const status = await post(
      JSON.stringify({ kind: command.kind, bodySha256: sha(command.body) }),
      nodeB,
      { path: `${EDGE_COMMAND_PATH}/${command.id}/status` },
    );
    expect(status.status).toBe(403);
    expect(await execution(command.id)).toMatchObject({
      status: "succeeded",
      edge_node_id: node.edgeNodeId,
    });
    expect(await effects(nodeB)).toBe(before);
  });

  it("[F1] a body that names an outlet, node or device is refused", async () => {
    const before = await effects();
    const command = await frozen();
    for (const extra of ["outletId", "tenantId", "edgeNodeId", "deviceId"]) {
      const body = JSON.stringify({
        ...(JSON.parse(command.body) as object),
        [extra]: outletB,
      });
      expect((await post(body)).status).toBe(400);
    }
    expect(await effects()).toBe(before);
    expect(await execution(command.id)).toBeUndefined();
  });

  it("[F1] another edge database, or none, is 403", async () => {
    const command = await frozen();
    expect(
      (await post(command.body, node, { instance: randomUUID() })).status,
    ).toBe(403);
    expect((await post(command.body, node, { instance: null })).status).toBe(
      403,
    );
    expect(await execution(command.id)).toBeUndefined();
  });

  it("[F1] a standby node is 403 and its client never sends", async () => {
    const standby = await createNode(outletB, "standby");
    const command = await frozen(standby);
    expect((await post(command.body, standby)).status).toBe(403);
    let calls = 0;
    const counting: typeof fetch = (...args) => {
      calls += 1;
      return fetch(...args);
    };
    await expect(
      client(standby, counting, "standby").send(command.id),
    ).rejects.toThrow();
    expect(calls).toBe(0);
    expect((await read(command.id, standby))?.status).toBe("pending");
  });

  it("[F1] a revoked node is refused", async () => {
    const outlet = await secondOutlet();
    const revoked = await createNode(outlet);
    const command = await frozen(revoked);
    await revokeEdgeNode(edgeNodeContext(revoked), actor, {
      edgeNodeId: revoked.edgeNodeId,
      reason: "uji F1",
    });
    expect((await post(command.body, revoked)).status).toBe(401);
    expect(await execution(command.id)).toBeUndefined();
  });

  it("[F1] an unknown kind is refused and leaves the key unused", async () => {
    const command = await frozen();
    const body = command.body.replace(EDGE_COMMAND_TEST_KIND, "test.other");
    expect((await post(body)).status).toBe(400);
    expect(await execution(command.id)).toBeUndefined();
  });

  it("[F1] production serves only the test kind", () => {
    expect(Object.keys(EDGE_COMMAND_HANDLERS)).toEqual([
      EDGE_COMMAND_TEST_KIND,
    ]);
  });
});

describe("[F1] unknown answers", () => {
  it("[F1] cloud down: unknown and locked, then recovered as never executed", async () => {
    const before = await effects();
    const command = await frozen();
    const sent = await client(node, dead).send(command.id);
    expect(sent.status).toBe("unknown");
    const open = await withTenant(db, edgeNodeContext(node), (tx) =>
      openEdgeCommandFor(tx, node, {
        type: command.subjectType,
        id: command.subjectId,
      }),
    );
    expect(open?.id).toBe(command.id);
    const still = await client(node, dead).resolve(command.id);
    expect(still.status).toBe("unknown");

    const settled = await client().resolve(command.id);
    expect(settled.status).toBe("absent");
    // The late POST of the same bytes meets the tombstone.
    const late = await post(command.body);
    expect(await late.json()).toMatchObject({ data: { status: "absent" } });
    expect(await effects()).toBe(before);
  });

  it("[F1] a lost answer is found again by status, executed once", async () => {
    const before = await effects();
    const command = await frozen();
    expect((await client(node, lostAnswer).send(command.id)).status).toBe(
      "unknown",
    );
    // A restarted edge process asks for everything still open.
    const result = await client().resolveOpen();
    expect(result).toEqual({ settled: expect.any(Number), open: 0 });
    expect(await read(command.id)).toMatchObject({
      status: "succeeded",
      result: { note: "halo" },
    });
    expect(await effects()).toBe(before + 1);
  });

  it("[F1] the resend carries the frozen bytes and the same key", async () => {
    const command = await frozen();
    const seen: string[] = [];
    const recording: typeof fetch = async (_url, init) => {
      seen.push(Buffer.from(init?.body as Uint8Array).toString("utf8"));
      throw new TypeError("fetch failed");
    };
    await client(node, recording).send(command.id);
    await client(node, recording).send(command.id);
    expect(seen).toEqual([command.body, command.body]);
    expect((await read(command.id))?.status).toBe("unknown");
  });

  it("[F1] a status question racing the post gives one answer to both", async () => {
    const before = await effects();
    const command = await frozen();
    let open!: () => void;
    gate = new Promise((resolve) => (open = resolve));
    const posted = post(command.body);
    while (entered === 0)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const asked = client().resolve(command.id);
    await waitForLockWaiters(1);
    open();
    expect(await (await posted).json()).toMatchObject({
      data: { status: "succeeded" },
    });
    expect((await asked).status).toBe("succeeded");
    expect(await effects()).toBe(before + 1);
  });

  it("[F1] an error answer or a foreign outcome never settles the command", async () => {
    const command = await frozen();
    for (const status of [400, 401, 403, 404, 409, 500, 503]) {
      const refusing: typeof fetch = async () =>
        new Response(JSON.stringify({ error: { code: "X", message: "x" } }), {
          status,
        });
      expect((await client(node, refusing).send(command.id)).status).toBe(
        "unknown",
      );
    }
    const other = await frozen();
    const wrong: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            id: other.id,
            kind: other.kind,
            bodySha256: other.bodySha256,
            status: "succeeded",
            result: { note: "bukan milik saya" },
            decidedAt: new Date().toISOString(),
          },
        }),
        { status: 200 },
      );
    expect((await client(node, wrong).send(command.id)).status).toBe("unknown");
  });

  it("[F1] a status question about other bytes of a used key is refused", async () => {
    const command = await frozen();
    await post(command.body);
    const response = await post(
      JSON.stringify({ kind: command.kind, bodySha256: "0".repeat(64) }),
      node,
      { path: `${EDGE_COMMAND_PATH}/${command.id}/status` },
    );
    expect(response.status).toBe(409);
  });
});

describe("[F1] expiry", () => {
  it("[F1] a post after expiry never executes and is final", async () => {
    const before = await effects();
    const command = await frozen(node, {
      now: new Date(Date.now() - 600_000),
      ttlMs: 60_000,
    });
    expect((await client().send(command.id)).status).toBe("expired");
    expect(await effects()).toBe(before);
    expect(await execution(command.id)).toMatchObject({ status: "expired" });
  });

  it("[F1] an executed command still answers its outcome after expiry", async () => {
    const before = await effects();
    const command = await frozen(node, {
      now: new Date(Date.now() - 10_000),
      ttlMs: 12_000,
    });
    await post(command.body);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const replay = await post(command.body);
    expect(await replay.json()).toMatchObject({
      data: { status: "succeeded" },
    });
    expect(await effects()).toBe(before + 1);
  });

  it("[F1] an expiry far in the future (wrong edge clock) is refused", async () => {
    const before = await effects();
    const command = await frozen(node, {
      now: new Date(Date.now() + 3_600_000),
    });
    expect(await client().send(command.id)).toMatchObject({
      status: "refused",
      code: "EXPIRY_OUT_OF_RANGE",
    });
    expect(await effects()).toBe(before);
  });
});

describe("[F1] the edge lock and the stored record", () => {
  it("[F1] one open command per bill; a settled one frees it", async () => {
    const subjectId = createUlid();
    const command = await frozen(node, { subjectId });
    await expect(frozen(node, { subjectId })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await client(node, dead).send(command.id);
    await expect(frozen(node, { subjectId })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await client().resolve(command.id);
    expect((await frozen(node, { subjectId })).id).not.toBe(command.id);
  });

  it("[F1] a settled command is never sent again", async () => {
    const command = await frozen();
    await client().send(command.id);
    let calls = 0;
    const counting: typeof fetch = (...args) => {
      calls += 1;
      return fetch(...args);
    };
    expect((await client(node, counting).send(command.id)).status).toBe(
      "succeeded",
    );
    expect((await client(node, counting).resolve(command.id)).status).toBe(
      "succeeded",
    );
    expect(calls).toBe(0);
  });

  it("[F1] the database refuses edits and deletes of keys, bodies and outcomes", async () => {
    const command = await frozen();
    await client().send(command.id);
    const id = ulidToUuid(command.id);
    for (const statement of [
      "UPDATE edge_command_requests SET status = 'unknown' WHERE id = $1",
      "UPDATE edge_command_requests SET attempts = attempts + 1 WHERE id = $1",
      "DELETE FROM edge_command_requests WHERE id = $1",
      "UPDATE edge_command_executions SET status = 'absent' WHERE id = $1",
      "DELETE FROM edge_command_executions WHERE id = $1",
    ])
      await expect(owner.query(statement, [id])).rejects.toMatchObject({
        code: "42501",
      });
  });

  it("[F1] another outlet or tenant reads nothing", async () => {
    const command = await frozen();
    expect(await read(command.id, nodeB)).toBeNull();
    const elsewhere = await createIsolatedTenant(
      `f1x-${randomUUID().slice(0, 8)}`,
    );
    const { rows } = await withTenant(
      db,
      edgeNodeContext({
        tenantId: elsewhere.tenantId,
        outletId: elsewhere.outletId,
      }),
      (tx) =>
        tx.execute(
          sql`SELECT (SELECT count(*) FROM edge_command_requests) + (SELECT count(*) FROM edge_command_executions) AS n`,
        ),
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});
