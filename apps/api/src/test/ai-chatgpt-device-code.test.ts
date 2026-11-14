// legend-z83k (brief584): owner opt-in, encrypted device login, tenant isolation,
// kill switch and a separately budgeted custom fallback. All external I/O uses
// injected fixture transports; this suite never contacts OpenAI.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import type { PoolClient } from "pg";
import { requestSupportWriteAccessInputSchema } from "@starter/shared/platform";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app.ts";
import { env } from "../config/env.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setChatGptCodexFetchForTests } from "../lib/ai/chatgpt-codex.ts";
import {
  setAiProviderForTests,
  setAiProviderNetworkForTests,
  setPlatformAiProviderForTests,
} from "../lib/ai/provider-factory.ts";
import { createLogger, logger } from "../lib/logger.ts";
import { sealSecret } from "../lib/secrets.ts";
import { seedTenantRoleTemplates } from "../services/access.service.ts";
import { getChatgptCredentials } from "../services/ai-chatgpt.service.ts";
import { aiComplete, usageMonthOf } from "../services/ai-gateway.service.ts";
import type { AccessSnapshot } from "../services/permission-resolver.ts";
import {
  approveSupportAccessRequest,
  requestSupportWriteAccess,
  SUPPORT_ACCESS_WRITE_MAX_MINUTES,
} from "../services/platform-support.service.ts";
import {
  app,
  cleanupAcceptance,
  codeOf,
  created,
  grantCustomRole,
  newOwner,
  originHeader,
  ownerPool,
  patchGovernance,
  plainAnswer,
  resetGovernance,
  signedIn,
  tenantHost,
  tenantId as tenantA,
  type Actor,
} from "./ai-acceptance-helpers.ts";
import {
  createIsolatedTenant,
  owner as floorPool,
  seededTenantId,
} from "./floor-test-helpers.ts";
import { agent, setRole, signUp, verifySessionMfa } from "./helpers.ts";

const originalFetch = globalThis.fetch;
const unmockedFetches: string[] = [];
const denyRealFetch = (async () => {
  unmockedFetches.push("Unexpected unmocked external request");
  throw new Error("External network is forbidden in device-code tests");
}) as typeof fetch;

const MODEL = "gpt-5-codex";
const DEVICE_SECRET = "device-auth-secret-fixture-DO-NOT-LOG";
const AUTH_CODE = "authorization-secret-fixture-DO-NOT-LOG";
const VERIFIER = "pkce-secret-fixture-DO-NOT-LOG";
const REFRESH_TOKEN = "refresh-secret-fixture-DO-NOT-LOG";
const jwt = (extra: Record<string, unknown>) =>
  [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
      "base64url",
    ),
    Buffer.from(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-fixture" },
        ...extra,
      }),
    ).toString("base64url"),
    "signature-fixture-DO-NOT-LOG",
  ].join(".");
let accessToken = jwt({ sub: "owner-fixture" });
let idToken = jwt({ sub: "id-fixture" });
const CUSTOM_KEY = "sk-custom-fallback-fixture-DO-NOT-LOG";
const CUSTOM_URL = "https://tenant-fallback.example/v1";
const SECRETS = () => [
  DEVICE_SECRET,
  AUTH_CODE,
  VERIFIER,
  REFRESH_TOKEN,
  accessToken,
  idToken,
  CUSTOM_KEY,
];
type Call = {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
  init?: RequestInit;
};
let calls: Call[] = [];
let customCalls: Call[] = [];
let authorized = true;
let inferenceAuthFailed = false;
let inferenceReply: (() => Response | Promise<Response>) | null = null;
let revokeFails = false;
let pendingPoll: (() => Promise<Response>) | null = null;
let tokenReply: (() => Response | Promise<Response>) | null = null;
let ownerA: Actor;
let ownerB: Actor;
let nonOwner: Actor;
let tenantB: string;
const supportAdminIds: string[] = [];
const enabledBefore = (env as unknown as { AI_CHATGPT_ENABLED: boolean })
  .AI_CHATGPT_ENABLED;
const setEnabled = (enabled: boolean) =>
  Object.assign(env, { AI_CHATGPT_ENABLED: enabled });

function callOf(input: unknown, init?: RequestInit): Call {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;
  let body: Record<string, unknown> = {};
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      body = Object.fromEntries(new URLSearchParams(init.body));
    }
  }
  return {
    url,
    method: init?.method ?? "GET",
    headers: new Headers(init?.headers),
    body,
    init,
  };
}
const completedSse = (text = "Jawaban paket ChatGPT.") => {
  const item = {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return new Response(
    [
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_fixture", status: "completed", model: MODEL, output: [item], usage: { input_tokens: 15, output_tokens: 10, output_tokens_details: { reasoning_tokens: 4 } } } })}\n\n`,
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
};
const fakeFetch = (async (input: unknown, init?: RequestInit) => {
  const call = callOf(input, init);
  calls.push(call);
  if (call.url === "https://auth.openai.com/api/accounts/deviceauth/usercode")
    return Response.json({
      device_auth_id: DEVICE_SECRET,
      user_code: "ABCD-EFGH",
      interval: "5",
    });
  if (call.url === "https://auth.openai.com/api/accounts/deviceauth/token") {
    if (pendingPoll) return pendingPoll();
    if (!authorized) return new Response(null, { status: 403 });
    return Response.json({
      authorization_code: AUTH_CODE,
      code_challenge: "challenge-fixture",
      code_verifier: VERIFIER,
    });
  }
  if (call.url === "https://auth.openai.com/oauth/token") {
    if (tokenReply) return tokenReply();
    return Response.json({
      access_token: accessToken,
      id_token: idToken,
      refresh_token: REFRESH_TOKEN,
      expires_in: 3600,
      token_type: "Bearer",
    });
  }
  if (call.url === "https://auth.openai.com/oauth/revoke") {
    if (revokeFails) throw new Error(`upstream private ${REFRESH_TOKEN}`);
    return new Response(null, { status: 200 });
  }
  if (call.url === "https://chatgpt.com/backend-api/codex/responses") {
    if (inferenceReply) return inferenceReply();
    if (inferenceAuthFailed)
      return Response.json(
        { error: { message: `token revoked ${accessToken} ${REFRESH_TOKEN}` } },
        { status: 401 },
      );
    return completedSse();
  }
  throw new Error(`Unexpected fixture URL ${call.url}`);
}) as typeof fetch;
const customFetch = (async (input: unknown, init?: RequestInit) => {
  const call = callOf(input, init);
  customCalls.push(call);
  if (call.method === "GET")
    return Response.json({
      data: [{ id: "gpt-4o", object: "model", owned_by: "fixture" }],
    });
  return Response.json({
    model: "gpt-4o",
    choices: [
      {
        message: { role: "assistant", content: "Jawaban provider cadangan." },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 4 },
  });
}) as typeof fetch;

async function inTenant<T>(
  tid: string,
  run: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT set_config('app.tenant_id',$1,true),set_config('app.outlet_ids','*',true)",
      [tid],
    );
    const result = await run(c);
    await c.query("COMMIT");
    return result;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}
const currentAttempt = async (tid = tenantA) =>
  (await rawConnection(tid))!.attempt_id as string;
const status = (actor = ownerA) => actor.client.get("/api/ai/chatgpt");
const start = (
  actor = ownerA,
  body: Record<string, unknown> = { model: MODEL, riskAccepted: true },
) => actor.client.post("/api/ai/chatgpt/device").set(originHeader).send(body);
const poll = (attemptId: string, actor = ownerA) =>
  actor.client
    .post("/api/ai/chatgpt/device/poll")
    .set(originHeader)
    .send({ attemptId });
const revoke = (actor = ownerA) =>
  actor.client.delete("/api/ai/chatgpt").set(originHeader);
// A UUID can contain a phone-looking digit run, which the PII guard correctly
// blocks before inference. Encode digits bijectively while keeping questions unique.
const questionNonce = (nonce: string = randomUUID()) =>
  nonce.replace(/\d/g, (digit) => String.fromCharCode(103 + Number(digit)));
const ask = (actor = ownerA, nonce?: string) =>
  actor.client
    .post("/api/ai/ask")
    .set(originHeader)
    .send({
      feature: "AI-02",
      question: `Pertanyaan ChatGPT ${questionNonce(nonce)}`,
    });
async function unlockPoll(tid = tenantA) {
  await inTenant(tid, (c) =>
    c.query(
      "UPDATE ai_chatgpt_connections SET next_poll_at = now() - interval '1 minute' WHERE tenant_id=$1",
      [tid],
    ),
  );
}
async function connect(actor = ownerA, tid = tenantA) {
  const begun = await start(actor);
  expect(begun.status, begun.text).toBe(200);
  const attemptId = (await rawConnection(tid))!.attempt_id as string;
  expect(typeof attemptId).toBe("string");
  await unlockPoll(tid);
  const connected = await poll(attemptId, actor);
  expect(connected.status, connected.text).toBe(200);
  expect(connected.body.data.state).toBe("connected");
  return { begun, connected, attemptId };
}
// Seed authenticated provider state independently from the device endpoints so
// gateway red tests fail on provider selection/budget, not an unbuilt login flow.
async function seedConnected(
  options: { expiresAt?: Date; model?: string } = {},
) {
  const id = randomUUID();
  const bundle = {
    accessToken,
    refreshToken: REFRESH_TOKEN,
    accountId: "acct-fixture",
    expiresAt: (
      options.expiresAt ?? new Date(Date.now() + 3_600_000)
    ).toISOString(),
  };
  const sealed = sealSecret(
    JSON.stringify(bundle),
    `ai_chatgpt:${tenantA}:${id}:tokens`,
  );
  await inTenant(tenantA, (c) =>
    c.query(
      `INSERT INTO ai_chatgpt_connections (id,tenant_id,enabled,status,model,generation,attempt_id,tokens_encrypted,risk_accepted_by,risk_accepted_at,connected_at)
    VALUES ($1,$2,true,'connected',$3,1,$4,$5,$6,now(),now())`,
      [
        id,
        tenantA,
        options.model ?? MODEL,
        randomUUID(),
        sealed,
        ownerA.userId,
      ],
    ),
  );
  return id;
}

const contextA = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantA,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
async function replaceTokens(expiresAt: Date, token = accessToken) {
  const row = (await rawConnection())!;
  const bundle = {
    accessToken: token,
    refreshToken: REFRESH_TOKEN,
    accountId: "acct-fixture",
    expiresAt: expiresAt.toISOString(),
  };
  const cipher = sealSecret(
    JSON.stringify(bundle),
    `ai_chatgpt:${tenantA}:${row.id}:tokens`,
  );
  await inTenant(tenantA, (c) =>
    c.query(
      "UPDATE ai_chatgpt_connections SET tokens_encrypted=$2 WHERE tenant_id=$1",
      [tenantA, cipher],
    ),
  );
}

async function rawConnection(tid = tenantA) {
  return inTenant(
    tid,
    async (c) =>
      (
        await c.query<Record<string, unknown>>(
          "SELECT row_to_json(x) AS row FROM ai_chatgpt_connections x WHERE tenant_id=$1",
          [tid],
        )
      ).rows[0]?.row as Record<string, unknown> | undefined,
  );
}
function captureOutput() {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    for (const value of args) {
      try {
        lines.push(typeof value === "string" ? value : JSON.stringify(value));
      } catch {
        lines.push(String(value));
      }
    }
  };
  for (const level of [
    "trace",
    "debug",
    "info",
    "warn",
    "error",
    "fatal",
  ] as const)
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) =>
      capture(...args),
    );
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream) as (
      ...args: unknown[]
    ) => boolean;
    vi.spyOn(stream, "write").mockImplementation(((
      chunk: unknown,
      ...rest: unknown[]
    ) => {
      capture(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
      return original(chunk, ...rest);
    }) as typeof stream.write);
  }
  return lines;
}

beforeAll(async () => {
  globalThis.fetch = denyRealFetch;
  ownerA = await newOwner("ChatGPT owner A");
  nonOwner = await signedIn("ChatGPT custom admin");
  await grantCustomRole(nonOwner.userId, ["ai.governance.manage", "ai.ask"], {
    type: "tenant",
  });
  const isolated = await createIsolatedTenant(
    `chatgpt-${randomUUID().slice(0, 8)}`,
  );
  tenantB = isolated.tenantId;
  await floorPool.query(
    "UPDATE tenants t SET feature_flags=s.feature_flags,limits=s.limits,created_by=s.created_by FROM tenants s WHERE t.id=$1 AND s.id=$2",
    [tenantB, seededTenantId],
  );
  await withTenant(
    db,
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantB,
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    ),
    (tx) => seedTenantRoleTemplates(tx, tenantB),
  );
  const client = agent(app);
  const email = await signUp(client, "ChatGPT owner B");
  client.set("Host", isolated.hostname);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  created.users.push(userId);
  await verifySessionMfa(email);
  await inTenant(tenantB, (c) =>
    c.query(
      "INSERT INTO role_assignments (tenant_id,user_id,role_id,scope_type,scope_id,valid_from,assigned_by) SELECT $1,$2,id,'tenant',NULL,now()-interval '1 minute',$2 FROM roles WHERE tenant_id=$1 AND is_template AND template_key='owner'",
      [tenantB, userId],
    ),
  );
  ownerB = { client, email, userId };
}, 60_000);
beforeEach(async () => {
  setEnabled(true);
  authorized = true;
  inferenceAuthFailed = false;
  inferenceReply = null;
  revokeFails = false;
  pendingPoll = null;
  tokenReply = null;
  calls = [];
  customCalls = [];
  accessToken = jwt({ sub: "owner-fixture" });
  idToken = jwt({ sub: "id-fixture" });
  setAiProviderForTests(undefined);
  setPlatformAiProviderForTests(undefined);
  setChatGptCodexFetchForTests(fakeFetch);
  setAiProviderNetworkForTests({
    fetch: customFetch,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  for (const tid of [tenantA, tenantB])
    await inTenant(tid, async (c) => {
      for (const table of [
        "ai_chatgpt_connections",
        "ai_provider_configs",
        "ai_response_cache",
        "ai_conversations",
        "ai_usage_events",
        "ai_usage_daily",
        "ai_usage_monthly",
      ])
        await c.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tid]);
    });
  await resetGovernance(ownerA);
  await resetGovernance(ownerB);
}, 30_000);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(async () => {
  setEnabled(enabledBefore);
  setChatGptCodexFetchForTests(null);
  setAiProviderNetworkForTests(null);
  setAiProviderForTests(undefined);
  setPlatformAiProviderForTests(undefined);
  for (const tid of [tenantA, tenantB])
    await inTenant(tid, async (c) => {
      for (const table of [
        "ai_chatgpt_connections",
        "ai_provider_configs",
        "ai_response_cache",
        "ai_conversations",
        "ai_usage_events",
        "ai_usage_daily",
        "ai_usage_monthly",
        "ai_settings",
      ])
        await c.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tid]);
    });
  await inTenant(tenantB, (c) =>
    c.query(
      "DELETE FROM role_assignments WHERE tenant_id=$1 AND user_id=ANY($2)",
      [tenantB, created.users],
    ),
  );
  if (supportAdminIds.length) {
    await ownerPool.query(
      "WITH gone AS (DELETE FROM support_access_grants WHERE super_admin_user_id=ANY($1::text[])) DELETE FROM support_access_requests WHERE super_admin_user_id=ANY($1::text[])",
      [supportAdminIds],
    );
    await ownerPool.query(
      "DELETE FROM platform_admins WHERE user_id=ANY($1::text[])",
      [supportAdminIds],
    );
  }
  await cleanupAcceptance();
  await ownerPool.query('DELETE FROM "user" WHERE id=ANY($1)', [created.users]);
  await ownerPool.end();
  globalThis.fetch = originalFetch;
  expect(unmockedFetches).toEqual([]);
});

describe("legend-z83k B1 owner opt-in and consent", () => {
  it("legend-z83k B1 matches the eight-field UI state contract with model-free start and server-owned polling", async () => {
    const begun = await start(ownerA, { riskAccepted: true });
    expect(begun.status, begun.text).toBe(200);
    const keys = [
      "state",
      "platformDisabled",
      "viewerCanManage",
      "deviceCode",
      "verificationUrl",
      "expiresAt",
      "connectedAt",
      "riskAcceptedAt",
    ].sort();
    expect(Object.keys(begun.body.data).sort()).toEqual(keys);
    expect(begun.body.data).toMatchObject({
      state: "pending",
      platformDisabled: false,
      viewerCanManage: true,
      deviceCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
      connectedAt: null,
    });
    expect(begun.body.data).not.toHaveProperty("attemptId");
    const readonly = await status(nonOwner);
    expect(readonly.status, readonly.text).toBe(200);
    expect(Object.keys(readonly.body.data).sort()).toEqual(keys);
    expect(readonly.body.data).toMatchObject({
      state: "pending",
      viewerCanManage: false,
      deviceCode: null,
      verificationUrl: null,
    });
    await unlockPoll();
    const connected = await ownerA.client
      .post("/api/ai/chatgpt/device/poll")
      .set(originHeader)
      .send({});
    expect(connected.status, connected.text).toBe(200);
    expect(connected.body.data).toMatchObject({
      state: "connected",
      platformDisabled: false,
      viewerCanManage: true,
      deviceCode: null,
      verificationUrl: null,
    });
    expect(Object.keys(connected.body.data).sort()).toEqual(keys);
    const row = (await rawConnection())!;
    expect(row.risk_accepted_by).toBe(ownerA.userId);
    expect(typeof row.model).toBe("string");
  });

  it("legend-z83k B1 keeps a support-impersonated owner read-only even with an approved read-write grant", async () => {
    const client = agent(app);
    const email = await signUp(client, "ChatGPT support admin");
    await setRole(email, "admin");
    const signed = await client.get("/api/auth/get-session");
    const adminId = signed.body.user.id as string;
    created.users.push(adminId);
    supportAdminIds.push(adminId);
    await ownerPool.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [
      adminId,
    ]);
    const now = new Date();
    const requested = await requestSupportWriteAccess({
      tenantId: tenantA,
      actorUserId: adminId,
      request: requestSupportWriteAccessInputSchema.parse({
        reason: "Memeriksa sambungan AI tenant dengan persetujuan pemilik.",
        mfaCode: "123456",
        durationMinutes: SUPPORT_ACCESS_WRITE_MAX_MINUTES,
      }),
      mfaVerifiedAt: now.toISOString(),
      now,
    });
    const approved = await approveSupportAccessRequest(
      establishScopedTenantContext(
        establishTenantContext({
          tenantId: tenantA,
          brandId: null,
          source: "session",
        }),
        { kind: "tenant" },
      ),
      { userId: ownerA.userId },
      requested.id,
      now,
    );
    expect(approved.status).toBe("approved");
    client.set("Host", tenantHost);
    const impersonated = await client
      .post("/api/auth/admin/impersonate-user")
      .set(originHeader)
      .send({ userId: ownerA.userId });
    expect(impersonated.status, impersonated.text).toBe(200);
    await verifySessionMfa(ownerA.email);
    const session = await client.get("/api/auth/get-session");
    expect(session.body.user.id).toBe(ownerA.userId);
    expect(session.body.session.impersonatedBy).toBe(adminId);
    // Positive control: the same support session passes the existing provider
    // auth/origin/tenant/back-office/permission gates under read-write access.
    const controlled = await client.get("/api/ai/provider");
    expect(controlled.status, controlled.text).toBe(200);
    const support = { client, userId: ownerA.userId, email: ownerA.email };
    const readonly = await status(support);
    expect(readonly.status, readonly.text).toBe(200);
    expect(readonly.body.data).toMatchObject({
      viewerCanManage: false,
      deviceCode: null,
      verificationUrl: null,
    });
    for (const response of [
      await start(support),
      await poll(randomUUID(), support),
      await revoke(support),
    ])
      expect(response.status, response.text).toBe(403);
    expect(calls).toHaveLength(0);
    expect(await rawConnection()).toBeUndefined();
  }, 60_000);

  it("legend-z83k B1 starts disconnected, blocks global default-off, and makes no external call", async () => {
    const initial = await status();
    expect(initial.status, initial.text).toBe(200);
    expect(initial.body.data.state).toBe("disconnected");
    expect(initial.body.data).toMatchObject({
      platformDisabled: false,
      viewerCanManage: true,
    });
    expect(initial.body.data.riskAcceptedAt).toBeNull();
    setEnabled(false);
    const disabled = await start();
    expect(disabled.status, disabled.text).toBe(503);
    expect(codeOf(disabled)).toBe("AI_CHATGPT_DISABLED");
    expect(calls).toHaveLength(0);
    expect((await status()).body.data.platformDisabled).toBe(true);
  });
  it("legend-z83k B1 requires explicit risk consent and rejects submitted tenant or owner identity", async () => {
    for (const body of [
      { model: MODEL },
      { model: MODEL, riskAccepted: false },
      { model: MODEL, riskAccepted: true, tenantId: tenantB },
      { model: MODEL, riskAccepted: true, acceptedBy: ownerB.userId },
    ]) {
      const refused = await start(ownerA, body);
      expect(refused.status, refused.text).toBe(422);
    }
    expect(calls).toHaveLength(0);
    expect(await rawConnection()).toBeUndefined();
  });
  it("legend-z83k B1 blocks anonymous or foreign-origin access and keeps custom-role administrators read-only", async () => {
    const anonymous = await agent(app)
      .get("/api/ai/chatgpt")
      .set("Host", tenantHost);
    expect(anonymous.status).toBe(401);
    const foreign = await ownerA.client
      .post("/api/ai/chatgpt/device")
      .set("Origin", "https://evil.example")
      .send({ model: MODEL, riskAccepted: true });
    expect(foreign.status).toBe(403);
    const readonly = await status(nonOwner);
    expect(readonly.status, readonly.text).toBe(200);
    expect(readonly.body.data).toMatchObject({
      viewerCanManage: false,
      deviceCode: null,
      verificationUrl: null,
    });
    expect((await start(nonOwner)).status).toBe(403);
    expect((await poll(randomUUID(), nonOwner)).status).toBe(403);
    expect((await revoke(nonOwner)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it("legend-z83k B1 persists verified consent actor and time while exposing only user code and verification URL", async () => {
    const begun = await start();
    expect(begun.status, begun.text).toBe(200);
    expect(begun.body.data).toMatchObject({
      state: "pending",
      platformDisabled: false,
      viewerCanManage: true,
      deviceCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    expect(new Date(begun.body.data.expiresAt).getTime()).toBeGreaterThan(
      Date.now(),
    );
    const read = await status();
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({
      state: "pending",
      platformDisabled: false,
      viewerCanManage: true,
      deviceCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    expect(Number.isFinite(Date.parse(read.body.data.riskAcceptedAt))).toBe(
      true,
    );
    const consentRow = (await rawConnection())!;
    expect(consentRow.risk_accepted_by).toBe(ownerA.userId);
    expect(new Date(String(consentRow.risk_accepted_at)).getTime()).toBe(
      Date.parse(read.body.data.riskAcceptedAt),
    );
    for (const text of [
      begun.text,
      read.text,
      JSON.stringify(await rawConnection()),
    ])
      expect(text).not.toContain(DEVICE_SECRET);
  });
});

describe("legend-z83k B2 encrypted tokens and bounded polling", () => {
  it("legend-z83k B2 keeps token sentinels out of a non-silent emitted HTTP error log", async () => {
    await seedConnected();
    inferenceAuthFailed = true;
    const emitted: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, done) {
        emitted.push(String(chunk));
        done();
      },
    });
    const loggedClient = agent(
      createApp({ logger: createLogger({ level: "debug", destination }) }),
    );
    const email = await signUp(loggedClient, "ChatGPT logged owner");
    loggedClient.set("Host", tenantHost);
    const session = await loggedClient.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    created.users.push(userId);
    await verifySessionMfa(email);
    await inTenant(tenantA, (c) =>
      c.query(
        "INSERT INTO role_assignments (tenant_id,user_id,role_id,scope_type,scope_id,valid_from,assigned_by) SELECT $1,$2,id,'tenant',NULL,now()-interval '1 minute',$2 FROM roles WHERE tenant_id=$1 AND is_template AND template_key='owner'",
        [tenantA, userId],
      ),
    );
    emitted.length = 0;
    const failed = await ask({ client: loggedClient, userId, email });
    expect(failed.status, failed.text).toBe(503);
    expect(
      calls.some(
        (call) =>
          call.url === "https://chatgpt.com/backend-api/codex/responses",
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(emitted.join("\n")).toContain("/api/ai/ask"));
    for (const secret of SECRETS())
      expect(emitted.join("\n")).not.toContain(secret);
  });

  it("legend-z83k B2 encrypts pending and token bundles and never leaks secrets in response, audit or actual log output", async () => {
    const lines = captureOutput();
    const { begun, connected } = await connect();
    const row = (await rawConnection())!;
    expect(typeof row.tokens_encrypted).toBe("string");
    expect(row.pending_encrypted).toBeNull();
    const read = await status();
    const asked = await ask();
    expect(asked.status, asked.text).toBe(200);
    inferenceAuthFailed = true;
    await ask();
    revokeFails = true;
    const revoked = await revoke();
    expect(revoked.status, revoked.text).toBe(200);
    const audit = await inTenant(tenantA, (c) =>
      c.query<{ event: unknown }>(
        "SELECT event FROM audit_logs WHERE tenant_id=$1",
        [tenantA],
      ),
    );
    const exposed = [
      begun.text,
      connected.text,
      read.text,
      asked.text,
      revoked.text,
      JSON.stringify(row),
      JSON.stringify(audit.rows),
      ...lines,
    ].join("\n");
    for (const secret of SECRETS()) expect(exposed).not.toContain(secret);
  }, 60_000);
  it("legend-z83k B2 returns pending and atomically limits immediate repeated polls", async () => {
    authorized = false;
    const begun = await start();
    expect(begun.status, begun.text).toBe(200);
    await unlockPoll();
    const first = await poll(await currentAttempt());
    expect(first.status, first.text).toBe(200);
    expect(first.body.data.state).toBe("pending");
    const before = calls.length;
    const again = await poll(await currentAttempt());
    expect(again.status, again.text).toBe(429);
    expect(calls).toHaveLength(before);
  });
  it("legend-z83k B2 expires a pending attempt without polling OpenAI again", async () => {
    const begun = await start();
    expect(begun.status, begun.text).toBe(200);
    await inTenant(tenantA, (c) =>
      c.query(
        "UPDATE ai_chatgpt_connections SET expires_at=now()-interval '1 minute',next_poll_at=now()-interval '1 minute' WHERE tenant_id=$1",
        [tenantA],
      ),
    );
    const before = calls.length;
    const expired = await poll(await currentAttempt());
    expect(expired.status, expired.text).toBe(200);
    expect(expired.body.data.state).toBe("expired");
    expect(calls).toHaveLength(before);
  });
  it("legend-z83k B2 prevents another tenant from seeing or polling A and keeps A connected when B revokes", async () => {
    const { attemptId } = await connect();
    const other = await status(ownerB);
    expect(other.status, other.text).toBe(200);
    expect(other.body.data.state).toBe("disconnected");
    expect(other.body.data.riskAcceptedAt).toBeNull();
    const denied = await poll(attemptId, ownerB);
    expect(denied.status, denied.text).toBe(404);
    const removed = await revoke(ownerB);
    expect(removed.status, removed.text).toBe(200);
    expect((await status()).body.data.state).toBe("connected");
    expect((await rawConnection())?.tokens_encrypted).not.toBeNull();
  });
  it("legend-z83k B2 does not resurrect a revoked connection when an in-flight device poll finishes", async () => {
    const begun = await start();
    expect(begun.status, begun.text).toBe(200);
    await unlockPoll();
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    pendingPoll = async () => {
      arrived();
      await gate;
      return Response.json({
        authorization_code: AUTH_CODE,
        code_challenge: "challenge-fixture",
        code_verifier: VERIFIER,
      });
    };
    const polling = poll(await currentAttempt()).then((result) => result);
    await entered;
    try {
      expect((await revoke()).status).toBe(200);
    } finally {
      release();
      await polling.catch(() => undefined);
    }
    await polling;
    expect((await status()).body.data.state).toBe("disconnected");
    expect((await rawConnection())?.tokens_encrypted).toBeNull();
  });
});

describe("legend-z83k B3 kill switch, fallback and billing", () => {
  it("legend-z83k B3 keeps ChatGPT primary and the custom provider row as an independent fallback", async () => {
    const saved = await ownerA.client
      .put("/api/ai/provider")
      .set(originHeader)
      .send({
        connectionType: "api_key",
        baseUrl: CUSTOM_URL,
        defaultModel: "gpt-4o",
        apiKey: CUSTOM_KEY,
      });
    expect(saved.status, saved.text).toBe(200);
    await seedConnected();
    customCalls = [];
    const answered = await ask();
    expect(answered.status, answered.text).toBe(200);
    expect(answered.body.data.assistantMessage.content).toBe(
      "Jawaban paket ChatGPT.",
    );
    expect(customCalls).toHaveLength(0);
    const persisted = await inTenant(tenantA, (c) =>
      c.query<{ chatgpt: number; custom: number }>(
        "SELECT (SELECT count(*)::int FROM ai_chatgpt_connections WHERE tenant_id=$1 AND status='connected') AS chatgpt,(SELECT count(*)::int FROM ai_provider_configs WHERE tenant_id=$1) AS custom",
        [tenantA],
      ),
    );
    expect(persisted.rows[0]).toEqual({ chatgpt: 1, custom: 1 });
  });

  it("legend-z83k B3 kill switch invalidates an already cached ChatGPT answer", async () => {
    await seedConnected();
    const question = `Jawaban cache ChatGPT ${questionNonce()}`;
    const askSame = () =>
      ownerA.client
        .post("/api/ai/ask")
        .set(originHeader)
        .send({ feature: "AI-02", question });
    const first = await askSame();
    expect(first.status, first.text).toBe(200);
    expect(first.body.data.assistantMessage.content).toBe(
      "Jawaban paket ChatGPT.",
    );
    expect((await askSame()).status).toBe(200);
    const beforeKill = calls.length;
    setEnabled(false);
    const stopped = await askSame();
    expect(stopped.status, stopped.text).toBe(503);
    expect(codeOf(stopped)).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(calls).toHaveLength(beforeKill);
  });

  it("legend-z83k B3 preserves safe unknown-model defaults instead of promoting reasoning or tools", async () => {
    await seedConnected({ model: "tenant-codex-unknown" });
    const answered = await ask();
    expect(answered.status, answered.text).toBe(200);
    const inference = calls.find(
      (call) => call.url === "https://chatgpt.com/backend-api/codex/responses",
    );
    expect(inference).toBeDefined();
    expect(inference!.body).not.toHaveProperty("reasoning");
    expect(inference!.body.tools ?? []).toEqual([]);
  });

  it.each([
    ["zero budget", 0, 0, 0],
    ["fully spent budget", 100, 100, 0],
    ["fully reserved budget", 100, 0, 100],
  ] as const)(
    "legend-z83k B3 direct plan completion respects %s without relying on HTTP preflight",
    async (_label, budgetIdr, spent, reserved) => {
      await seedConnected();
      expect(
        (await patchGovernance(ownerA, { monthlyBudgetIdr: budgetIdr })).status,
      ).toBe(200);
      if (spent || reserved)
        await inTenant(tenantA, (c) =>
          c.query(
            "INSERT INTO ai_usage_monthly (tenant_id,usage_month,cost_idr,cost_micro_usd,reserved_cost_idr) VALUES ($1,$2,$3,0,$4)",
            [tenantA, usageMonthOf(new Date()), spent, reserved],
          ),
        );
      const access = {
        tenant: establishTenantContext({
          tenantId: tenantA,
          brandId: null,
          source: "session",
        }),
        userId: ownerA.userId,
        permissions: ["ai.ask"],
        templateKeys: ["owner"],
        mfaRequired: false,
        mfaVerified: true,
        allows: () => true,
        permissionsVia: () => ["ai.ask"],
        allowsVia: () => true,
        contextFor: () => null,
        stationsFor: () => [],
      } as unknown as AccessSnapshot;
      await expect(
        aiComplete(
          access,
          {
            system: "Kamu asisten.",
            messages: [
              { role: "user", content: [{ type: "text", text: "Halo" }] },
            ],
            tools: [],
            maxTokens: 512,
          },
          { feature: "AI-02", channel: "app" },
        ),
      ).rejects.toMatchObject({ code: "AI_BUDGET_EXCEEDED" });
      expect(calls).toHaveLength(0);
    },
  );

  it("legend-z83k B3 revokes locally even with global switch off and upstream revoke failure", async () => {
    await seedConnected();
    setEnabled(false);
    revokeFails = true;
    const removed = await revoke();
    expect(removed.status, removed.text).toBe(200);
    const row = (await rawConnection())!;
    expect(row.tokens_encrypted).toBeNull();
    expect(row.pending_encrypted).toBeNull();
    expect((await ask()).status).toBe(503);
  });
  it("legend-z83k B3 global kill blocks an existing connection immediately without using a platform key", async () => {
    await seedConnected();
    const platform = plainAnswer("Must never be used");
    setPlatformAiProviderForTests(platform);
    setEnabled(false);
    const before = calls.length;
    const unavailable = await ask();
    expect(unavailable.status, unavailable.text).toBe(503);
    expect(codeOf(unavailable)).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(calls).toHaveLength(before);
    expect(platform.requests).toHaveLength(0);
    expect((await status()).body.data).toMatchObject({
      platformDisabled: true,
      state: "connected",
      viewerCanManage: true,
      deviceCode: null,
      verificationUrl: null,
    });
  });
  it("legend-z83k B3 falls back to the tenant custom provider after explicit ChatGPT authentication failure", async () => {
    await seedConnected();
    const saved = await ownerA.client
      .put("/api/ai/provider")
      .set(originHeader)
      .send({
        connectionType: "api_key",
        baseUrl: CUSTOM_URL,
        defaultModel: "gpt-4o",
        apiKey: CUSTOM_KEY,
      });
    expect(saved.status, saved.text).toBe(200);
    customCalls = [];
    inferenceAuthFailed = true;
    const answered = await ask();
    expect(answered.status, answered.text).toBe(200);
    expect(answered.body.data.assistantMessage.content).toBe(
      "Jawaban provider cadangan.",
    );
    const completion = customCalls.find((call) => call.method === "POST");
    expect(completion?.url).toBe(`${CUSTOM_URL}/chat/completions`);
    expect(completion?.headers.get("authorization")).toBe(
      `Bearer ${CUSTOM_KEY}`,
    );
    const usage = await inTenant(tenantA, (c) =>
      c.query<{ billing_mode: string; cost_idr: string }>(
        "SELECT billing_mode,cost_idr FROM ai_usage_events WHERE tenant_id=$1 AND status='ok'",
        [tenantA],
      ),
    );
    expect(
      usage.rows.some(
        (row) => row.billing_mode === "api_metered" && Number(row.cost_idr) > 0,
      ),
    ).toBe(true);
  }, 60_000);
  it("legend-z83k B3 returns unavailable after token failure when no tenant custom fallback exists", async () => {
    await seedConnected();
    inferenceAuthFailed = true;
    const platform = plainAnswer("Must never be used");
    setPlatformAiProviderForTests(platform);
    const unavailable = await ask();
    expect(unavailable.status, unavailable.text).toBe(503);
    expect(codeOf(unavailable)).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(platform.requests).toHaveLength(0);
  });
  it("legend-z83k B3 keeps budget zero closed for both plan inference and paid fallback", async () => {
    await seedConnected();
    expect(
      (await patchGovernance(ownerA, { monthlyBudgetIdr: 0 })).status,
    ).toBe(200);
    const before = calls.length;
    const blocked = await ask();
    expect(blocked.status, blocked.text).toBe(402);
    expect(codeOf(blocked)).toBe("AI_BUDGET_EXCEEDED");
    expect(calls).toHaveLength(before);
    expect(customCalls.filter((call) => call.method === "POST")).toHaveLength(
      0,
    );
  });
  it("legend-z83k B3 records plan tokens separately from an additional API invoice estimate", async () => {
    await seedConnected();
    const answered = await ask();
    expect(answered.status, answered.text).toBe(200);
    expect(answered.body.data.assistantMessage.content).toBe(
      "Jawaban paket ChatGPT.",
    );
    const usage = await inTenant(tenantA, (c) =>
      c.query<{
        billing_mode: string;
        input_tokens: number;
        output_tokens: number;
        cost_micro_usd: string;
      }>(
        "SELECT billing_mode,input_tokens,output_tokens,cost_micro_usd FROM ai_usage_events WHERE tenant_id=$1 AND status='ok'",
        [tenantA],
      ),
    );
    expect(usage.rows.length).toBeGreaterThan(0);
    for (const row of usage.rows) {
      expect(row.billing_mode).toBe("chatgpt_plan");
      expect(row.input_tokens).toBe(15);
      expect(row.output_tokens).toBe(10);
      expect(Number(row.cost_micro_usd)).toBe(0);
    }
  });
});

describe("legend-z83k B4 leased operations and credential races", () => {
  it("legend-z83k B4 preserves an active refresh when its still-current access token fails in an older inference", async () => {
    const initialNow = new Date();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(initialNow);
    await seedConnected({
      expiresAt: new Date(initialNow.getTime() + 3_600_000),
    });
    let inferenceStarted = false;
    let refreshStarted = false;
    let releaseInference!: () => void;
    let releaseRefresh!: () => void;
    const inferenceGate = new Promise<void>((resolve) => {
      releaseInference = resolve;
    });
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    inferenceReply = async () => {
      inferenceStarted = true;
      await inferenceGate;
      return Response.json(
        { error: { message: "Old access rejected" } },
        { status: 401 },
      );
    };
    // Regression nonce: its raw prefix matches the PII phone-number pattern.
    const oldInference = ask(
      ownerA,
      "08123456-7890-4abc-8def-123456789abc",
    ).then((result) => result);
    let refreshing: ReturnType<typeof getChatgptCredentials> | undefined;
    let rotated = "";
    try {
      await vi.waitFor(() => expect(inferenceStarted).toBe(true), {
        timeout: 5000,
      });
      // Advance expiration without changing ciphertext: the inference snapshot
      // and the active refresh genuinely refer to the same credential version.
      vi.setSystemTime(new Date(initialNow.getTime() + 7_200_000));
      rotated = jwt({ sub: "active-refresh-winner" });
      tokenReply = async () => {
        refreshStarted = true;
        await refreshGate;
        return Response.json({
          access_token: rotated,
          refresh_token: "active-refresh-rotated",
          id_token: idToken,
          expires_in: 3600,
        });
      };
      refreshing = getChatgptCredentials(contextA(), 1);
      await vi.waitFor(() => expect(refreshStarted).toBe(true), {
        timeout: 5000,
      });
      const activeOperation = (await rawConnection())?.operation_id;
      expect(typeof activeOperation).toBe("string");
      releaseInference();
      expect((await oldInference).status).toBe(503);
      const active = (await rawConnection())!;
      expect(active.status).toBe("connected");
      expect(active.operation_id).toBe(activeOperation);
      expect(active.tokens_encrypted).not.toBeNull();
    } finally {
      releaseInference();
      releaseRefresh();
      await Promise.allSettled([
        oldInference,
        refreshing ?? Promise.resolve(null),
      ]);
      vi.useRealTimers();
    }
    expect((await refreshing)?.accessToken).toBe(rotated);
    expect((await rawConnection())?.status).toBe("connected");
  });

  it.each(["authorized", "auth_failed"] as const)(
    "legend-z83k B4 preserves a winning connection and its unchanged refresh token after an older %s refresh loses its lease",
    async (oldOutcome) => {
      await seedConnected({ expiresAt: new Date(Date.now() - 60_000) });
      let refreshes = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const winning = jwt({ sub: "winning-access-same-refresh" });
      const stale = jwt({ sub: "stale-access-same-refresh" });
      tokenReply = async () => {
        refreshes += 1;
        if (refreshes === 1) {
          await gate;
          if (oldOutcome === "auth_failed")
            return Response.json(
              {
                error: "invalid_grant",
                error_description: "Old refresh token rejected",
              },
              { status: 400 },
            );
          return Response.json({
            access_token: stale,
            refresh_token: REFRESH_TOKEN,
            id_token: idToken,
            expires_in: 3600,
          });
        }
        return Response.json({
          access_token: winning,
          refresh_token: REFRESH_TOKEN,
          id_token: idToken,
          expires_in: 3600,
        });
      };
      const old = getChatgptCredentials(contextA(), 1);
      try {
        await vi.waitFor(() => expect(refreshes).toBe(1), { timeout: 5000 });
        await inTenant(tenantA, (c) =>
          c.query(
            "UPDATE ai_chatgpt_connections SET operation_lease_until=now()-interval '1 minute',next_poll_at=now()-interval '1 minute' WHERE tenant_id=$1",
            [tenantA],
          ),
        );
        expect((await getChatgptCredentials(contextA(), 1))?.accessToken).toBe(
          winning,
        );
      } finally {
        release();
        await old.catch(() => undefined);
      }
      expect(await old).toBeNull();
      expect(
        calls.filter((call) => call.url.endsWith("/oauth/revoke")),
      ).toHaveLength(0);
      expect((await status()).body.data.state).toBe("connected");
      expect((await getChatgptCredentials(contextA(), 1))?.accessToken).toBe(
        winning,
      );
    },
  );

  it("legend-z83k B4 rejects a malformed encrypted token bundle without exposing its sentinel", async () => {
    const id = await seedConnected();
    const secret = "malformed-bundle-private-sentinel";
    const sealed = sealSecret(
      JSON.stringify({
        accessToken: secret,
        refreshToken: { private: secret },
        accountId: "acct-fixture",
        expiresAt: "not-a-date",
      }),
      `ai_chatgpt:${tenantA}:${id}:tokens`,
    );
    await inTenant(tenantA, (c) =>
      c.query(
        "UPDATE ai_chatgpt_connections SET tokens_encrypted=$2 WHERE tenant_id=$1",
        [tenantA, sealed],
      ),
    );
    const lines = captureOutput();
    const failed = await ask();
    expect(failed.status, failed.text).toBe(503);
    const read = await status();
    expect([failed.text, read.text, ...lines].join("\n")).not.toContain(secret);
    expect(
      calls,
      JSON.stringify(calls.map((call) => ({ url: call.url, body: call.body }))),
    ).toHaveLength(0);
  });

  it("legend-z83k B4 lets only one concurrent poll reach the device endpoint", async () => {
    const begun = await start();
    expect(begun.status, begun.text).toBe(200);
    await unlockPoll();
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    pendingPoll = async () => {
      entered = true;
      await gate;
      return new Response(null, { status: 403 });
    };
    const first = poll(await currentAttempt()).then((result) => result);
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 5000 });
      const second = await poll(await currentAttempt());
      expect(second.status, second.text).toBe(429);
      expect(
        calls.filter((call) => call.url.endsWith("/deviceauth/token")),
      ).toHaveLength(1);
    } finally {
      release();
      await first.catch(() => undefined);
    }
    expect((await first).status).toBe(200);
  });

  it("legend-z83k B4 serializes refresh and refuses to store tokens returned after local revoke", async () => {
    await seedConnected({ expiresAt: new Date(Date.now() - 60_000) });
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rotated = jwt({ sub: "new-access-after-refresh" });
    tokenReply = async () => {
      entered = true;
      await gate;
      return Response.json({
        access_token: rotated,
        refresh_token: "rotated-refresh-fixture",
        id_token: idToken,
        expires_in: 3600,
      });
    };
    const first = getChatgptCredentials(contextA(), 1);
    let second: ReturnType<typeof getChatgptCredentials> | undefined;
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 5000 });
      second = getChatgptCredentials(contextA(), 1).catch((error: unknown) => {
        expect(error).toMatchObject({ kind: "unavailable" });
        return null;
      });
      expect(await second).toBeNull();
      // The second DB lease claim returned while the first still owns I/O.
      await vi.waitFor(async () => {
        expect(
          calls.filter((call) => call.url.endsWith("/oauth/token")),
        ).toHaveLength(1);
        const row = await rawConnection();
        expect(row?.operation_id).not.toBeNull();
      });
      const removed = await revoke();
      expect(removed.status, removed.text).toBe(200);
    } finally {
      release();
      await Promise.allSettled([first, second ?? Promise.resolve(null)]);
    }
    const results = await Promise.all([first, second ?? Promise.resolve(null)]);
    expect(results.every((value) => value === null)).toBe(true);
    expect(
      calls.filter((call) => call.url.endsWith("/oauth/token")),
    ).toHaveLength(1);
    expect((await status()).body.data.state).toBe("disconnected");
    expect((await rawConnection())?.tokens_encrypted).toBeNull();
  });

  it.each(["access_and_refresh", "refresh_only"] as const)(
    "legend-z83k B4 keeps a freshly rotated %s connection when an older in-flight access token later fails",
    async (rotation) => {
      await seedConnected();
      let entered = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const rejectedAccess = accessToken;
      inferenceReply = async () => {
        entered = true;
        await gate;
        return Response.json(
          { error: { message: `invalid access ${rejectedAccess}` } },
          { status: 401 },
        );
      };
      const oldInference = ask().then((result) => result);
      const rotated = jwt({ sub: "rotated-while-old-request-ran" });
      const expectedAccess =
        rotation === "refresh_only" ? rejectedAccess : rotated;
      try {
        await vi.waitFor(() => expect(entered).toBe(true), { timeout: 5000 });
        await replaceTokens(new Date(Date.now() - 60_000), rejectedAccess);
        tokenReply = () =>
          Response.json({
            ...(rotation === "refresh_only" ? {} : { access_token: rotated }),
            refresh_token: "rotated-refresh-credential",
            id_token: idToken,
            expires_in: 3600,
          });
        const fresh = await getChatgptCredentials(contextA(), 1);
        expect(fresh?.accessToken).toBe(expectedAccess);
        expect(fresh?.refreshToken).toBe("rotated-refresh-credential");
      } finally {
        release();
        await oldInference.catch(() => undefined);
      }
      expect((await oldInference).status).toBe(503);
      expect((await status()).body.data.state).toBe("connected");
      const stillFresh = await getChatgptCredentials(contextA(), 1);
      expect(stillFresh?.accessToken).toBe(expectedAccess);
      expect(stillFresh?.refreshToken).toBe("rotated-refresh-credential");
    },
  );

  it("legend-z83k B4 does not clear a newer poll lease when an expired older operation fails", async () => {
    const begun = await start();
    expect(begun.status, begun.text).toBe(200);
    await unlockPoll();
    let started = 0;
    let releaseOld!: () => void;
    let releaseNew!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const newGate = new Promise<void>((resolve) => {
      releaseNew = resolve;
    });
    pendingPoll = async () => {
      started += 1;
      if (started === 1) {
        await oldGate;
        throw new Error("Old operation network failure");
      }
      await newGate;
      return new Response(null, { status: 403 });
    };
    const old = poll(await currentAttempt()).then((result) => result);
    let newer: ReturnType<typeof old.then> | undefined;
    try {
      await vi.waitFor(() => expect(started).toBe(1), { timeout: 5000 });
      await inTenant(tenantA, (c) =>
        c.query(
          "UPDATE ai_chatgpt_connections SET operation_lease_until=now()-interval '1 minute',next_poll_at=now()-interval '1 minute' WHERE tenant_id=$1",
          [tenantA],
        ),
      );
      newer = poll(await currentAttempt()).then((result) => result);
      await vi.waitFor(() => expect(started).toBe(2), { timeout: 5000 });
      const newOperation = (await rawConnection())?.operation_id;
      expect(typeof newOperation).toBe("string");
      releaseOld();
      await old;
      expect((await rawConnection())?.operation_id).toBe(newOperation);
    } finally {
      releaseOld();
      releaseNew();
      await Promise.allSettled([old, newer ?? Promise.resolve(null)]);
    }
    if (newer) await newer;
  });
});
