// legend-z83k review B (architect findings P2/P3): fail-first acceptance for
// credential gating on the approving owner, token revocation on reconnect and
// on lost races, and no double billing after a finished answer is discarded.
// Written from the brief + public HTTP contract; fixture transports only.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
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
import { env } from "../config/env.ts";
import { setChatGptCodexFetchForTests } from "../lib/ai/chatgpt-codex.ts";
import {
  setAiProviderForTests,
  setAiProviderNetworkForTests,
  setPlatformAiProviderForTests,
} from "../lib/ai/provider-factory.ts";
import { sealSecret } from "../lib/secrets.ts";
import {
  cleanupAcceptance,
  codeOf,
  created,
  newOwner,
  originHeader,
  ownerPool,
  plainAnswer,
  removeAssignments,
  resetGovernance,
  tenantId as tenantA,
  type Actor,
} from "./ai-acceptance-helpers.ts";

const originalFetch = globalThis.fetch;
const unmockedFetches: string[] = [];
const denyRealFetch = (async () => {
  unmockedFetches.push("Unexpected unmocked external request");
  throw new Error("External network is forbidden in review-B tests");
}) as typeof fetch;

const MODEL = "gpt-5-codex";
const DEVICE_SECRET = "device-auth-secret-reviewb-fixture";
const AUTH_CODE = "authorization-secret-reviewb-fixture";
const VERIFIER = "pkce-secret-reviewb-fixture";
const REFRESH_TOKEN = "refresh-secret-reviewb-fixture";
const CUSTOM_KEY = "sk-custom-fallback-reviewb-fixture";
const CUSTOM_URL = "https://tenant-fallback.example/v1";
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
    "signature-fixture",
  ].join(".");
let accessToken = jwt({ sub: "owner-fixture" });
let idToken = jwt({ sub: "id-fixture" });

type Call = {
  url: string;
  method: string;
  body: Record<string, unknown>;
};
let calls: Call[] = [];
let customCalls: Call[] = [];
let pendingPoll: (() => Promise<Response>) | null = null;
let tokenReply: (() => Response | Promise<Response>) | null = null;
let inferenceReply: (() => Response | Promise<Response>) | null = null;
let ownerA: Actor;
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
  return { url, method: init?.method ?? "GET", body };
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
  if (call.url === "https://auth.openai.com/oauth/revoke")
    return new Response(null, { status: 200 });
  if (call.url === "https://chatgpt.com/backend-api/codex/responses") {
    if (inferenceReply) return inferenceReply();
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
const status = (actor = ownerA) => actor.client.get("/api/ai/chatgpt");
const start = (actor = ownerA) =>
  actor.client
    .post("/api/ai/chatgpt/device")
    .set(originHeader)
    .send({ model: MODEL, riskAccepted: true });
const poll = (attemptId: string, actor = ownerA) =>
  actor.client
    .post("/api/ai/chatgpt/device/poll")
    .set(originHeader)
    .send({ attemptId });
const revoke = (actor = ownerA) =>
  actor.client.delete("/api/ai/chatgpt").set(originHeader);
const ask = (actor = ownerA) =>
  actor.client
    .post("/api/ai/ask")
    .set(originHeader)
    .send({ feature: "AI-02", question: `Pertanyaan ChatGPT ${randomUUID()}` });
const currentAttempt = async () =>
  (await rawConnection())!.attempt_id as string;
async function unlockPoll() {
  await inTenant(tenantA, (c) =>
    c.query(
      "UPDATE ai_chatgpt_connections SET next_poll_at = now() - interval '1 minute' WHERE tenant_id=$1",
      [tenantA],
    ),
  );
}
async function connect(actor = ownerA) {
  const begun = await start(actor);
  expect(begun.status, begun.text).toBe(200);
  const attemptId = await currentAttempt();
  await unlockPoll();
  const connected = await poll(attemptId, actor);
  expect(connected.status, connected.text).toBe(200);
  expect(connected.body.data.state).toBe("connected");
}
/** Seed a connected row whose risk approver is `approvedBy` (independent of the login flow). */
async function seedConnected(
  approvedBy: string,
  options: { expiresAt?: Date } = {},
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
      [id, tenantA, MODEL, randomUUID(), sealed, approvedBy],
    ),
  );
  return id;
}
async function expireStoredTokens() {
  const row = (await rawConnection())!;
  const cipher = sealSecret(
    JSON.stringify({
      accessToken,
      refreshToken: REFRESH_TOKEN,
      accountId: "acct-fixture",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    }),
    `ai_chatgpt:${tenantA}:${row.id}:tokens`,
  );
  await inTenant(tenantA, (c) =>
    c.query(
      "UPDATE ai_chatgpt_connections SET tokens_encrypted=$2 WHERE tenant_id=$1",
      [tenantA, cipher],
    ),
  );
}
const revokedTokens = () =>
  calls
    .filter((call) => call.url === "https://auth.openai.com/oauth/revoke")
    .map((call) => call.body.token);
const inferenceCalls = () =>
  calls.filter(
    (call) => call.url === "https://chatgpt.com/backend-api/codex/responses",
  );
async function saveCustomFallback() {
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
}

// audit_logs.event is jsonb (AuditEvent); the action name is event->>'action'.
// Forced disconnect writes ai_chatgpt.revoked, a saved refresh ai_chatgpt.refreshed.
const auditCount = async (action: string) =>
  Number(
    (
      await inTenant(tenantA, (c) =>
        c.query(
          "SELECT count(*) AS n FROM audit_logs WHERE tenant_id=$1 AND event->>'action'=$2",
          [tenantA, action],
        ),
      )
    ).rows[0].n,
  );

beforeAll(async () => {
  globalThis.fetch = denyRealFetch;
  ownerA = await newOwner("ChatGPT review-B owner A");
}, 60_000);
beforeEach(async () => {
  setEnabled(true);
  pendingPoll = null;
  tokenReply = null;
  inferenceReply = null;
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
  await inTenant(tenantA, async (c) => {
    for (const table of [
      "ai_chatgpt_connections",
      "ai_provider_configs",
      "ai_response_cache",
      "ai_conversations",
      "ai_usage_events",
      "ai_usage_daily",
      "ai_usage_monthly",
    ])
      await c.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantA]);
  });
  await resetGovernance(ownerA);
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
  await inTenant(tenantA, async (c) => {
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
      await c.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantA]);
  });
  await cleanupAcceptance();
  await ownerPool.query('DELETE FROM "user" WHERE id=ANY($1)', [created.users]);
  await ownerPool.end();
  globalThis.fetch = originalFetch;
  expect(unmockedFetches).toEqual([]);
});

describe("legend-z83k review B P2 approving owner must still hold the owner role", () => {
  it("legend-z83k review-B P2 stops using the account and revokes it once the approving owner loses the owner role", async () => {
    // A fresh owner per test: removing the role is permanent.
    const approver = await newOwner("ChatGPT review-B P2 approving owner");
    await seedConnected(approver.userId);
    await saveCustomFallback();
    // Positive control: the connection works while the approver is an owner.
    const before = await ask();
    expect(before.status, before.text).toBe(200);
    expect(inferenceCalls()).toHaveLength(1);
    const revokedAuditBefore = await auditCount("ai_chatgpt.revoked");

    await removeAssignments(approver.userId);
    const platform = plainAnswer("Must never be used");
    setPlatformAiProviderForTests(platform);
    const after = await ask();
    expect(after.status, after.text).toBe(503);
    expect(codeOf(after)).toBe("AI_PROVIDER_UNAVAILABLE");
    // The paid ChatGPT account was not used again, nor was a platform key.
    expect(inferenceCalls()).toHaveLength(1);
    expect(platform.requests).toHaveLength(0);
    // No fallback to the tenant API key either.
    expect(customCalls.filter((call) => call.method === "POST")).toHaveLength(
      0,
    );
    // The connection is invalidated: disconnected, tokens dropped and revoked.
    expect((await status()).body.data.state).toBe("disconnected");
    expect((await rawConnection())?.tokens_encrypted).toBeNull();
    expect(revokedTokens()).toContain(REFRESH_TOKEN);
    expect(await auditCount("ai_chatgpt.revoked")).toBeGreaterThan(
      revokedAuditBefore,
    );
  });
});

describe("legend-z83k review B P3 discarded tokens are revoked upstream", () => {
  it("legend-z83k review-B P3 revokes the previous refresh token when an owner reconnects", async () => {
    await connect();
    expect(revokedTokens()).toHaveLength(0);
    const second = jwt({ sub: "second-login" });
    tokenReply = () =>
      Response.json({
        access_token: second,
        id_token: idToken,
        refresh_token: "second-login-refresh-fixture",
        expires_in: 3600,
      });
    // Clear the start throttle so only the reconnect behavior is under test.
    await inTenant(tenantA, (c) =>
      c.query(
        "UPDATE ai_chatgpt_connections SET next_start_at = now() - interval '1 minute' WHERE tenant_id=$1",
        [tenantA],
      ),
    );
    const again = await start();
    expect(again.status, again.text).toBe(200);
    expect(revokedTokens()).toContain(REFRESH_TOKEN);
  });

  it("legend-z83k review-B P3 revokes tokens from a device poll that lost the race to a local revoke", async () => {
    expect((await start()).status).toBe(200);
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
    tokenReply = () =>
      Response.json({
        access_token: jwt({ sub: "race-winner" }),
        id_token: idToken,
        refresh_token: "poll-race-refresh-fixture",
        expires_in: 3600,
      });
    const polling = poll(await currentAttempt()).then((result) => result);
    await entered;
    try {
      expect((await revoke()).status).toBe(200);
    } finally {
      release();
      await polling.catch(() => undefined);
    }
    await polling;
    expect((await rawConnection())?.tokens_encrypted).toBeNull();
    expect(revokedTokens()).toContain("poll-race-refresh-fixture");
  });

  it("legend-z83k review-B P3 revokes a refreshed token pair that returns after a local revoke", async () => {
    await seedConnected(ownerA.userId, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    tokenReply = async () => {
      entered = true;
      await gate;
      return Response.json({
        access_token: jwt({ sub: "refresh-race" }),
        id_token: idToken,
        refresh_token: "refresh-race-rotated-fixture",
        expires_in: 3600,
      });
    };
    const asking = ask().then((result) => result);
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 5000 });
      expect((await revoke()).status).toBe(200);
    } finally {
      release();
      await asking.catch(() => undefined);
    }
    await asking;
    expect((await rawConnection())?.tokens_encrypted).toBeNull();
    expect(revokedTokens()).toContain("refresh-race-rotated-fixture");
  });
});

describe("legend-z83k review B P3 finished answer must not trigger a paid fallback", () => {
  it("legend-z83k review-B P3 keeps a finished answer without refreshing when the token expires while it streams", async () => {
    await seedConnected(ownerA.userId);
    await saveCustomFallback();
    const rotated = jwt({ sub: "refreshed-after-answer" });
    tokenReply = () =>
      Response.json({
        access_token: rotated,
        id_token: idToken,
        refresh_token: "refreshed-after-answer-fixture",
        expires_in: 3600,
      });
    inferenceReply = async () => {
      await expireStoredTokens();
      return completedSse();
    };
    const answered = await ask();
    expect(answered.status, answered.text).toBe(200);
    expect(answered.body.data.assistantMessage.content).toBe(
      "Jawaban paket ChatGPT.",
    );
    // Re-validating the finished answer only reads state; it never refreshes.
    expect(
      calls.filter(
        (call) => call.url === "https://auth.openai.com/oauth/token",
      ),
    ).toHaveLength(0);
    // And the answer was not discarded and re-bought through the API key.
    expect(customCalls.filter((call) => call.method === "POST")).toHaveLength(
      0,
    );
  }, 60_000);

  it("legend-z83k review-B P3 does not fall back to the tenant API key when the connection is removed while the answer streams", async () => {
    await seedConnected(ownerA.userId);
    await saveCustomFallback();
    inferenceReply = async () => {
      expect((await revoke()).status).toBe(200);
      return completedSse();
    };
    const answered = await ask();
    expect(answered.status, answered.text).toBe(503);
    expect(codeOf(answered)).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(customCalls.filter((call) => call.method === "POST")).toHaveLength(
      0,
    );
  }, 60_000);

  it("legend-z83k review-B P3 does not fall back to the tenant API key when the global switch is turned off right after the answer streams", async () => {
    await seedConnected(ownerA.userId);
    await saveCustomFallback();
    inferenceReply = async () => {
      // The reader cancels the stream once the answer is fully parsed, so
      // the switch flips after the stream finished and before re-validation.
      const body = await completedSse().text();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
          },
          cancel() {
            setEnabled(false);
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const answered = await ask();
    expect(answered.status, answered.text).toBe(503);
    expect(codeOf(answered)).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(customCalls.filter((call) => call.method === "POST")).toHaveLength(
      0,
    );
  }, 60_000);
});

describe("legend-80oot approving owner is re-checked when the refreshed tokens are saved", () => {
  it("legend-80oot rejects, disconnects and revokes a refresh when the approving owner loses the role while the refresh is in flight", async () => {
    const approver = await newOwner("ChatGPT legend-80oot removed owner");
    await seedConnected(approver.userId, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    await saveCustomFallback();
    const revokedAuditBefore = await auditCount("ai_chatgpt.revoked");
    const refreshedAuditBefore = await auditCount("ai_chatgpt.refreshed");
    const platform = plainAnswer("Must never be used");
    setPlatformAiProviderForTests(platform);
    const NEW_REFRESH = "refresh-after-owner-removed-fixture";
    let entered = false;
    tokenReply = async () => {
      entered = true;
      // Owner role is removed after the claim check, before the save.
      await removeAssignments(approver.userId);
      return Response.json({
        access_token: jwt({ sub: "refresh-owner-removed" }),
        id_token: idToken,
        refresh_token: NEW_REFRESH,
        expires_in: 3600,
      });
    };

    const answered = await ask();
    expect(entered).toBe(true);
    // The credentials are refused, with no fallback to a paid key.
    expect(answered.status, answered.text).toBe(503);
    expect(codeOf(answered)).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(inferenceCalls()).toHaveLength(0);
    expect(customCalls.filter((call) => call.method === "POST")).toHaveLength(
      0,
    );
    expect(platform.requests).toHaveLength(0);
    // The connection is disconnected and the new token pair was not saved.
    expect((await status()).body.data.state).toBe("disconnected");
    const row = await rawConnection();
    expect(row?.status).toBe("disconnected");
    expect(row?.tokens_encrypted).toBeNull();
    expect(await auditCount("ai_chatgpt.refreshed")).toBe(refreshedAuditBefore);
    expect(await auditCount("ai_chatgpt.revoked")).toBeGreaterThan(
      revokedAuditBefore,
    );
    // Both the freshly issued token and the old one are revoked upstream.
    expect(revokedTokens()).toContain(NEW_REFRESH);
    expect(revokedTokens()).toContain(REFRESH_TOKEN);
  }, 60_000);

  it("legend-80oot keeps saving the refresh when the approving owner still holds the role", async () => {
    const approver = await newOwner("ChatGPT legend-80oot kept owner");
    await seedConnected(approver.userId, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    const NEW_REFRESH = "refresh-owner-kept-fixture";
    tokenReply = () =>
      Response.json({
        access_token: jwt({ sub: "refresh-owner-kept" }),
        id_token: idToken,
        refresh_token: NEW_REFRESH,
        expires_in: 3600,
      });
    const answered = await ask();
    expect(answered.status, answered.text).toBe(200);
    expect(inferenceCalls()).toHaveLength(1);
    expect((await status()).body.data.state).toBe("connected");
    expect(revokedTokens()).toHaveLength(0);
  }, 60_000);
});
