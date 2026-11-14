// AI platform lock per tenant (bead legend-nnufz, keputusan founder W16 Q7).
// Written from docs/briefs/sub-ai-settings-v2.md ("Server: kunci platform AI
// per tenant") and the shared contract, never from the implementation.
//
// Rule under test: when the platform switches the `ai_assistant` module off for
// a tenant (tenants.feature_flags), ALL AI of that tenant is locked: settings
// writes, provider, ChatGPT, MCP admin writes, Tanya AI, drafts, the gateway,
// system calls, MCP bearer calls and OAuth. Reads and credential/access
// REMOVAL stay open. The lock never touches stored values and never touches
// another tenant. Re-enabling the module restores everything.
//
// ASSUMPTIONS (also in the report):
//  - Locked writes answer HTTP 403 with error code AI_PLATFORM_DISABLED
//    (read through `codeOf`; brief: status 403).
//  - The module flag is the only source: `feature_flags.modules` without
//    "ai_assistant" (edited through plain SQL, no endpoint exists).
//  - "Approve MCP client" is the "update" of ai-mcp-admin; revoke stays open.
//  - The blocked ledger row written by /ask carries status 'blocked' and
//    error_code 'AI_PLATFORM_DISABLED'.
//  - A bearer MCP call under lock answers HTTP 403 with the code somewhere in
//    the body; OAuth authorize gives no code and an `access_denied`-style error.
//  - DELETE /api/ai/chatgpt with no connection may answer 404; what matters is
//    that it is NOT refused with AI_PLATFORM_DISABLED.
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
  establishTenantContext,
  establishScopedTenantContext,
} from "@starter/shared/core/server";
import { env } from "../config/env.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setChatGptCodexFetchForTests } from "../lib/ai/chatgpt-codex.ts";
import {
  setAiProviderForTests,
  setAiProviderNetworkForTests,
} from "../lib/ai/provider-factory.ts";
import { seedTenantRoleTemplates } from "../services/access.service.ts";
import { aiComplete } from "../services/ai-gateway.service.ts";
import { systemAiComplete } from "../services/ai-system-call.ts";
import type { AccessSnapshot } from "../services/permission-resolver.ts";
import {
  app,
  asTenant,
  cleanupAcceptance,
  codeOf,
  created,
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
import {
  createIsolatedTenant,
  owner as floorPool,
  seededTenantId,
} from "./floor-test-helpers.ts";
import { agent, signUp, verifySessionMfa } from "./helpers.ts";

const LOCKED = "AI_PLATFORM_DISABLED";
const BUDGET = 777_000_000;
const PROVIDER_URL = "https://provider-lock.example/v1";
const PROVIDER_KEY = "sk-lock-fixture-0123456789abcdef";
const REDIRECT_URI = "http://localhost:8123/callback";
const MCP_PATH = "/mcp";
const METADATA_PATH = "/.well-known/oauth-authorization-server";
const MCP_SCOPES: McpScope[] = ["mcp:sales:read", "mcp:menu:read"];

let admin: Actor;
let drafter: Actor;
let otherOwner: Actor;
let otherTenantId = "";
let originalModules: string[] = [];
const enabledBefore = (env as unknown as { AI_CHATGPT_ENABLED: boolean })
  .AI_CHATGPT_ENABLED;

// ---- Module flag (plain SQL: no endpoint toggles it from the tenant side) ----

async function setModules(modules: string[]) {
  await floorPool.query(
    `UPDATE tenants SET feature_flags = jsonb_set(feature_flags, '{modules}', $2::jsonb) WHERE id = $1`,
    [tenantId, JSON.stringify(modules)],
  );
}
const lock = () =>
  setModules(originalModules.filter((m) => m !== "ai_assistant"));
const unlock = () => setModules(originalModules);

// ---- Injected network (no test touches the internet) ------------------------

let providerFetches = 0;
let codexFetches = 0;
const fakeFetch = (async () => {
  providerFetches += 1;
  return Response.json({
    id: "chatcmpl-test",
    object: "chat.completion",
    model: "lock-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "OK" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  });
}) as typeof fetch;
const fakeCodexFetch = (async () => {
  codexFetches += 1;
  return new Response("{}", { status: 500 });
}) as typeof fetch;

// ---- Request helpers ----------------------------------------------------------

const putProvider = (who: Actor, model = "lock-model") =>
  who.client.put("/api/ai/provider").set(originHeader).send({
    connectionType: "api_key",
    baseUrl: PROVIDER_URL,
    defaultModel: model,
    apiKey: PROVIDER_KEY,
  });
const getJson = async (who: Actor, path: string) => {
  const res = await who.client.get(path);
  expect(res.status, `${path}: ${res.text}`).toBe(200);
  return res.body.data as Record<string, unknown>;
};
const ask = (who: Actor, question = `Pertanyaan kunci ${randomUUID()}`) =>
  who.client
    .post("/api/ai/ask")
    .set(originHeader)
    .send({ feature: "AI-02", question });

function expectLocked(res: request.Response) {
  expect(res.status, res.text).toBe(403);
  expect(codeOf(res), res.text).toBe(LOCKED);
}

async function sumQuery(sql: string): Promise<string> {
  return asTenant(async (c) => {
    const r = await c.query<{ v: string }>(sql, [tenantId]);
    return String(r.rows[0]?.v ?? "0");
  });
}
const dailyCount = () =>
  sumQuery(
    "SELECT coalesce(sum(request_count),0)::text AS v FROM ai_usage_daily WHERE tenant_id = $1",
  );
const reservedTotal = () =>
  sumQuery(
    "SELECT coalesce(sum(reserved_cost_idr),0)::text AS v FROM ai_usage_monthly WHERE tenant_id = $1",
  );
// Usage events that are NOT the blocked-by-lock marker (i.e. anything that
// would mean a charged/served AI call was recorded).
const chargedEventRows = () =>
  sumQuery(
    "SELECT count(*)::text AS v FROM ai_usage_events WHERE tenant_id = $1 AND NOT (status = 'blocked' AND error_code = 'AI_PLATFORM_DISABLED')",
  );
const chatgptRows = () =>
  sumQuery(
    "SELECT count(*)::text AS v FROM ai_chatgpt_connections WHERE tenant_id = $1",
  );

function accessFor(userId: string): AccessSnapshot {
  const tenant = establishTenantContext({
    tenantId,
    brandId: null,
    source: "session",
  });
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

// ---- MCP / OAuth helpers (black box, same flow as the MCP acceptance suite) ----

async function rpc(token: string, method: string, params?: object) {
  const res = await request(app)
    .post(MCP_PATH)
    .set("Accept", "application/json, text/event-stream")
    .set("Content-Type", "application/json")
    .set("Authorization", `Bearer ${token}`)
    .send({ jsonrpc: "2.0", id: 1, method, params });
  return {
    status: res.status,
    raw: `${res.text ?? ""}${JSON.stringify(res.body ?? "")}`,
  };
}
const pathOf = (url: string) => new URL(url, "http://localhost").pathname;

async function powerUser(name: string): Promise<Actor> {
  const user = await signedIn(name);
  await grantCustomRole(
    user.userId,
    [
      "ai.ask",
      "ai.action.propose",
      "report.sales.view",
      "menu.item.view",
      "menu.availability.toggle",
    ],
    { type: "tenant" },
  );
  for (const key of ["employee", "outlet_manager", "kitchen_lead"] as const)
    await grantTemplateRole(user.userId, key, { type: "outlet", id: outletA });
  return user;
}

async function registerClient(): Promise<{ id: string; clientId: string }> {
  const clientId = `lock-${randomUUID().slice(0, 12)}`;
  const res = await admin.client
    .post("/api/ai/mcp-clients")
    .set(originHeader)
    .send({
      name: `Klien kunci ${clientId}`,
      clientId,
      redirectUris: [REDIRECT_URI],
      allowedScopes: MCP_SCOPES,
    });
  expect(res.status, res.text).toBe(201);
  return { id: res.body.data.id as string, clientId };
}
async function approvedClient() {
  const rec = await registerClient();
  const res = await admin.client
    .post(`/api/ai/mcp-clients/${rec.id}/approve`)
    .set(originHeader)
    .send({});
  expect(res.status, res.text).toBe(200);
  return rec;
}

/** GET authorize (-> consent) then POST consent. Returns the code or an error. */
async function authorize(user: Actor, clientId: string, challenge: string) {
  const meta = (await tenantAgent().get(METADATA_PATH)).body as Record<
    string,
    string
  >;
  const res = await user.client
    .get(pathOf(meta.authorization_endpoint!))
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
  const location = res.headers.location as string | undefined;
  if (res.status >= 300 && res.status < 400 && location) {
    const url = new URL(location, REDIRECT_URI);
    if (url.pathname !== "/mcp/consent")
      return {
        code: url.searchParams.get("code"),
        error: url.searchParams.get("error") ?? "",
      };
    const approve = await user.client
      .post("/api/ai/mcp/authorize")
      .set(originHeader)
      .send({
        ...Object.fromEntries(url.searchParams.entries()),
        approve: true,
      });
    if (approve.status === 200 && approve.body?.redirectTo) {
      const back = new URL(approve.body.redirectTo as string, REDIRECT_URI);
      return {
        code: back.searchParams.get("code"),
        error: back.searchParams.get("error") ?? "",
      };
    }
    return {
      code: null,
      error: `${codeOf(approve) ?? ""} http_${approve.status}`,
    };
  }
  return { code: null, error: `http_${res.status} ${res.text}` };
}

async function issueToken(user: Actor, clientId: string): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const auth = await authorize(user, clientId, challenge);
  expect(auth.code, `authorize before lock: ${auth.error}`).toBeTruthy();
  const meta = (await tenantAgent().get(METADATA_PATH)).body as Record<
    string,
    string
  >;
  const res = await tenantAgent()
    .post(pathOf(meta.token_endpoint!))
    .type("form")
    .send({
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      code: auth.code!,
      client_id: clientId,
      code_verifier: verifier,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.access_token as string;
}

// ---- Lifecycle -------------------------------------------------------------------

beforeAll(async () => {
  Object.assign(env, { AI_CHATGPT_ENABLED: true });
  setAiProviderNetworkForTests({
    fetch: fakeFetch,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  setChatGptCodexFetchForTests(fakeCodexFetch);

  const flags = await floorPool.query<{ modules: string[] }>(
    "SELECT feature_flags->'modules' AS modules FROM tenants WHERE id = $1",
    [tenantId],
  );
  originalModules = flags.rows[0]!.modules;
  expect(originalModules, "fixture tenant has Tanya AI").toContain(
    "ai_assistant",
  );

  admin = await newOwner("Admin kunci AI");
  drafter = await signedIn("Penulis draf kunci AI");
  await grantCustomRole(
    drafter.userId,
    ["ai.ask", "promo.manage", "accounting.expense.request"],
    { type: "tenant" },
  );

  // A second tenant that must never be affected by the first tenant's lock.
  const isolated = await createIsolatedTenant(
    `lock-${randomUUID().slice(0, 8)}`,
  );
  otherTenantId = isolated.tenantId;
  await floorPool.query(
    "UPDATE tenants t SET feature_flags=s.feature_flags,limits=s.limits,created_by=s.created_by FROM tenants s WHERE t.id=$1 AND s.id=$2",
    [otherTenantId, seededTenantId],
  );
  await withTenant(
    db,
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: otherTenantId,
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    ),
    (tx) => seedTenantRoleTemplates(tx, otherTenantId),
  );
  const client = agent(app);
  const email = await signUp(client, "Pemilik tenant lain");
  client.set("Host", isolated.hostname);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  created.users.push(userId);
  await verifySessionMfa(email);
  const c = await ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT set_config('app.tenant_id',$1,true),set_config('app.outlet_ids','*',true)",
      [otherTenantId],
    );
    await c.query(
      "INSERT INTO role_assignments (tenant_id,user_id,role_id,scope_type,scope_id,valid_from,assigned_by) SELECT $1,$2,id,'tenant',NULL,now()-interval '1 minute',$2 FROM roles WHERE tenant_id=$1 AND is_template AND template_key='owner'",
      [otherTenantId, userId],
    );
    await c.query("COMMIT");
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
  otherOwner = { client, email, userId };
}, 60_000);

beforeEach(async () => {
  await unlock();
  setAiProviderForTests(null);
  providerFetches = 0;
  codexFetches = 0;
  await resetGovernance(admin);
  await patchGovernance(admin, { monthlyBudgetIdr: BUDGET });
}, 30_000);

afterEach(async () => {
  await unlock();
});

afterAll(async () => {
  await unlock().catch(() => undefined);
  Object.assign(env, { AI_CHATGPT_ENABLED: enabledBefore });
  setChatGptCodexFetchForTests(null);
  setAiProviderNetworkForTests(null);
  setAiProviderForTests(undefined);
  await resetGovernance(admin).catch(() => undefined);
  await cleanupAcceptance().catch(() => undefined);
  await ownerPool.end();
});

// ---- (1) Every write route -------------------------------------------------------

describe("legend-nnufz (1) locked tenant: write routes refuse with AI_PLATFORM_DISABLED", () => {
  it("PATCH /api/ai/governance is refused and the stored settings stay", async () => {
    await lock();
    const res = await patchGovernance(admin, { monthlyBudgetIdr: 1_000 });
    expectLocked(res);
    const after = await getJson(admin, "/api/ai/governance");
    expect(after.monthlyBudgetIdr).toBe(BUDGET);
  });

  it("PUT /api/ai/provider is refused, the stored provider stays, no outgoing call", async () => {
    expect((await putProvider(admin)).status).toBe(200);
    const before = await getJson(admin, "/api/ai/provider");
    providerFetches = 0;
    await lock();
    expectLocked(await putProvider(admin, "other-model"));
    const after = await getJson(admin, "/api/ai/provider");
    expect(after.config).toEqual(before.config);
    expect(providerFetches).toBe(0);
  });

  it("PATCH /api/ai/provider is refused and the overrides stay", async () => {
    expect((await putProvider(admin)).status).toBe(200);
    const before = await getJson(admin, "/api/ai/provider");
    await lock();
    const res = await admin.client
      .patch("/api/ai/provider")
      .set(originHeader)
      .send({ capabilityOverrides: { contextWindow: 32_000 } });
    expectLocked(res);
    const after = await getJson(admin, "/api/ai/provider");
    expect(after.config).toEqual(before.config);
  });

  it("POST /api/ai/provider/test is refused and makes no outgoing call", async () => {
    expect((await putProvider(admin)).status).toBe(200);
    providerFetches = 0;
    await lock();
    const res = await admin.client
      .post("/api/ai/provider/test")
      .set(originHeader)
      .send({});
    expectLocked(res);
    expect(providerFetches).toBe(0);
  });

  it("POST /api/ai/chatgpt/device and /device/poll are refused, no ChatGPT call, no connection row", async () => {
    await lock();
    const start = await admin.client
      .post("/api/ai/chatgpt/device")
      .set(originHeader)
      .send({ riskAccepted: true });
    expectLocked(start);
    const poll = await admin.client
      .post("/api/ai/chatgpt/device/poll")
      .set(originHeader)
      .send({});
    expectLocked(poll);
    expect(codexFetches).toBe(0);
    expect(await chatgptRows()).toBe("0");
  });

  it("POST /api/ai/mcp-clients and /approve are refused; no client is added, a pending one stays pending", async () => {
    const pending = await registerClient();
    const listBefore = (await admin.client.get("/api/ai/mcp-clients")).body
      .data as { id: string; status: string }[];
    await lock();
    const create = await admin.client
      .post("/api/ai/mcp-clients")
      .set(originHeader)
      .send({
        name: "Klien terkunci",
        clientId: `lock-${randomUUID().slice(0, 12)}`,
        redirectUris: [REDIRECT_URI],
        allowedScopes: MCP_SCOPES,
      });
    expectLocked(create);
    const approve = await admin.client
      .post(`/api/ai/mcp-clients/${pending.id}/approve`)
      .set(originHeader)
      .send({});
    expectLocked(approve);
    const listAfter = (await admin.client.get("/api/ai/mcp-clients")).body
      .data as { id: string; status: string }[];
    expect(listAfter.length).toBe(listBefore.length);
    expect(listAfter.find((c) => c.id === pending.id)?.status).toBe("pending");
  });

  it("POST /api/ai/ask and POST /api/ai/conversations are refused", async () => {
    const provider = plainAnswer();
    setAiProviderForTests(provider);
    const listBefore = (await admin.client.get("/api/ai/conversations")).body
      .data as unknown[];
    await lock();
    expectLocked(await ask(admin));
    const conv = await admin.client
      .post("/api/ai/conversations")
      .set(originHeader)
      .send({ feature: "AI-02" });
    expectLocked(conv);
    const listAfter = (await admin.client.get("/api/ai/conversations")).body
      .data as unknown[];
    expect(listAfter.length).toBe(listBefore.length);
    expect(provider.requests).toHaveLength(0);
  });

  it("POST /api/ai/drafts/promo-copy and /expense-account are refused and never reach the provider", async () => {
    const provider = plainAnswer();
    setAiProviderForTests(provider);
    await lock();
    expectLocked(
      await drafter.client
        .post("/api/ai/drafts/promo-copy")
        .set(originHeader)
        .send({ kind: "banner", brief: "Promo kopi susu akhir pekan" }),
    );
    expectLocked(
      await drafter.client
        .post("/api/ai/drafts/expense-account")
        .set(originHeader)
        .send({ description: "Beli gas LPG dapur" }),
    );
    expect(provider.requests).toHaveLength(0);
  });
});

// ---- (2) Ask is blocked and nothing is spent --------------------------------------

describe("legend-nnufz (2) /ask under lock", () => {
  it("is refused at the route: no quota, no reservation, no charged event, no provider call", async () => {
    const provider = plainAnswer();
    setAiProviderForTests(provider);
    const dailyBefore = await dailyCount();
    const reservedBefore = await reservedTotal();
    const chargedBefore = await chargedEventRows();
    await lock();
    expectLocked(await ask(admin));
    expect(provider.requests).toHaveLength(0);
    expect(await dailyCount()).toBe(dailyBefore);
    expect(await reservedTotal()).toBe(reservedBefore);
    expect(await chargedEventRows()).toBe(chargedBefore);
  });
});

// ---- (3) Gateway --------------------------------------------------------------------

describe("legend-nnufz (3) aiComplete under lock", () => {
  it("throws AI_PLATFORM_DISABLED before any provider call and keeps the reserved cost", async () => {
    const provider = plainAnswer();
    setAiProviderForTests(provider);
    const reservedBefore = await reservedTotal();
    await lock();
    const error = await aiComplete(
      accessFor(admin.userId),
      {
        system: "Kamu asisten.",
        messages: [{ role: "user", content: [{ type: "text", text: "halo" }] }],
        tools: [],
        maxTokens: 100,
      },
      { feature: "AI-01", channel: "app" },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiError);
    expect((error as { code: string }).code).toBe(LOCKED);
    expect(provider.requests).toHaveLength(0);
    expect(await reservedTotal()).toBe(reservedBefore);
  });
});

// ---- (4) System call ---------------------------------------------------------------

describe("legend-nnufz (4) systemAiComplete under lock", () => {
  it("answers ok:false platform_locked and never calls the provider", async () => {
    const provider = plainAnswer();
    setAiProviderForTests(provider);
    await lock();
    const outcome = await systemAiComplete(
      accessFor(admin.userId),
      {
        system: "Ringkas hari ini.",
        messages: [{ role: "user", content: [{ type: "text", text: "data" }] }],
        tools: [],
        maxTokens: 100,
      },
      { feature: "AI-10", outletId: null },
    );
    expect(outcome).toEqual({ ok: false, reason: "platform_locked" });
    expect(provider.requests).toHaveLength(0);
  });
});

// ---- (5) MCP bearer and OAuth -------------------------------------------------------

describe("legend-nnufz (5) MCP under lock", () => {
  it("rejects a token exchange when the platform lock commits while its transaction is waiting", async () => {
    const client = await approvedClient();
    const user = await powerUser("Pengguna OAuth recheck");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const auth = await authorize(user, client.clientId, challenge);
    expect(auth.code, auth.error).toBeTruthy();
    const tokenCount = async () => {
      const result = await floorPool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM mcp_tokens WHERE tenant_id = $1 AND mcp_client_id = $2",
        [tenantId, client.id],
      );
      return result.rows[0]!.count;
    };
    const tokensBefore = await tokenCount();
    const meta = (await tenantAgent().get(METADATA_PATH)).body as Record<
      string,
      string
    >;
    const blocker = await floorPool.connect();
    let committed = false;
    try {
      await blocker.query("BEGIN");
      const pid = (
        await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid;
      await blocker.query(
        `UPDATE tenants SET feature_flags = jsonb_set(feature_flags, '{modules}', $2::jsonb) WHERE id = $1`,
        [
          tenantId,
          JSON.stringify(originalModules.filter((m) => m !== "ai_assistant")),
        ],
      );
      const exchange = () =>
        tenantAgent().post(pathOf(meta.token_endpoint!)).type("form").send({
          grant_type: "authorization_code",
          redirect_uri: REDIRECT_URI,
          code: auth.code!,
          client_id: client.clientId,
          code_verifier: verifier,
        });
      const response = exchange().then((value) => value);
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i += 1) {
        const result = await floorPool.query<{ waiting: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))) AS waiting",
          [pid],
        );
        waiting = result.rows[0]!.waiting;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(
        waiting,
        "OAuth transaction must wait for the uncommitted tenant lock",
      ).toBe(true);
      await blocker.query("COMMIT");
      committed = true;
      const denied = await response;
      expect(denied.status, denied.text).toBe(403);
      expect(denied.text).toContain(LOCKED);
      expect(await tokenCount()).toBe(tokensBefore);

      // A denied exchange must not burn the code or create a token.
      await unlock();
      const retry = await exchange();
      expect(retry.status, retry.text).toBe(200);
      expect(retry.body.access_token).toBeTruthy();
    } finally {
      if (!committed) await blocker.query("ROLLBACK");
      blocker.release();
    }
  }, 20_000);

  it("a bearer token issued before the lock is refused with 403 AI_PLATFORM_DISABLED", async () => {
    const client = await approvedClient();
    const user = await powerUser("Pengguna MCP kunci");
    const token = await issueToken(user, client.clientId);
    expect((await rpc(token, "tools/list")).status).toBe(200);
    await lock();
    const list = await rpc(token, "tools/list");
    expect(list.status, list.raw).toBe(403);
    expect(list.raw).toContain(LOCKED);
    const call = await rpc(token, "tools/call", {
      name: "get_sales_summary",
      arguments: {
        period: { from: "2026-10-01", to: "2026-10-07" },
        groupBy: "day",
      },
    });
    expect(call.status, call.raw).toBe(403);
    expect(call.raw).toContain(LOCKED);
  });

  it("OAuth authorize gives no code under lock", async () => {
    const client = await approvedClient();
    const user = await powerUser("Pengguna OAuth kunci");
    await lock();
    const challenge = createHash("sha256")
      .update(randomBytes(32).toString("base64url"))
      .digest("base64url");
    const auth = await authorize(user, client.clientId, challenge);
    expect(auth.code).toBeNull();
    expect(auth.error).toMatch(/access_denied|AI_PLATFORM_DISABLED|http_403/);
  });
});

// ---- (6) Reads stay open -------------------------------------------------------------

describe("legend-nnufz (6) reads under lock", () => {
  it("GET provider, governance and usage answer 200 with platformLocked true and untouched values", async () => {
    expect((await putProvider(admin)).status).toBe(200);
    const provider = await getJson(admin, "/api/ai/provider");
    const governance = await getJson(admin, "/api/ai/governance");
    const usage = await getJson(admin, "/api/ai/usage");
    expect(provider.platformLocked).toBe(false);
    expect(governance.platformLocked).toBe(false);
    expect(usage.platformLocked).toBe(false);

    await lock();
    const lockedProvider = await getJson(admin, "/api/ai/provider");
    const lockedGovernance = await getJson(admin, "/api/ai/governance");
    const lockedUsage = await getJson(admin, "/api/ai/usage");
    expect(lockedProvider.platformLocked).toBe(true);
    expect(lockedGovernance.platformLocked).toBe(true);
    expect(lockedUsage.platformLocked).toBe(true);
    expect(lockedProvider.config).toEqual(provider.config);
    expect(lockedGovernance.monthlyBudgetIdr).toBe(BUDGET);
    expect({ ...lockedGovernance, platformLocked: false }).toEqual(governance);
  });
});

// ---- (7) Removing access stays open -------------------------------------------------

describe("legend-nnufz (7) credential and access removal under lock", () => {
  it("DELETE /api/ai/provider still works and clears the provider", async () => {
    expect((await putProvider(admin)).status).toBe(200);
    await lock();
    const res = await admin.client.delete("/api/ai/provider").set(originHeader);
    expect(res.status, res.text).toBe(200);
    expect(res.body.data.config).toBeNull();
  });

  it("DELETE /api/ai/chatgpt is not refused by the lock", async () => {
    await lock();
    const res = await admin.client.delete("/api/ai/chatgpt").set(originHeader);
    expect(codeOf(res)).not.toBe(LOCKED);
    expect([200, 204, 404]).toContain(res.status);
  });

  it("revoking an MCP client and deleting a conversation still work", async () => {
    const client = await approvedClient();
    setAiProviderForTests(plainAnswer());
    const asked = await ask(admin);
    expect(asked.status, asked.text).toBe(200);
    const conversationId = asked.body.data.conversation.id as string;
    await lock();
    const revoke = await admin.client
      .post(`/api/ai/mcp-clients/${client.id}/revoke`)
      .set(originHeader)
      .send({ reason: "Uji kunci platform" });
    expect(revoke.status, revoke.text).toBe(200);
    expect(revoke.body.data.status).toBe("revoked");
    const del = await admin.client
      .delete(`/api/ai/conversations/${conversationId}`)
      .set(originHeader);
    expect([200, 204], del.text).toContain(del.status);
  });
});

// ---- (8) Recovery and isolation ------------------------------------------------------

describe("legend-nnufz (8) re-enabling the module and other tenants", () => {
  it("everything works again once the module is back on", async () => {
    setAiProviderForTests(plainAnswer());
    await lock();
    expectLocked(await ask(admin));
    expectLocked(await patchGovernance(admin, { monthlyBudgetIdr: 1_000 }));
    await unlock();
    const answered = await ask(admin);
    expect(answered.status, answered.text).toBe(200);
    const patched = await patchGovernance(admin, { monthlyBudgetIdr: BUDGET });
    expect(patched.status, patched.text).toBe(200);
    expect((await putProvider(admin)).status).toBe(200);
    const governance = await getJson(admin, "/api/ai/governance");
    expect(governance.platformLocked).toBe(false);
  });

  it("another tenant is not affected while this one is locked", async () => {
    setAiProviderForTests(plainAnswer());
    await lock();
    expectLocked(await ask(admin));
    const governance = await getJson(otherOwner, "/api/ai/governance");
    expect(governance.platformLocked).toBe(false);
    const patched = await otherOwner.client
      .patch("/api/ai/governance")
      .set(originHeader)
      .send({ monthlyBudgetIdr: BUDGET + 1 });
    expect(patched.status, patched.text).toBe(200);
    const answered = await ask(otherOwner);
    expect(answered.status, answered.text).toBe(200);
  });
});
