// legend-rj284 K2 (docs/design/reseal-chatgpt-push.md section 7, T1-T8): the
// key-rotation re-seal of ChatGPT connection tokens must never lose a token an
// OpenAI call is about to save, must keep the row otherwise untouched, and must
// never disconnect anybody. Written from the design contract, not from the
// service code: `resealChatgptConnectionAny(tx, tenantId, active)` returns
// `Record<column, { resealed, failed, busy }>` for `tokens_encrypted` and
// `pending_encrypted`. Fixture transports only; no external network.
//
// Assumptions:
//   - Ring: key 2 active, version 1 is the legacy base key (same setup as
//     sealed-secret-reseal-job.test.ts). Old rows are sealed with
//     `sealSecretBaseKey`; AAD is `ai_chatgpt:<tenant>:<rowId>:<tokens|pending>`.
//   - The connection lock is `pg_advisory_xact_lock(hashtextextended(
//     'ai_chatgpt:<tenant>', 0))` (design section 2/4.3); T2/T5 use it to see a
//     waiter / to hold the lock. Waiting is observed in pg_locks, not by sleeping.
//   - A non-stale or empty column reports zeros (a missing key is read as zeros).
//   - T8 observes the credentialVersion fence through HTTP: a request whose
//     inference starts BEFORE the reseal and answers 401 AFTER it must not
//     invalidate (connection stays, tokens untouched); a request issued after
//     the reseal and answering 401 does invalidate (tokens dropped).
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

// Config reads the environment when it loads, before the imports below run.
vi.hoisted(() => {
  process.env.DATA_ENCRYPTION_KEYS = `2:${Buffer.alloc(32, 7).toString("base64")}`;
  process.env.DATA_ENCRYPTION_ACTIVE_KEY_VERSION = "2";
});

import { tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { env } from "../config/env.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setChatGptCodexFetchForTests } from "../lib/ai/chatgpt-codex.ts";
import {
  setAiProviderForTests,
  setAiProviderNetworkForTests,
  setPlatformAiProviderForTests,
} from "../lib/ai/provider-factory.ts";
import {
  currentSealVersion,
  openSecret,
  sealSecretBaseKey,
  sealedVersion,
} from "../lib/secrets.ts";
import {
  getChatgptCredentials,
  resealChatgptConnectionAny,
} from "../services/ai-chatgpt.service.ts";
import {
  cleanupAcceptance,
  created,
  newOwner,
  originHeader,
  ownerPool,
  resetGovernance,
  tenantId as tenantA,
  type Actor,
} from "./ai-acceptance-helpers.ts";

const originalFetch = globalThis.fetch;
const unmockedFetches: string[] = [];
const denyRealFetch = (async () => {
  unmockedFetches.push("Unexpected unmocked external request");
  throw new Error("External network is forbidden in reseal tests");
}) as typeof fetch;

const MODEL = "gpt-5-codex";
const DEVICE_SECRET = "device-auth-secret-reseal-fixture";
const AUTH_CODE = "authorization-secret-reseal-fixture";
const VERIFIER = "pkce-secret-reseal-fixture";
const REFRESH_TOKEN = "refresh-secret-reseal-fixture";
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

type Call = { url: string; method: string; body: Record<string, unknown> };
let calls: Call[] = [];
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

const contextOf = (tid: string = tenantA) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId: tid, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

type ColumnCounts = { resealed: number; failed: number; busy: number };
type ResealResult = Record<string, ColumnCounts>;
const ZERO: ColumnCounts = { resealed: 0, failed: 0, busy: 0 };
const counts = (result: ResealResult, column: string): ColumnCounts => ({
  ...ZERO,
  ...(result[column] ?? {}),
});
/** The job's call: one tenant inside its own tenant transaction, active key 2. */
const reseal = (tid: string = tenantA): Promise<ResealResult> =>
  withTenant(db, contextOf(tid), (tx) =>
    resealChatgptConnectionAny(
      tx,
      tenantIdSchema.parse(tid),
      currentSealVersion(),
    ),
  ) as Promise<ResealResult>;

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
/** Everything on the row except the two sealed columns. */
const withoutSealed = (row: Record<string, unknown>) => {
  const rest = { ...row };
  delete rest.tokens_encrypted;
  delete rest.pending_encrypted;
  return rest;
};
const auditTotal = async () =>
  Number(
    (
      await inTenant(tenantA, (c) =>
        c.query("SELECT count(*) AS n FROM audit_logs WHERE tenant_id=$1", [
          tenantA,
        ]),
      )
    ).rows[0].n,
  );

const status = () => ownerA.client.get("/api/ai/chatgpt");
const start = () =>
  ownerA.client
    .post("/api/ai/chatgpt/device")
    .set(originHeader)
    .send({ model: MODEL, riskAccepted: true });
const poll = (attemptId: string) =>
  ownerA.client
    .post("/api/ai/chatgpt/device/poll")
    .set(originHeader)
    .send({ attemptId });
const ask = () =>
  ownerA.client
    .post("/api/ai/ask")
    .set(originHeader)
    .send({ feature: "AI-02", question: `Pertanyaan ChatGPT ${randomUUID()}` });
const oauthTokenCalls = () =>
  calls.filter((call) => call.url === "https://auth.openai.com/oauth/token");
const revokeCalls = () =>
  calls.filter((call) => call.url === "https://auth.openai.com/oauth/revoke");

const tokensAad = (id: unknown) => `ai_chatgpt:${tenantA}:${String(id)}:tokens`;
const pendingAad = (id: unknown) =>
  `ai_chatgpt:${tenantA}:${String(id)}:pending`;

/**
 * A connected row whose tokens were sealed BEFORE the rotation (envelope
 * version 1, legacy base key). `aadKind` other than "tokens" builds a broken
 * envelope (wrong AAD) for T7.
 */
async function seedOldTokens(
  options: { expiresAt?: Date; aadKind?: string } = {},
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
  const plain = JSON.stringify(bundle);
  const sealed = sealSecretBaseKey(
    plain,
    `ai_chatgpt:${tenantA}:${id}:${options.aadKind ?? "tokens"}`,
  );
  expect(sealedVersion(sealed)).toBe(1);
  await inTenant(tenantA, (c) =>
    c.query(
      `INSERT INTO ai_chatgpt_connections (id,tenant_id,enabled,status,model,generation,attempt_id,tokens_encrypted,risk_accepted_by,risk_accepted_at,connected_at)
       VALUES ($1,$2,true,'connected',$3,1,$4,$5,$6,now(),now())`,
      [id, tenantA, MODEL, randomUUID(), sealed, ownerA.userId],
    ),
  );
  return { id, plain, sealed };
}
/** A device-code attempt in progress whose pending secret is sealed under version 1. */
async function seedOldPending() {
  const begun = await start();
  expect(begun.status, begun.text).toBe(200);
  const row = (await rawConnection())!;
  const aad = pendingAad(row.id);
  const plain = openSecret(row.pending_encrypted as string, aad);
  const sealed = sealSecretBaseKey(plain, aad);
  expect(sealedVersion(sealed)).toBe(1);
  await inTenant(tenantA, (c) =>
    c.query(
      "UPDATE ai_chatgpt_connections SET pending_encrypted=$2 WHERE tenant_id=$1",
      [tenantA, sealed],
    ),
  );
  return { id: row.id as string, plain, sealed };
}
async function unlockPoll() {
  await inTenant(tenantA, (c) =>
    c.query(
      "UPDATE ai_chatgpt_connections SET next_poll_at = now() - interval '1 minute' WHERE tenant_id=$1",
      [tenantA],
    ),
  );
}
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
/** Waiters on the tenant's connection advisory lock (design: 'ai_chatgpt:<tenant>'). */
async function lockWaiters(tid: string = tenantA) {
  const result = await ownerPool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
    [`ai_chatgpt:${tid}`],
  );
  return result.rows[0]!.n;
}
/**
 * Run the reseal in a transaction that stays open (lock held) until `release`.
 * `ready` resolves when the reseal finished but the transaction has not committed.
 */
function holdReseal() {
  const commit = gate();
  let ready!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const result = withTenant(db, contextOf(), async (tx) => {
    const done = await resealChatgptConnectionAny(
      tx,
      tenantIdSchema.parse(tenantA),
      currentSealVersion(),
    );
    ready();
    await commit.promise;
    return done as ResealResult;
  });
  return {
    ready: Promise.race([readyPromise, result]),
    result,
    release: commit.release,
  };
}

beforeAll(async () => {
  globalThis.fetch = denyRealFetch;
  ownerA = await newOwner("ChatGPT reseal owner");
  expect(currentSealVersion()).toBe(2);
}, 60_000);
beforeEach(async () => {
  setEnabled(true);
  pendingPoll = null;
  tokenReply = null;
  inferenceReply = null;
  calls = [];
  accessToken = jwt({ sub: "owner-fixture" });
  idToken = jwt({ sub: "id-fixture" });
  setAiProviderForTests(undefined);
  setPlatformAiProviderForTests(undefined);
  setChatGptCodexFetchForTests(fakeFetch);
  setAiProviderNetworkForTests({
    fetch: (async () => {
      throw new Error("No custom provider in reseal tests");
    }) as typeof fetch,
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

describe("legend-rj284 K2 ChatGPT re-seal never races an OpenAI call", () => {
  it("legend-rj284 T1 reports busy and leaves the row untouched while a refresh is in flight, then the refresh saves under the active key", async () => {
    await seedOldTokens({ expiresAt: new Date(Date.now() - 60_000) });
    const entered = gate();
    const release = gate();
    const rotatedAccess = jwt({ sub: "t1-rotated" });
    tokenReply = async () => {
      entered.release();
      await release.promise;
      return Response.json({
        access_token: rotatedAccess,
        id_token: idToken,
        refresh_token: "t1-rotated-refresh",
        expires_in: 3600,
      });
    };
    const asking = ask().then((result) => result);
    try {
      await entered.promise;
      const before = (await rawConnection())!;
      expect(typeof before.operation_id).toBe("string");
      const result = await reseal();
      expect(counts(result, "tokens_encrypted")).toEqual({
        resealed: 0,
        failed: 0,
        busy: 1,
      });
      expect(await rawConnection()).toEqual(before);
    } finally {
      release.release();
      await asking.catch(() => undefined);
    }
    const answered = await asking;
    expect(answered.status, answered.text).toBe(200);
    const after = (await rawConnection())!;
    expect(after.status).toBe("connected");
    expect(sealedVersion(after.tokens_encrypted as string)).toBe(2);
    const saved = JSON.parse(
      openSecret(after.tokens_encrypted as string, tokensAad(after.id)),
    ) as { accessToken: string; refreshToken: string };
    expect(saved.accessToken).toBe(rotatedAccess);
    expect(saved.refreshToken).toBe("t1-rotated-refresh");
    // The reseal never revoked or dropped anything.
    expect(revokeCalls()).toHaveLength(0);
    const credentials = await getChatgptCredentials(contextOf(), 1);
    expect(credentials).not.toBeNull();
    expect(credentials?.accessToken).toBe(rotatedAccess);
  }, 60_000);

  it("legend-rj284 T2 makes a refresh wait for a reseal that holds the lock, then the refresh reads the resealed row and saves", async () => {
    const seeded = await seedOldTokens({
      expiresAt: new Date(Date.now() - 60_000),
    });
    const rotatedAccess = jwt({ sub: "t2-rotated" });
    tokenReply = () =>
      Response.json({
        access_token: rotatedAccess,
        id_token: idToken,
        refresh_token: "t2-rotated-refresh",
        expires_in: 3600,
      });
    const holding = holdReseal();
    let refreshing: ReturnType<typeof getChatgptCredentials> | undefined;
    try {
      await holding.ready;
      refreshing = getChatgptCredentials(contextOf(), 1);
      // The refresh is queued behind the reseal's lock; OpenAI is not called yet.
      await vi.waitFor(async () => expect(await lockWaiters()).toBe(1), {
        timeout: 5000,
      });
      expect(oauthTokenCalls()).toHaveLength(0);
    } finally {
      holding.release();
      await Promise.allSettled([holding.result, refreshing ?? undefined]);
    }
    expect(counts(await holding.result, "tokens_encrypted")).toEqual({
      resealed: 1,
      failed: 0,
      busy: 0,
    });
    const credentials = await refreshing;
    expect(credentials?.accessToken).toBe(rotatedAccess);
    expect(oauthTokenCalls()).toHaveLength(1);
    const after = (await rawConnection())!;
    expect(after.status).toBe("connected");
    expect(after.tokens_encrypted).not.toBe(seeded.sealed);
    expect(sealedVersion(after.tokens_encrypted as string)).toBe(2);
    const saved = JSON.parse(
      openSecret(after.tokens_encrypted as string, tokensAad(after.id)),
    ) as { accessToken: string; refreshToken: string };
    // The refresh save won its compare-and-set against the resealed value.
    expect(saved.refreshToken).toBe("t2-rotated-refresh");
    expect(revokeCalls()).toHaveLength(0);
  }, 60_000);

  it("legend-rj284 T3 reports busy and leaves the row untouched while a device-code poll is in flight, then the poll connects", async () => {
    await seedOldPending();
    await unlockPoll();
    const entered = gate();
    const release = gate();
    pendingPoll = async () => {
      entered.release();
      await release.promise;
      return Response.json({
        authorization_code: AUTH_CODE,
        code_challenge: "challenge-fixture",
        code_verifier: VERIFIER,
      });
    };
    const attemptId = (await rawConnection())!.attempt_id as string;
    const polling = poll(attemptId).then((result) => result);
    try {
      await entered.promise;
      const before = (await rawConnection())!;
      expect(typeof before.operation_id).toBe("string");
      const result = await reseal();
      expect(counts(result, "pending_encrypted")).toEqual({
        resealed: 0,
        failed: 0,
        busy: 1,
      });
      expect(await rawConnection()).toEqual(before);
    } finally {
      release.release();
      await polling.catch(() => undefined);
    }
    const connected = await polling;
    expect(connected.status, connected.text).toBe(200);
    expect(connected.body.data.state).toBe("connected");
    const after = (await rawConnection())!;
    expect(after.status).toBe("connected");
    expect(after.pending_encrypted).toBeNull();
    expect(sealedVersion(after.tokens_encrypted as string)).toBe(2);
    expect(revokeCalls()).toHaveLength(0);
  }, 60_000);

  it("legend-rj284 T4 keeps a 10 minute margin after the lease: 1 minute past is busy, 11 minutes past is resealed", async () => {
    const seeded = await seedOldTokens();
    const operationId = randomUUID();
    const setLease = (minutesAgo: number) =>
      inTenant(tenantA, (c) =>
        c.query(
          "UPDATE ai_chatgpt_connections SET operation_id=$2, operation_lease_until = now() - make_interval(mins => $3::int) WHERE tenant_id=$1",
          [tenantA, operationId, minutesAgo],
        ),
      );
    await setLease(1);
    const beforeBusy = (await rawConnection())!;
    const busy = await reseal();
    expect(counts(busy, "tokens_encrypted")).toEqual({
      resealed: 0,
      failed: 0,
      busy: 1,
    });
    expect(await rawConnection()).toEqual(beforeBusy);
    expect(beforeBusy.tokens_encrypted).toBe(seeded.sealed);

    // A dead process: lease expired well past the margin must not block forever.
    await setLease(11);
    const beforeStuck = (await rawConnection())!;
    const done = await reseal();
    expect(counts(done, "tokens_encrypted")).toEqual({
      resealed: 1,
      failed: 0,
      busy: 0,
    });
    const after = (await rawConnection())!;
    expect(sealedVersion(after.tokens_encrypted as string)).toBe(2);
    expect(
      openSecret(after.tokens_encrypted as string, tokensAad(after.id)),
    ).toBe(seeded.plain);
    // The stuck operation marker and its lease are not ours to clear.
    expect(withoutSealed(after)).toEqual(withoutSealed(beforeStuck));
    expect(after.operation_id).toBe(operationId);
  });

  it("legend-rj284 T5 returns busy at once when another transaction holds the connection lock, and reseals after it lets go", async () => {
    const seeded = await seedOldTokens();
    const holder = await ownerPool.connect();
    let held = true;
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`ai_chatgpt:${tenantA}`],
      );
      const before = (await rawConnection())!;
      let timer: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        reseal(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("reseal waited on the connection lock")),
            10_000,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      expect(counts(result, "tokens_encrypted")).toEqual({
        resealed: 0,
        failed: 0,
        busy: 1,
      });
      expect(await rawConnection()).toEqual(before);
      await holder.query("COMMIT");
      held = false;
    } finally {
      if (held) await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    const done = await reseal();
    expect(counts(done, "tokens_encrypted")).toEqual({
      resealed: 1,
      failed: 0,
      busy: 0,
    });
    const after = (await rawConnection())!;
    expect(after.tokens_encrypted).not.toBe(seeded.sealed);
    expect(sealedVersion(after.tokens_encrypted as string)).toBe(2);
  }, 30_000);

  describe.each([
    {
      column: "tokens_encrypted",
      seed: async () => {
        const row = await seedOldTokens();
        return { ...row, aad: tokensAad(row.id) };
      },
    },
    {
      column: "pending_encrypted",
      seed: async () => {
        const row = await seedOldPending();
        return { ...row, aad: pendingAad(row.id) };
      },
    },
  ])("T6 $column", ({ column, seed }) => {
    it(`legend-rj284 T6 reseals ${column} once, changes nothing else, and a second run is a byte-identical no-op`, async () => {
      const seeded = await seed();
      const other =
        column === "tokens_encrypted"
          ? "pending_encrypted"
          : "tokens_encrypted";
      const rowBefore = (await rawConnection())!;
      const auditBefore = await auditTotal();

      const first = await reseal();
      expect(counts(first, column)).toEqual({
        resealed: 1,
        failed: 0,
        busy: 0,
      });
      expect(counts(first, other)).toEqual({ resealed: 0, failed: 0, busy: 0 });
      const afterFirst = (await rawConnection())!;
      expect(afterFirst[column]).not.toBe(seeded.sealed);
      expect(sealedVersion(afterFirst[column] as string)).toBe(2);
      expect(openSecret(afterFirst[column] as string, seeded.aad)).toBe(
        seeded.plain,
      );
      // updated_at, generation, operation_id, lease, status, polling: all unchanged.
      expect(withoutSealed(afterFirst)).toEqual(withoutSealed(rowBefore));
      expect(afterFirst[other]).toEqual(rowBefore[other]);
      expect(await auditTotal()).toBe(auditBefore);

      const second = await reseal();
      expect(counts(second, column)).toEqual({
        resealed: 0,
        failed: 0,
        busy: 0,
      });
      expect(counts(second, other)).toEqual({
        resealed: 0,
        failed: 0,
        busy: 0,
      });
      expect(await rawConnection()).toEqual(afterFirst);
      expect(await auditTotal()).toBe(auditBefore);
    });
  });

  it("legend-rj284 T7 counts an unreadable envelope as failed, leaves the row byte-identical and keeps the connection", async () => {
    await seedOldTokens({ aadKind: "wrong-aad" });
    const before = (await rawConnection())!;
    const auditBefore = await auditTotal();
    const result = await reseal();
    expect(counts(result, "tokens_encrypted")).toEqual({
      resealed: 0,
      failed: 1,
      busy: 0,
    });
    expect(await rawConnection()).toEqual(before);
    expect((await rawConnection())!.status).toBe("connected");
    expect(await auditTotal()).toBe(auditBefore);
    // The job never disconnects: the owner still sees a connected account.
    expect((await status()).body.data.state).toBe("connected");
    expect(revokeCalls()).toHaveLength(0);
  });

  it("legend-rj284 T8 ignores a 401 that carries a credential version from before the reseal, but a fresh request invalidates", async () => {
    const seeded = await seedOldTokens();
    const entered = gate();
    const release = gate();
    inferenceReply = async () => {
      entered.release();
      await release.promise;
      return Response.json(
        { error: { message: "Access rejected after the reseal" } },
        { status: 401 },
      );
    };
    const oldRequest = ask().then((result) => result);
    let afterReseal!: Record<string, unknown>;
    try {
      await entered.promise;
      const result = await reseal();
      expect(counts(result, "tokens_encrypted")).toEqual({
        resealed: 1,
        failed: 0,
        busy: 0,
      });
      afterReseal = (await rawConnection())!;
      expect(afterReseal.tokens_encrypted).not.toBe(seeded.sealed);
    } finally {
      release.release();
      await oldRequest.catch(() => undefined);
    }
    // The old request fails, but its stale version cannot invalidate the
    // resealed connection: tokens stay, the account stays connected.
    expect((await oldRequest).status).toBe(503);
    const stillThere = (await rawConnection())!;
    expect(stillThere.status).toBe("connected");
    expect(stillThere.tokens_encrypted).toBe(afterReseal.tokens_encrypted);
    expect(revokeCalls()).toHaveLength(0);

    // A request issued after the reseal carries the current version, so its 401
    // does invalidate (tokens dropped).
    inferenceReply = () =>
      Response.json(
        { error: { message: "Access rejected for the fresh request" } },
        { status: 401 },
      );
    const fresh = await ask();
    expect(fresh.status, fresh.text).toBe(503);
    expect((await rawConnection())?.tokens_encrypted).toBeNull();
  }, 60_000);
});
