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
import request from "supertest";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import {
  EDGE_COMMAND_CLOCK_HEADER,
  EDGE_COMMAND_INSTANCE_HEADER,
  EDGE_COMMAND_MAX_RESULT_BYTES,
  EDGE_COMMAND_PATH,
  EDGE_COMMAND_TEST_KIND,
  edgeTestEchoPayloadSchema,
} from "@starter/shared/edge";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  createEdgeCommandClient,
  EDGE_COMMAND_SETTLED_HOOKS,
  type EdgeCommandClientOptions,
} from "../edge/cloud-command-client.ts";
import {
  freezeEdgeCommand,
  openEdgeCommandFor,
  purgeSettledEdgeCommands,
  readEdgeCommand,
  type EdgeCommandNode,
  type EdgeCommandRequest,
} from "../edge/cloud-command-store.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import { createEdgeCloudCommandRouter } from "../routes/edge-cloud-command.routes.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  EDGE_COMMAND_HANDLERS,
  EdgeCommandRefusal,
  purgeEdgeCommandResults,
  type EdgeCommandHandler,
} from "../services/edge-cloud-command.service.ts";
import {
  edgeNodeContext,
  registerEdgeNode,
  revokeEdgeNode,
  verifyEdgeNodeCredential,
} from "../services/edge-node.service.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
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
let behavior: "ok" | "crash" | "refuse" | "slow" | "huge" = "ok";
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
    if (behavior === "slow") await tx.execute(sql`SELECT pg_sleep(12)`);
    if (behavior === "huge")
      return { note: "x".repeat(EDGE_COMMAND_MAX_RESULT_BYTES) };
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
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    outletId: outletIdSchema.parse(outletId),
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
    [id, `F1-${id.slice(0, 8)}`.toUpperCase(), tenant.outletId],
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
  extra: Partial<EdgeCommandClientOptions> = {},
) {
  return createEdgeCommandClient({
    database: db,
    node: of,
    role,
    edgeInstanceId: of.instanceId,
    cloudUrl: base.replace("http:", "ws:") + "/api/edge-link",
    credential: of.credential,
    onSettled: EDGE_COMMAND_SETTLED_HOOKS,
    fetchImpl,
    timeoutMs: 15_000,
    ...extra,
  });
}

function post(
  body: string,
  of: Node = node,
  overrides: { instance?: string | null; path?: string; clock?: Date } = {},
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${of.credential}`,
    "Content-Type": "application/json",
  };
  const instance =
    overrides.instance === undefined ? of.instanceId : overrides.instance;
  if (instance !== null) headers[EDGE_COMMAND_INSTANCE_HEADER] = instance;
  if (overrides.clock)
    headers[EDGE_COMMAND_CLOCK_HEADER] = overrides.clock.toISOString();
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
  if (server) await new Promise((resolve) => server.close(resolve));
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
    const result = await client(node, fetch, "primary", {
      resolveMinAgeMs: 0,
    }).resolveOpen();
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

describe("[F1 review 1] settling applies the outcome in the same transaction", () => {
  /** The edge-side effect: a counter on the node's own outbound cursor. */
  const bump = (tx: EdgeTx, row: EdgeCommandRequest) =>
    tx.execute(
      sql`UPDATE sync_cursors SET next_out_seq = next_out_seq + 1 WHERE edge_node_id = ${row.edgeNodeId}::uuid AND direction = 'edge_to_cloud'`,
    );
  async function applied(of: Node = node) {
    const { rows } = await owner.query<{ n: string }>(
      "SELECT next_out_seq AS n FROM sync_cursors WHERE edge_node_id = $1 AND direction = 'edge_to_cloud'",
      [of.edgeNodeId],
    );
    return Number(rows[0]?.n);
  }
  const withHook = (
    hook: (tx: EdgeTx, row: EdgeCommandRequest) => Promise<unknown>,
  ) =>
    client(node, fetch, "primary", {
      onSettled: {
        [EDGE_COMMAND_TEST_KIND]: async (tx, row) => {
          await hook(tx, row);
        },
      },
    });

  it("[F1 review 1] a crash while applying keeps the command unknown and locked, then applies once", async () => {
    const beforeEffects = await effects();
    const before = await applied();
    const command = await frozen();
    const errors: unknown[] = [];
    const crashed = await client(node, fetch, "primary", {
      onError: (error) => errors.push(error),
      onSettled: {
        [EDGE_COMMAND_TEST_KIND]: async (tx, row) => {
          await bump(tx, row);
          throw new Error("crash while applying");
        },
      },
    }).send(command.id);
    expect(crashed.status).toBe("unknown");
    expect((await read(command.id))?.status).toBe("unknown");
    expect(await applied()).toBe(before);
    expect(errors).toMatchObject([{ code: "SETTLE_FAILED" }]);
    await expect(
      frozen(node, { subjectId: command.subjectId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect((await withHook(bump).resolve(command.id)).status).toBe("succeeded");
    expect(await applied()).toBe(before + 1);
    expect(await effects()).toBe(beforeEffects + 1);
  });

  it("[F1 review 1] concurrent settles apply once; a settled row never applies again", async () => {
    const before = await applied();
    const command = await frozen();
    expect((await client(node, lostAnswer).send(command.id)).status).toBe(
      "unknown",
    );
    const results = await Promise.all([
      withHook(bump).resolve(command.id),
      withHook(bump).resolve(command.id),
      withHook(bump).send(command.id),
    ]);
    expect(results.map((row) => row.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    await withHook(bump).resolve(command.id);
    expect(await applied()).toBe(before + 1);
  });

  it("[F1 review 1] the hook sees the settled row, also for a tombstone", async () => {
    const command = await frozen();
    const seen: string[] = [];
    await withHook(async (_tx, row) => seen.push(row.status)).resolve(
      command.id,
    );
    expect(seen).toEqual(["absent"]);
  });

  it("[F1 review 1] a kind without a hook is never settled", async () => {
    const command = await frozen();
    const errors: unknown[] = [];
    const row = await client(node, fetch, "primary", {
      onSettled: {},
      onError: (error) => errors.push(error),
    }).send(command.id);
    expect(row.status).toBe("unknown");
    expect(errors).toMatchObject([{ code: "SETTLE_FAILED" }]);
  });
});

describe("[F1 review 2] the node lock", () => {
  it("[F1 review 2] a link write on the node row does not deadlock with a command", async () => {
    const of = await createNode(await secondOutlet());
    const command = await frozen(of);
    await post((await frozen(of)).body, of); // creates the counter row
    const link = await owner.connect();
    try {
      await link.query("BEGIN");
      await link.query("SET LOCAL statement_timeout = '4s'");
      await link.query(
        "UPDATE sync_cursors SET updated_at = now() WHERE edge_node_id = $1 AND direction = 'cloud_to_edge'",
        [of.edgeNodeId],
      );
      const posted = post(command.body, of);
      await waitForLockWaiters(1); // the handler waits for the cursor row
      await link.query(
        "UPDATE edge_nodes SET last_sync_cursor = '7', updated_at = now() WHERE id = $1",
        [of.edgeNodeId],
      );
      await link.query("COMMIT");
      expect((await posted).status).toBe(200);
    } finally {
      await link.query("ROLLBACK");
      link.release();
    }
    expect(await effects(of)).toBe(2);
  });

  it("[F1 review 2] a revocation waits for a running command", async () => {
    const of = await createNode(await secondOutlet());
    const command = await frozen(of);
    let open!: () => void;
    gate = new Promise((resolve) => (open = resolve));
    const posted = post(command.body, of);
    while (entered === 0)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const revoked = revokeEdgeNode(edgeNodeContext(of), actor, {
      edgeNodeId: of.edgeNodeId,
      reason: "uji F1",
    });
    await waitForLockWaiters(1);
    open();
    expect((await posted).status).toBe(200);
    await revoked;
  });

  it("[F1 review 2] a command waits for a running revocation and is refused", async () => {
    const of = await createNode(await secondOutlet());
    const command = await frozen(of);
    const revoke = await owner.connect();
    try {
      await revoke.query("BEGIN");
      await revoke.query("SELECT 1 FROM edge_nodes WHERE id = $1 FOR UPDATE", [
        of.edgeNodeId,
      ]);
      const posted = post(command.body, of);
      await waitForLockWaiters(1);
      await revoke.query(
        "UPDATE edge_nodes SET status = 'revoked', revoked_at = now() WHERE id = $1",
        [of.edgeNodeId],
      );
      await revoke.query("COMMIT");
      expect((await posted).status).toBe(403);
    } finally {
      await revoke.query("ROLLBACK");
      revoke.release();
    }
    expect(await execution(command.id)).toBeUndefined();
  });
});

describe("[F1 review 3] time limits", () => {
  it("[F1 review 3] waiting for a lock ends after 5 s with 503; the edge stays unknown", async () => {
    const before = await effects();
    const command = await frozen();
    let open!: () => void;
    gate = new Promise((resolve) => (open = resolve));
    const first = post(command.body);
    while (entered === 0)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const started = Date.now();
    try {
      const [second, status] = await Promise.all([
        post(command.body),
        client().resolve(command.id),
      ]);
      expect(Date.now() - started).toBeLessThan(9_000);
      expect(second.status).toBe(503);
      expect(await second.json()).toMatchObject({
        error: { code: "EDGE_COMMAND_BUSY" },
      });
      expect(status.status).toBe("pending");
      expect((await client().send(command.id)).status).toBe("unknown");
    } finally {
      open();
    }
    expect((await first).status).toBe(200);
    expect((await client().resolve(command.id)).status).toBe("succeeded");
    expect(await effects()).toBe(before + 1);
  }, 40_000);

  it("[F1 review 3] a slow statement ends after 10 s with 503 and keeps nothing", async () => {
    const before = await effects();
    const command = await frozen();
    behavior = "slow";
    const response = await post(command.body);
    expect(response.status).toBe(503);
    expect(await execution(command.id)).toBeUndefined();
    expect(await effects()).toBe(before);
    behavior = "ok";
    expect((await client().send(command.id)).status).toBe("succeeded");
    expect(await effects()).toBe(before + 1);
  }, 40_000);
});

describe("[F1 review 4] bounds, recovery, retention and the clock", () => {
  it("[F1 review 4] an oversized result is refused and keeps no effect", async () => {
    const before = await effects();
    const command = await frozen();
    behavior = "huge";
    expect(await client().send(command.id)).toMatchObject({
      status: "refused",
      code: "RESULT_TOO_LARGE",
    });
    expect(await effects()).toBe(before);
  });

  async function isolated(count: number) {
    const of = await createNode(await secondOutlet());
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) ids.push((await frozen(of)).id);
    return { of, ids: ids.sort() };
  }
  const idOf = (url: unknown) => String(url).split("/").at(-2);

  it("[F1 review 4] recovery stops at the first unreachable answer", async () => {
    const { of } = await isolated(3);
    let calls = 0;
    const unreachable: typeof fetch = async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    };
    expect(
      await client(of, unreachable, "primary", {
        resolveMinAgeMs: 0,
      }).resolveOpen(),
    ).toEqual({ settled: 0, open: 3 });
    expect(calls).toBe(1);
  });

  it("[F1 review 4] recovery rotates past commands that stay open", async () => {
    const { of, ids } = await isolated(5);
    const asked: (string | undefined)[] = [];
    const refusing: typeof fetch = async (url) => {
      asked.push(idOf(url));
      return new Response("{}", { status: 403 });
    };
    const edge = client(of, refusing, "primary", {
      resolveMinAgeMs: 0,
      resolveBatch: 2,
    });
    for (let round = 0; round < 3; round += 1) await edge.resolveOpen();
    expect(asked).toEqual([...ids, ids[0]]);
  });

  it("[F1 review 4] recovery leaves young and in-flight commands alone", async () => {
    const { of, ids } = await isolated(1);
    const asked: unknown[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl: typeof fetch = async (url, init) => {
      asked.push(url);
      if (!String(url).endsWith("/status")) await held;
      return fetch(url, init);
    };
    // Default minimum age (30 s): a command frozen just now is not asked.
    await client(of, fetchImpl).resolveOpen();
    expect(asked).toEqual([]);
    // In flight in this process: not asked either, whatever its age.
    const edge = client(of, fetchImpl, "primary", { resolveMinAgeMs: 0 });
    const sending = edge.send(ids[0]!);
    while (asked.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await edge.resolveOpen();
    expect(asked).toHaveLength(1);
    release();
    expect((await sending).status).toBe("succeeded");
  });

  it("[F1 review 4] an expired command is asked, never posted again", async () => {
    const command = await frozen(node, {
      now: new Date(Date.now() - 10_000),
      ttlMs: 10_500,
    });
    expect((await client(node, dead).send(command.id)).status).toBe("unknown");
    await new Promise((resolve) => setTimeout(resolve, 600));
    const urls: string[] = [];
    const recording: typeof fetch = (url, init) => {
      urls.push(String(url));
      return fetch(url, init);
    };
    expect((await client(node, recording).send(command.id)).status).toBe(
      "absent",
    );
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/\/status$/);
  });

  it("[F1 review 4] the app serves the route on the cloud only", async () => {
    const command = await frozen();
    const send = (edgeMode: boolean) =>
      request(createApp({ edgeMode }))
        .post(EDGE_COMMAND_PATH)
        .set("Authorization", `Bearer ${node.credential}`)
        .set(EDGE_COMMAND_INSTANCE_HEADER, node.instanceId)
        .set("Content-Type", "application/json")
        .send(command.body);
    const refused = await send(true);
    expect(refused.status).toBe(404);
    expect(refused.body.error.code).toBe("CLOUD_ONLY_ROUTE");
    const served = await send(false);
    expect(served.status).toBe(200);
    expect(served.body.data).toMatchObject({
      id: command.id,
      status: "succeeded",
      result: { note: "halo" },
    });
    const anonymous = await request(createApp({ edgeMode: false }))
      .post(`${EDGE_COMMAND_PATH}/${command.id}/status`)
      .send({ kind: command.kind, bodySha256: command.bodySha256 });
    expect(anonymous.status).toBe(401);
  });

  async function age(table: string, column: string, id: string, days: number) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(
        `UPDATE ${table} SET ${column} = now() - make_interval(days => $2) WHERE id = $1`,
        [ulidToUuid(id), days],
      );
      await c.query("COMMIT");
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  }

  it("[F1 review 4] the edge forgets body and result 30 days after settling, the key stays", async () => {
    const old = await frozen();
    const young = await frozen();
    const open = await frozen();
    await client().send(old.id);
    await client().send(young.id);
    await age("edge_command_requests", "settled_at", old.id, 31);
    await age("edge_command_requests", "settled_at", young.id, 29);
    await age("edge_command_requests", "created_at", open.id, 400);
    expect(
      await purgeSettledEdgeCommands(
        db,
        edgeNodeContext(node),
        node,
        new Date(),
      ),
    ).toBe(1);
    expect(await read(old.id)).toMatchObject({
      status: "succeeded",
      body: null,
      result: null,
      bodySha256: old.bodySha256,
    });
    expect(await read(young.id)).toMatchObject({ result: { note: "halo" } });
    expect((await read(open.id))?.body).toBe(open.body);
    await expect(
      owner.query(
        "UPDATE edge_command_requests SET body = NULL, result = NULL, purged_at = now() WHERE id = $1",
        [ulidToUuid(young.id)],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("[F1 review 4] the cloud forgets results after 90 days; the key stays spent", async () => {
    const before = await effects();
    const command = await frozen();
    await post(command.body);
    await age("edge_command_executions", "decided_at", command.id, 89);
    const context = edgeNodeContext(node);
    expect(await purgeEdgeCommandResults(db, context, new Date())).toBe(0);
    await age("edge_command_executions", "decided_at", command.id, 91);
    expect(await purgeEdgeCommandResults(db, context, new Date())).toBe(1);
    const replay = await post(command.body);
    expect(replay.status).toBe(410);
    expect((await client().resolve(command.id)).status).toBe("pending");
    expect(await execution(command.id)).toMatchObject({ status: "succeeded" });
    expect(await effects()).toBe(before + 1);
  });

  it("[F1 review 4] an edge clock further behind than the TTL alarms once a day; a late send does not", async () => {
    const of = await createNode(await secondOutlet());
    const alerts = async () => {
      const { rows } = await owner.query<{ n: string }>(
        "SELECT count(DISTINCT source_event_id) AS n FROM notifications WHERE outlet_id = $1",
        [of.outletId],
      );
      return Number(rows[0]?.n);
    };
    await owner.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'F1 Owner', $2, true, now(), now())`,
      [actor, `f1-${actor}@example.com`],
    );
    const roleId = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'F1 Owner', true, 'owner', '[]', false, '["tenant"]')`,
      [roleId, of.tenantId],
    );
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [of.tenantId, actor, roleId],
    );
    const stale = { now: new Date(Date.now() - 600_000), ttlMs: 60_000 };
    // Right clock, the command only arrived late.
    const late = await frozen(of, stale);
    await post(late.body, of, { clock: new Date() });
    expect(await execution(late.id)).toMatchObject({ status: "expired" });
    expect(await alerts()).toBe(0);
    for (let i = 0; i < 2; i += 1) {
      const command = await frozen(of, stale);
      await post(command.body, of, { clock: stale.now });
      expect(await execution(command.id)).toMatchObject({ status: "expired" });
    }
    expect(await alerts()).toBe(1);
  });

  it("[F1 review 4] the client sends its clock", async () => {
    const command = await frozen();
    let clock: string | null = null;
    const recording: typeof fetch = (url, init) => {
      clock = new Headers(init?.headers).get(EDGE_COMMAND_CLOCK_HEADER);
      return fetch(url, init);
    };
    await client(node, recording).send(command.id);
    expect(Math.abs(Date.parse(clock ?? "") - Date.now())).toBeLessThan(10_000);
  });
});
