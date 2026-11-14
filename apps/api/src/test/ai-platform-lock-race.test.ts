// AI platform lock, second-opinion findings (bead legend-c8dmr).
// Written from the shared brief (lock-brief.md), docs/briefs/sub-ai-settings-v2.md
// and the existing lock suite, never from the implementation.
//
// Contract: while the platform lock is on (`ai_assistant` missing from
// tenants.feature_flags.modules) every AI path answers 403 AI_PLATFORM_DISABLED
// (AiError("AI_PLATFORM_DISABLED")). The lock change and the START of an AI
// operation must be serialized: an operation that starts after a lock write
// began must wait for it and then see the lock.
//
// Race technique (deterministic, no sleeps as assertions): a dedicated owner
// connection plays the in-flight lock writer (BEGIN + UPDATE tenants, not yet
// committed). The operation under test starts, and we wait until PostgreSQL
// reports a lock waiter on that writer's transaction id (pg_locks). Only a
// check that takes a row lock (FOR SHARE) blocks there; a plain read would
// sail through on the old snapshot. Then the writer commits and the operation
// must end locked.
//
// ASSUMPTIONS (also in the report):
//  - `settleActionRequest` (worker path) REJECTS with AiError
//    AI_PLATFORM_DISABLED under lock (brief: "propagate", not return "failed").
//    The action row must stay in whatever status it had (not 'failed', no
//    failure_reason, no executed event) and execute normally after unlock.
//  - `getActionRequestView` (read-through settle) also rejects with the lock
//    error for an approved-but-unexecuted request (brief finding 2, findRow).
//  - Authorize GET under lock either answers 403 JSON with AI_PLATFORM_DISABLED
//    or redirects (validated redirect_uri) with error=access_denied and
//    error_description=AI_PLATFORM_DISABLED. Never a code, never the consent page.
//  - The token and register endpoints answer HTTP 403 with AI_PLATFORM_DISABLED
//    somewhere in the JSON body.
//  - `systemAiComplete` is the exported entry of ai-system-call.ts ("aiSystemCall"
//    in the brief).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { AiError, type McpScope } from "@starter/shared/ai";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAiProviderForTests } from "../lib/ai/provider-factory.ts";
import { aiComplete } from "../services/ai-gateway.service.ts";
import { isAiPlatformLockedShared } from "../services/ai-platform-lock.ts";
import {
  getActionRequestView,
  settleActionRequest,
} from "../services/ai-action-request.service.ts";
import { systemAiComplete } from "../services/ai-system-call.ts";
import { writeTools } from "../services/ai-tools/write/index.ts";
import type { AiToolContext } from "../services/ai-tools/types.ts";
import {
  loadTenantAccess,
  resolveAccessSnapshot,
  type AccessSnapshot,
} from "../services/permission-resolver.ts";
import {
  availabilityFingerprint,
  cleanupAcceptance,
  codeOf,
  createMenuItem,
  grantCustomRole,
  grantTemplateRole,
  newOwner,
  originHeader,
  outletA,
  ownerPool,
  patchGovernance,
  plainAnswer,
  resetGovernance,
  signedIn,
  tenantAgent,
  tenantId,
  type Actor,
} from "./ai-acceptance-helpers.ts";
import { owner as floorPool } from "./floor-test-helpers.ts";

const LOCKED = "AI_PLATFORM_DISABLED";
const BUDGET = 777_000_000;
const REDIRECT_URI = "http://localhost:8123/callback";
const METADATA_PATH = "/.well-known/oauth-authorization-server";
const MCP_SCOPES: McpScope[] = ["mcp:sales:read", "mcp:menu:read"];

const tenant = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
const workerContext = establishScopedTenantContext(tenant, { kind: "tenant" });

let admin: Actor;
let originalModules: string[] = [];

// ---- Module flag (plain SQL, same as the main lock suite) ---------------------

const withoutAi = () => originalModules.filter((m) => m !== "ai_assistant");
const SET_MODULES_SQL = `UPDATE tenants SET feature_flags = jsonb_set(feature_flags, '{modules}', $2::jsonb) WHERE id = $1`;
const setModules = (modules: string[]) =>
  floorPool.query(SET_MODULES_SQL, [tenantId, JSON.stringify(modules)]);
const lock = () => setModules(withoutAi());
const unlock = () => setModules(originalModules);

// ---- Race helpers --------------------------------------------------------------

/** An uncommitted lock write on its own connection (the "in-flight lock writer"). */
async function beginLockWrite() {
  const c = await floorPool.connect();
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      c.release();
    }
  };
  try {
    await c.query("BEGIN");
    await c.query(SET_MODULES_SQL, [tenantId, JSON.stringify(withoutAi())]);
    const xid = (
      await c.query<{ x: string }>(
        "SELECT pg_current_xact_id()::xid::text AS x",
      )
    ).rows[0]!.x;
    return {
      xid,
      commit: async () => {
        await c.query("COMMIT");
        release();
      },
      rollback: async () => {
        await c.query("ROLLBACK").catch(() => undefined);
        release();
      },
    };
  } catch (error) {
    await c.query("ROLLBACK").catch(() => undefined);
    release();
    throw error;
  }
}

type Tracked<T> = {
  promise: Promise<void>;
  done: () => boolean;
  result: () => { value?: T; error?: unknown };
};
function track<T>(run: () => Promise<T>): Tracked<T> {
  let finished = false;
  let outcome: { value?: T; error?: unknown } = {};
  const promise = run().then(
    (value) => {
      finished = true;
      outcome = { value };
    },
    (error: unknown) => {
      finished = true;
      outcome = { error };
    },
  );
  return { promise, done: () => finished, result: () => outcome };
}

/** True once some backend waits on `xid`; false if `settled()` flips first or the wait times out. */
async function waitForWaiterOn(
  xid: string,
  settled: () => boolean,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (settled()) return false;
    const { rows } = await floorPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = $1`,
      [xid],
    );
    if (rows[0]!.n > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function expectLockError(error: unknown) {
  expect(error, "expected the lock error").toBeInstanceOf(AiError);
  expect((error as AiError).code).toBe(LOCKED);
}

async function sumQuery(sql: string): Promise<string> {
  const r = await ownerPool.query<{ v: string }>(sql, [tenantId]);
  return String(r.rows[0]?.v ?? "0");
}
const reservedTotal = () =>
  sumQuery(
    "SELECT coalesce(sum(reserved_cost_idr),0)::text AS v FROM ai_usage_monthly WHERE tenant_id = $1",
  );

function accessFor(userId: string): AccessSnapshot {
  const permissions = ["ai.ask"];
  return {
    tenant,
    userId,
    permissions,
    mfaRequired: false,
    mfaVerified: true,
    templateKeys: ["employee"],
    allows: () => true,
    permissionsVia: () => permissions,
    allowsVia: () => true,
    contextFor: () => null,
    stationsFor: () => [],
  } as unknown as AccessSnapshot;
}

const completeInput = {
  system: "Kamu asisten.",
  messages: [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "halo" }],
    },
  ],
  tools: [],
  maxTokens: 100,
};

// ---- Action request helpers (same fixtures as ai-action-requests.test.ts) ----------

async function accessOf(userId: string): Promise<AccessSnapshot> {
  const data = await loadTenantAccess(workerContext, userId);
  return resolveAccessSnapshot({
    tenant,
    userId,
    ...data,
    mfaVerified: true,
    now: new Date(),
  });
}
async function ctxOf(actor: Actor): Promise<AiToolContext> {
  return {
    access: await accessOf(actor.userId),
    channel: "tanya_ai",
    mcpClientId: null,
    now: new Date(),
  };
}
async function eventCount(name: string, actionRequestId: string) {
  const { rows } = await ownerPool.query(
    `SELECT 1 FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = $3`,
    [tenantId, actionRequestId, name],
  );
  return rows.length;
}
async function actionRow(id: string) {
  const { rows } = await ownerPool.query<{
    status: string;
    failure_reason: string | null;
  }>("SELECT status, failure_reason FROM action_requests WHERE id = $1", [id]);
  return rows[0]!;
}

/** An approved, not yet executed availability request plus the data fingerprint. */
async function approvedRequest() {
  const owner = await newOwner();
  const menuItemId = await createMenuItem(owner);
  const requester = await signedIn("Kitchen Lead kunci");
  await grantTemplateRole(requester.userId, "kitchen_lead", {
    type: "outlet",
    id: outletA,
  });
  const approver = await signedIn("Manajer kunci");
  await grantTemplateRole(approver.userId, "outlet_manager", {
    type: "outlet",
    id: outletA,
  });
  const before = await availabilityFingerprint(menuItemId);
  const ctx = await ctxOf(requester);
  const receipt = (await writeTools["TL-18"]!(ctx, {
    outletId: outletA,
    items: [{ menuItemId, available: false }],
    reason: "Bahan habis",
  })) as { actionRequestId: string; approvalRequestId: string };
  const decision = await approver.client
    .post(`/api/approvals/${receipt.approvalRequestId}/decisions`)
    .set(originHeader)
    .send({ decision: "approved", reason: "Uji kunci platform" });
  expect(decision.status, decision.text).toBe(200);
  return { ...receipt, menuItemId, before, ctx };
}

// ---- MCP / OAuth helpers -----------------------------------------------------------

const pathOf = (url: string) => new URL(url, "http://localhost").pathname;
const metadata = async () =>
  (await tenantAgent().get(METADATA_PATH)).body as Record<string, string>;
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
};

async function powerUser(name: string): Promise<Actor> {
  const user = await signedIn(name);
  await grantCustomRole(
    user.userId,
    ["ai.ask", "report.sales.view", "menu.item.view"],
    { type: "tenant" },
  );
  for (const key of ["employee", "outlet_manager"] as const)
    await grantTemplateRole(user.userId, key, { type: "outlet", id: outletA });
  return user;
}

async function approvedClient(): Promise<{ id: string; clientId: string }> {
  const clientId = `race-${randomUUID().slice(0, 12)}`;
  const created = await admin.client
    .post("/api/ai/mcp-clients")
    .set(originHeader)
    .send({
      name: `Klien race ${clientId}`,
      clientId,
      redirectUris: [REDIRECT_URI],
      allowedScopes: MCP_SCOPES,
    });
  expect(created.status, created.text).toBe(201);
  const id = created.body.data.id as string;
  const approved = await admin.client
    .post(`/api/ai/mcp-clients/${id}/approve`)
    .set(originHeader)
    .send({});
  expect(approved.status, approved.text).toBe(200);
  return { id, clientId };
}

const authorizeGet = async (
  user: Actor,
  clientId: string,
  challenge: string,
  endpoint?: string,
) =>
  user.client
    .get(endpoint ?? pathOf((await metadata()).authorization_endpoint!))
    .query({
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      scope: MCP_SCOPES.join(" "),
      state: randomUUID(),
      code_challenge: challenge,
      code_challenge_method: "S256",
    })
    .redirects(0);

/** Unlocked GET authorize -> the consent page parameters. */
async function consentParams(user: Actor, clientId: string, challenge: string) {
  const res = await authorizeGet(user, clientId, challenge);
  const location = res.headers.location as string | undefined;
  expect(
    location,
    `authorize before lock: ${res.status} ${res.text}`,
  ).toBeTruthy();
  const url = new URL(location!, REDIRECT_URI);
  expect(url.pathname).toBe("/mcp/consent");
  return Object.fromEntries(url.searchParams.entries());
}
const approveConsent = (user: Actor, params: Record<string, string>) =>
  user.client
    .post("/api/ai/mcp/authorize")
    .set(originHeader)
    .send({ ...params, approve: true });

const tokenPost = async (body: Record<string, string>) =>
  tenantAgent()
    .post(pathOf((await metadata()).token_endpoint!))
    .type("form")
    .send(body);

/** Unlocked: full consent -> a fresh authorization code and its PKCE verifier. */
async function freshCode(user: Actor, clientId: string) {
  const { verifier, challenge } = pkce();
  const params = await consentParams(user, clientId, challenge);
  const approve = await approveConsent(user, params);
  expect(approve.status, approve.text).toBe(200);
  const back = new URL(approve.body.redirectTo as string, REDIRECT_URI);
  const code = back.searchParams.get("code");
  expect(code, approve.text).toBeTruthy();
  return { code: code!, verifier };
}
const exchange = (clientId: string, code: string, verifier: string) =>
  tokenPost({
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
    code,
    client_id: clientId,
    code_verifier: verifier,
  });

// ---- Lifecycle -----------------------------------------------------------------------

beforeAll(async () => {
  const flags = await floorPool.query<{ modules: string[] }>(
    "SELECT feature_flags->'modules' AS modules FROM tenants WHERE id = $1",
    [tenantId],
  );
  originalModules = flags.rows[0]!.modules;
  expect(originalModules, "fixture tenant has Tanya AI").toContain(
    "ai_assistant",
  );
  admin = await newOwner("Admin kunci race");
}, 60_000);

beforeEach(async () => {
  await unlock();
  setAiProviderForTests(null);
  await resetGovernance(admin);
  await patchGovernance(admin, { monthlyBudgetIdr: BUDGET });
}, 30_000);

afterEach(async () => {
  await unlock();
});

afterAll(async () => {
  await unlock().catch(() => undefined);
  setAiProviderForTests(undefined);
  await resetGovernance(admin).catch(() => undefined);
  await cleanupAcceptance().catch(() => undefined);
  await ownerPool.end();
});

// ---- Finding 1: check-and-start is serialized with a lock change ----------------------

describe("legend-c8dmr (1) lock change and operation start are serialized", () => {
  // Needs: isAiPlatformLockedShared(executor, tenantId) taking FOR SHARE.
  it("an operation holding the shared lock check makes the lock write wait until it ends", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: (locked: boolean) => void;
    const enteredP = new Promise<boolean>((resolve) => (entered = resolve));
    const reader = withTenant(db, workerContext, async (tx) => {
      entered(await isAiPlatformLockedShared(tx, tenantId));
      await held;
    });
    // Reader may fail to open: surface that instead of hanging on `enteredP`.
    const readerSettled = reader.then(
      () => undefined,
      (error: unknown) => {
        entered(true);
        throw error;
      },
    );
    expect(await enteredP, "unlocked while the operation starts").toBe(false);

    const writer = await floorPool.connect();
    try {
      const { rows } = await writer.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const pid = rows[0]!.pid;
      let writeDone = false;
      const write = writer
        .query(SET_MODULES_SQL, [tenantId, JSON.stringify(withoutAi())])
        .then(() => {
          writeDone = true;
        });
      // Wait until PostgreSQL shows the writer blocked, then prove it is held back.
      let blocked = false;
      for (let i = 0; i < 400 && !blocked && !writeDone; i += 1) {
        const r = await floorPool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1 AND NOT granted",
          [pid],
        );
        blocked = r.rows[0]!.n > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked, "lock write waits for the in-flight operation").toBe(
        true,
      );
      expect(writeDone).toBe(false);
      release();
      await readerSettled;
      await write;
      expect(writeDone).toBe(true);
    } finally {
      release();
      writer.release();
    }
  }, 30_000);

  // Needs: reserveAiBudget using isAiPlatformLockedShared in the reservation tx.
  it("gateway: a call that starts while a lock write is in flight waits, then fails locked with no provider call and no reservation", async () => {
    const provider = plainAnswer();
    setAiProviderForTests(provider);
    // Sanity: unlocked, the same call is served (so a failure below is the lock).
    await aiComplete(accessFor(admin.userId), completeInput, {
      feature: "AI-01",
      channel: "app",
    });
    const served = provider.requests.length;
    expect(served).toBeGreaterThan(0);
    const reservedBefore = await reservedTotal();

    const writer = await beginLockWrite();
    let committed = false;
    try {
      const call = track(() =>
        aiComplete(accessFor(admin.userId), completeInput, {
          feature: "AI-01",
          channel: "app",
        }),
      );
      expect(
        await waitForWaiterOn(writer.xid, call.done),
        "the reservation must queue behind the in-flight lock write",
      ).toBe(true);
      expect(call.done()).toBe(false);
      await writer.commit();
      committed = true;
      await call.promise;
      expectLockError(call.result().error);
      expect(provider.requests).toHaveLength(served);
      expect(await reservedTotal()).toBe(reservedBefore);
    } finally {
      if (!committed) await writer.rollback();
    }
  }, 60_000);

  // Needs: assertActorStillValid in execute() using the shared lock check.
  it("action execute: an approved request that starts while a lock write is in flight waits, then is refused and changes nothing", async () => {
    const req = await approvedRequest();
    const rowBefore = await actionRow(req.actionRequestId);

    const writer = await beginLockWrite();
    let committed = false;
    try {
      const settle = track(() =>
        settleActionRequest(workerContext, req.actionRequestId),
      );
      expect(
        await waitForWaiterOn(writer.xid, settle.done),
        "execute must queue behind the in-flight lock write",
      ).toBe(true);
      expect(settle.done()).toBe(false);
      await writer.commit();
      committed = true;
      await settle.promise;
      expectLockError(settle.result().error);
    } finally {
      if (!committed) await writer.rollback();
    }
    expect(await availabilityFingerprint(req.menuItemId)).toBe(req.before);
    expect(await actionRow(req.actionRequestId)).toEqual(rowBefore);
    expect(
      await eventCount("action_request.executed", req.actionRequestId),
    ).toBe(0);
  }, 60_000);
});

// ---- Finding 2: a locked execute is not a failure -----------------------------------------

describe("legend-c8dmr (2) locked action execute is not 'failed'", () => {
  it("settle under lock rejects AI_PLATFORM_DISABLED, the row is untouched, and it executes once unlocked", async () => {
    const req = await approvedRequest();
    const rowBefore = await actionRow(req.actionRequestId);
    expect(rowBefore.status).not.toBe("failed");

    await lock();
    const error = await settleActionRequest(
      workerContext,
      req.actionRequestId,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expectLockError(error);
    const rowLocked = await actionRow(req.actionRequestId);
    expect(rowLocked.status).not.toBe("failed");
    expect(rowLocked).toEqual(rowBefore);
    expect(rowLocked.failure_reason).toBeNull();
    expect(await availabilityFingerprint(req.menuItemId)).toBe(req.before);
    expect(
      await eventCount("action_request.executed", req.actionRequestId),
    ).toBe(0);

    await unlock();
    expect(await settleActionRequest(workerContext, req.actionRequestId)).toBe(
      "executed",
    );
    expect(await availabilityFingerprint(req.menuItemId)).not.toBe(req.before);
  }, 60_000);

  it("read-through (getActionRequestView) does not swallow the lock error nor mark the row failed", async () => {
    const req = await approvedRequest();
    const rowBefore = await actionRow(req.actionRequestId);
    await lock();
    const error = await getActionRequestView(
      req.ctx.access,
      req.actionRequestId,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expectLockError(error);
    expect(await actionRow(req.actionRequestId)).toEqual(rowBefore);
  }, 60_000);
});

// ---- Finding 3: system call reports its own skip reason --------------------------------------

describe("legend-c8dmr (3) systemAiComplete under lock", () => {
  it("answers ok:false platform_locked (not feature_disabled) and never calls the provider", async () => {
    const provider = plainAnswer();
    setAiProviderForTests(provider);
    await lock();
    const outcome = await systemAiComplete(
      accessFor(admin.userId),
      completeInput,
      { feature: "AI-10", outletId: null },
    );
    expect(outcome).toEqual({ ok: false, reason: "platform_locked" });
    expect(provider.requests).toHaveLength(0);
  });
});

// ---- Finding 4: MCP OAuth entry points under lock -----------------------------------------------

describe("legend-c8dmr (4) MCP OAuth refuses under lock and burns nothing", () => {
  it("GET authorize gives no code and never the consent page: 403 or access_denied with AI_PLATFORM_DISABLED", async () => {
    const client = await approvedClient();
    const user = await powerUser("Pengguna authorize race");
    const authorizeEndpoint = pathOf(
      (await metadata()).authorization_endpoint!,
    );
    await lock();
    const res = await authorizeGet(
      user,
      client.clientId,
      pkce().challenge,
      authorizeEndpoint,
    );
    if (res.status === 403) {
      expect(`${res.text}${JSON.stringify(res.body ?? "")}`).toContain(LOCKED);
      return;
    }
    expect(res.status, res.text).toBeGreaterThanOrEqual(300);
    expect(res.status, res.text).toBeLessThan(400);
    const url = new URL(res.headers.location as string, REDIRECT_URI);
    expect(url.pathname).not.toBe("/mcp/consent");
    expect(url.searchParams.get("code")).toBeNull();
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("error_description")).toContain(LOCKED);
  });

  it("POST /api/ai/mcp/authorize (consent) answers 403 AI_PLATFORM_DISABLED and issues no code; works again once unlocked", async () => {
    const client = await approvedClient();
    const user = await powerUser("Pengguna consent race");
    const params = await consentParams(user, client.clientId, pkce().challenge);
    await lock();
    const refused = await approveConsent(user, params);
    expect(refused.status, refused.text).toBe(403);
    expect(codeOf(refused), refused.text).toBe(LOCKED);
    expect(refused.text).not.toMatch(/[?&]code=/);
    await unlock();
    const ok = await approveConsent(user, params);
    expect(ok.status, ok.text).toBe(200);
    expect(
      new URL(ok.body.redirectTo as string, REDIRECT_URI).searchParams.get(
        "code",
      ),
    ).toBeTruthy();
  });

  it("token endpoint answers 403 AI_PLATFORM_DISABLED and does not burn the code: it still exchanges once unlocked", async () => {
    const client = await approvedClient();
    const user = await powerUser("Pengguna token race");
    const { code, verifier } = await freshCode(user, client.clientId);
    await lock();
    const refused = await exchange(client.clientId, code, verifier);
    expect(refused.status, refused.text).toBe(403);
    expect(`${refused.text}${JSON.stringify(refused.body ?? "")}`).toContain(
      LOCKED,
    );
    expect(refused.body.access_token).toBeUndefined();
    await unlock();
    const ok = await exchange(client.clientId, code, verifier);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.access_token).toBeTruthy();
  });

  it("dynamic registration answers 403 AI_PLATFORM_DISABLED and registers no client", async () => {
    expect(
      (await patchGovernance(admin, { dynamicClientRegistrationEnabled: true }))
        .status,
    ).toBe(200);
    const registrationEndpoint = (await metadata()).registration_endpoint;
    expect(
      registrationEndpoint,
      "registration enabled before lock",
    ).toBeTruthy();
    const listBefore = (await admin.client.get("/api/ai/mcp-clients")).body
      .data as unknown[];
    await lock();
    const res: request.Response = await tenantAgent()
      .post(pathOf(registrationEndpoint!))
      .send({
        client_name: `Klien dinamis race ${randomUUID().slice(0, 8)}`,
        redirect_uris: [REDIRECT_URI],
        scope: "mcp:sop:read",
        token_endpoint_auth_method: "none",
      });
    expect(res.status, res.text).toBe(403);
    expect(`${res.text}${JSON.stringify(res.body ?? "")}`).toContain(LOCKED);
    expect(res.body.client_id).toBeUndefined();
    const listAfter = (await admin.client.get("/api/ai/mcp-clients")).body
      .data as unknown[];
    expect(listAfter.length).toBe(listBefore.length);
  });
});
