// WS-12 provider AI per tenant (bead legend-dwrr), DECISIONS.md butir 13.
// Written from the spec (docs/DECISIONS.md "WS-12 provider AI per tenant",
// butir 1-13), not from the implementation. Real Express app, Better Auth, RBAC
// and PostgreSQL; the provider network is replaced by the shared seam
// `setAiProviderNetworkForTests({ fetch, resolve })`, so no test touches the
// internet or real DNS.
//
// Assumptions where the spec is silent:
// - PUT/DELETE/GET answer 200 with `{ data: { config, fallbackAvailable } }`;
//   POST /test answers 200 with `{ data: { status, testedAt, errorCode } }`,
//   also when the probe itself failed (the failure is data, not an HTTP error).
// - Validation and business errors are HTTP 422 (like the rest of /api/ai);
//   codes read through `codeOf` (top-level `code` or `error.code`).
// - The probe and the tenant provider send `Authorization: Bearer <key>` and
//   JSON `{ model, ... }` to `<baseUrl>/chat/completions` (OpenAI-compatible).
// - A `TimeoutError` / `AbortError` rejected by fetch is what a timed-out probe
//   looks like (butir 9), so timeouts are simulated without waiting.
// - The audit row for save/delete mentions the provider (its snapshot holds
//   `baseUrl`); we look for the base URL host or the word "ai_provider".
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
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { env } from "../config/env.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  setAiProviderForTests,
  setPlatformAiProviderForTests,
  setAiProviderNetworkForTests,
} from "../lib/ai/provider-factory.ts";
import { logger } from "../lib/logger.ts";
import {
  currentSealVersion,
  openSecret,
  sealedVersion,
} from "../lib/secrets.ts";
import { costMicroUsd } from "../services/ai-pricing.ts";
import { rotateAiProviderKeys } from "../services/ai-provider-config.service.ts";
import { seedTenantRoleTemplates } from "../services/access.service.ts";
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
  tenantHost,
  tenantId as tenantA,
  type Actor,
} from "./ai-acceptance-helpers.ts";
import {
  createIsolatedTenant,
  owner as floorPool,
  seededTenantId,
} from "./floor-test-helpers.ts";
import { agent, signUp, verifySessionMfa } from "./helpers.ts";

// ---- Fixtures -----------------------------------------------------------------

const KEY_A = `sk-tenant-a-${randomUUID().replaceAll("-", "")}`;
const KEY_B = `sk-tenant-b-${randomUUID().replaceAll("-", "")}`;
const URL_A = "https://llm.tenant-a.example/v1";
const URL_B = "https://llm.tenant-b.example/v1";
const MODEL_A = "tenant-model-a";
const MODEL_B = "tenant-model-b";
const PUBLIC_IP = "93.184.216.34";

const configA = {
  connectionType: "api_key",
  baseUrl: URL_A,
  defaultModel: MODEL_A,
  apiKey: KEY_A,
};
const configB = {
  connectionType: "api_key",
  baseUrl: URL_B,
  defaultModel: MODEL_B,
  apiKey: KEY_B,
};

let tenantB: string;
let hostB: string;
let adminA: Actor;
let adminB: Actor;

// ---- Injected network -----------------------------------------------------------

type Call = {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | null;
  init: RequestInit | undefined;
};
let calls: Call[] = [];
// Completion calls keep the existing probe/gateway assertions focused; metadata
// discovery has its own captured transport and assertions below.
let metadataCalls: Call[] = [];
let dns: Record<string, string[]> = {};
type Responder = (call: Call) => Response | Promise<Response>;

// Like real OpenAI-compatible servers, the answer names the model it was asked for.
let requestedModel = "echo";
const chatOk = (content = "OK") =>
  Response.json({
    id: "chatcmpl-test",
    object: "chat.completion",
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  });

let responder: Responder = () => chatOk();
let metadataResponder: Responder = () => Response.json({ data: [] });

const fakeFetch = (async (input: unknown, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;
  const call: Call = {
    url,
    method: init?.method ?? "GET",
    headers: new Headers(init?.headers),
    body:
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null,
    init,
  };
  if (call.method === "GET" && call.url.endsWith("/models")) {
    metadataCalls.push(call);
    return metadataResponder(call);
  }
  calls.push(call);
  requestedModel = String(call.body?.model ?? "echo");
  return responder(call);
}) as typeof fetch;

const fakeResolve = async (host: string) =>
  (dns[host] ?? [PUBLIC_IP]).map((address) => ({
    address,
    family: address.includes(":") ? 6 : 4,
  }));

// ---- Request helpers ------------------------------------------------------------

const getCfg = (who: Actor) => who.client.get("/api/ai/provider");
const putCfg = (who: Actor, body: Record<string, unknown>) =>
  who.client.put("/api/ai/provider").set(originHeader).send(body);
const patchCfg = (who: Actor, body: Record<string, unknown>) =>
  who.client.patch("/api/ai/provider").set(originHeader).send(body);
const delCfg = (who: Actor) =>
  who.client.delete("/api/ai/provider").set(originHeader);
const testCfg = (who: Actor) =>
  who.client.post("/api/ai/provider/test").set(originHeader).send({});
// A fresh question each time: identical questions can be answered from the
// answer cache, which would hide which provider is being called.
const ask = (who: Actor, question = `Pertanyaan uji ${randomUUID()}`) =>
  who.client
    .post("/api/ai/ask")
    .set(originHeader)
    .send({ feature: "AI-02", question });

async function configOf(who: Actor) {
  const res = await getCfg(who);
  expect(res.status, res.text).toBe(200);
  return res.body.data.config as Record<string, unknown> | null;
}

async function inTenant<T>(
  tid: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tid],
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

type Row = {
  id: string;
  api_key_encrypted: string | null;
  api_key_key_version: number | null;
  api_key_last4: string | null;
  base_url: string;
};
async function rowOf(tid: string): Promise<Row | undefined> {
  return inTenant(tid, async (c) => {
    const res = await c.query<Row>(
      `SELECT id, api_key_encrypted, api_key_key_version, api_key_last4, base_url
         FROM ai_provider_configs WHERE tenant_id = $1`,
      [tid],
    );
    return res.rows[0];
  });
}

/** The 10 second pause between two tests of one config (AI_PROVIDER_TEST_TOO_SOON). */
async function backdateTest(tid: string) {
  await inTenant(tid, (c) =>
    c.query(
      "UPDATE ai_provider_configs SET last_tested_at = now() - interval '1 minute' WHERE tenant_id = $1 AND last_tested_at IS NOT NULL",
      [tid],
    ),
  );
}

/** Every usage row of the tenant (the table is wiped per test); order-free, since created_at follows the DB clock. */
async function usageRows(tid: string) {
  return inTenant(tid, async (c) => {
    const res = await c.query<{ provider: string; model: string }>(
      `SELECT provider, model FROM ai_usage_events WHERE tenant_id = $1`,
      [tid],
    );
    return res.rows;
  });
}

// ---- Second tenant + users ------------------------------------------------------

function contextFor(tid: string) {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId: tid, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

async function createTenantB() {
  const suffix = `aib${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const isolated = await createIsolatedTenant(suffix);
  await floorPool.query(
    `UPDATE tenants t SET feature_flags = s.feature_flags, limits = s.limits,
            created_by = s.created_by
       FROM tenants s WHERE t.id = $1 AND s.id = $2`,
    [isolated.tenantId, seededTenantId],
  );
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: isolated.tenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
  await withTenant(db, context, (tx) =>
    seedTenantRoleTemplates(tx, isolated.tenantId),
  );
  return isolated;
}

async function adminOnB(): Promise<Actor> {
  const client = agent(app);
  const email = await signUp(client, "Admin AI B");
  client.set("Host", hostB);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  created.users.push(userId);
  await verifySessionMfa(email);
  const roleId = randomUUID();
  await inTenant(tenantB, async (c) => {
    const tpl = await c.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND is_template AND template_key = 'owner'",
      [tenantB],
    );
    await c.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, 'AI B admin', false, $3, '["tenant"]')`,
      [roleId, tenantB, JSON.stringify(["ai.ask", "ai.governance.manage"])],
    );
    for (const id of [tpl.rows[0]?.id ?? "", roleId].filter(Boolean))
      await c.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
        [tenantB, userId, id],
      );
  });
  return { client, userId, email };
}

async function plainUserA(permissions: string[], name: string): Promise<Actor> {
  const client = agent(app);
  const email = await signUp(client, name);
  client.set("Host", tenantHost);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  created.users.push(userId);
  await verifySessionMfa(email);
  await grantCustomRole(userId, permissions, { type: "tenant" });
  return { client, userId, email };
}

// ---- Output capture (logger, console, stdio) -------------------------------------

function captureOutput() {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    for (const arg of args) {
      try {
        lines.push(
          typeof arg === "string"
            ? arg
            : Buffer.isBuffer(arg)
              ? arg.toString("utf8")
              : JSON.stringify(arg, Object.getOwnPropertyNames(arg ?? {})),
        );
      } catch {
        lines.push(String(arg));
      }
    }
  };
  const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
  const spyLevels = (target: Record<string, unknown>) => {
    for (const level of levels)
      if (typeof target[level] === "function")
        vi.spyOn(
          target as Record<string, (...a: unknown[]) => unknown>,
          level,
        ).mockImplementation((...args: unknown[]) => record(...args));
  };
  spyLevels(logger as unknown as Record<string, unknown>);
  const originalChild = logger.child.bind(logger);
  vi.spyOn(logger, "child").mockImplementation(((...args: unknown[]) => {
    record(...args);
    const child = (originalChild as (...a: unknown[]) => unknown)(...args);
    spyLevels(child as Record<string, unknown>);
    return child;
  }) as unknown as typeof logger.child);
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) =>
      record(...args),
    );
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream) as (...a: unknown[]) => boolean;
    vi.spyOn(stream, "write").mockImplementation(((
      chunk: unknown,
      ...rest: unknown[]
    ) => {
      record(chunk);
      return original(chunk, ...rest);
    }) as unknown as typeof stream.write);
  }
  return lines;
}

// ---- Lifecycle --------------------------------------------------------------------

async function wipe() {
  for (const tid of [tenantA, tenantB]) {
    await inTenant(tid, async (c) => {
      await c.query("DELETE FROM ai_provider_configs WHERE tenant_id = $1", [
        tid,
      ]);
      for (const table of [
        "ai_usage_events",
        "ai_usage_daily",
        "ai_usage_monthly",
      ])
        await c.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tid]);
    });
  }
}

beforeAll(async () => {
  const b = await createTenantB();
  tenantB = b.tenantId;
  hostB = b.hostname;
  adminA = await newOwner("Admin AI A");
  adminB = await adminOnB();
  setAiProviderNetworkForTests({ fetch: fakeFetch, resolve: fakeResolve });
}, 60_000);

beforeEach(async () => {
  calls = [];
  metadataCalls = [];
  dns = {};
  metadataResponder = () => Response.json({ data: [] });
  responder = () => chatOk();
  setAiProviderForTests(undefined);
  await wipe();
  await resetGovernance(adminA);
  await resetGovernance(adminB);
}, 30_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  setAiProviderForTests(undefined);
  setAiProviderNetworkForTests(null);
  await wipe().catch(() => undefined);
  await inTenant(tenantB, async (c) => {
    await c.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenantB, created.users],
    );
    await c.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND NOT is_template",
      [tenantB],
    );
  }).catch(() => undefined);
  await cleanupAcceptance().catch(() => undefined);
  await ownerPool
    .query('DELETE FROM "user" WHERE id = ANY($1)', [created.users])
    .catch(() => undefined);
  await ownerPool.end();
});

// ---- 13.1 key never leaks ------------------------------------------------------------

describe("13.1 the API key never leaves the server", () => {
  it("13.1 key is absent from GET, PUT, test, 422, Zod errors, audit, logs, usage and DB plaintext", async () => {
    const lines = captureOutput();
    const bodies: string[] = [];
    const keep = <T extends { text: string }>(res: T): T => {
      bodies.push(res.text);
      return res;
    };

    const saved = keep(await putCfg(adminA, configA));
    expect(saved.status, saved.text).toBe(200);

    const read = keep(await getCfg(adminA));
    expect(read.status).toBe(200);
    expect(read.body.data.config).toMatchObject({
      connectionType: "api_key",
      baseUrl: URL_A,
      defaultModel: MODEL_A,
      hasKey: true,
      keyLast4: KEY_A.slice(-4),
    });
    expect(Object.keys(read.body.data.config)).not.toContain("apiKey");

    // The provider echoes the key back in its error body: it must not surface.
    responder = () =>
      new Response(JSON.stringify({ error: `bad key ${KEY_A}` }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    const probed = keep(await testCfg(adminA));
    expect(probed.status, probed.text).toBe(200);
    expect(probed.body.data).toMatchObject({
      status: "failed",
      errorCode: "AUTH_FAILED",
    });

    // 422 from the URL guard, 422 from zod (key with a space is invalid).
    const blocked = keep(
      await putCfg(adminA, { ...configA, baseUrl: "https://127.0.0.1/v1" }),
    );
    expect(blocked.status).toBe(422);
    const badKey = keep(
      await putCfg(adminA, { ...configA, apiKey: `${KEY_A} dengan spasi` }),
    );
    expect(badKey.status).toBe(422);
    const extra = keep(
      await putCfg(adminA, { ...configA, tenantId: randomUUID() }),
    );
    expect(extra.status).toBe(422);

    // An answer through the tenant key, then removal.
    await resetGovernance(adminA);
    responder = () => chatOk("Jawaban tenant.");
    keep(await ask(adminA));
    keep(await delCfg(adminA));

    for (const text of bodies) expect(text).not.toContain(KEY_A);

    const audit = await inTenant(tenantA, async (c) => {
      const all = await c.query<{ t: string }>(
        "SELECT event::text AS t FROM audit_logs WHERE tenant_id = $1",
        [tenantA],
      );
      return all.rows.map((row) => row.t);
    });
    expect(
      audit.some(
        (t) => t.includes("llm.tenant-a.example") || /ai_provider/i.test(t),
      ),
      "save/delete are audited",
    ).toBe(true);
    for (const t of audit) expect(t).not.toContain(KEY_A);

    const usage = await inTenant(tenantA, (c) =>
      c.query<{ t: string }>(
        "SELECT row_to_json(u)::text AS t FROM ai_usage_events u WHERE tenant_id = $1",
        [tenantA],
      ),
    );
    for (const row of usage.rows) expect(row.t).not.toContain(KEY_A);

    expect(lines.join("\n")).not.toContain(KEY_A);
  }, 60_000);

  it("13.1 the stored value is ciphertext, with only the last 4 characters kept apart", async () => {
    await putCfg(adminA, configA);
    const row = await rowOf(tenantA);
    expect(row).toBeDefined();
    expect(row!.api_key_last4).toBe(KEY_A.slice(-4));
    expect(row!.api_key_encrypted).not.toBeNull();
    expect(row!.api_key_encrypted).not.toContain(KEY_A);
    expect(
      Buffer.from(row!.api_key_encrypted!, "base64").toString("latin1"),
    ).not.toContain(KEY_A);
  });
});

// ---- 13.2 isolation -------------------------------------------------------------------

describe("13.2 tenant isolation", () => {
  it("13.2 tenant A's config is invisible to B and never used for B's calls", async () => {
    expect((await putCfg(adminA, configA)).status).toBe(200);

    expect(await configOf(adminB)).toBeNull();
    const testB = await testCfg(adminB);
    expect(testB.status).toBe(404);
    expect(codeOf(testB)).toBe("AI_PROVIDER_NOT_CONFIGURED");
    const deleteB = await delCfg(adminB);
    expect(deleteB.status).toBe(404);
    expect(codeOf(deleteB)).toBe("AI_PROVIDER_NOT_CONFIGURED");
    // B's failed delete did not touch A.
    expect(await configOf(adminA)).toMatchObject({ baseUrl: URL_A });

    // B saves its own config; A still sees only its own.
    expect((await putCfg(adminB, configB)).status).toBe(200);
    expect(await configOf(adminA)).toMatchObject({
      baseUrl: URL_A,
      defaultModel: MODEL_A,
      keyLast4: KEY_A.slice(-4),
    });
    expect(await configOf(adminB)).toMatchObject({
      baseUrl: URL_B,
      defaultModel: MODEL_B,
      keyLast4: KEY_B.slice(-4),
    });

    // Each tenant's AI call goes to its own host with its own key and model.
    responder = () => chatOk("Jawaban.");
    expect((await ask(adminA)).status).toBe(200);
    expect((await ask(adminB)).status).toBe(200);
    const aCalls = calls.filter((call) => call.url.startsWith(URL_A));
    const bCalls = calls.filter((call) => call.url.startsWith(URL_B));
    expect(aCalls.length).toBeGreaterThan(0);
    expect(bCalls.length).toBeGreaterThan(0);
    expect(aCalls.length + bCalls.length).toBe(calls.length);
    for (const call of aCalls) {
      expect(call.headers.get("authorization")).toBe(`Bearer ${KEY_A}`);
      expect(call.body?.model).toBe(MODEL_A);
    }
    for (const call of bCalls) {
      expect(call.headers.get("authorization")).toBe(`Bearer ${KEY_B}`);
      expect(call.body?.model).toBe(MODEL_B);
    }
  }, 60_000);

  it("13.2 deleting A's config leaves B's in place", async () => {
    await putCfg(adminA, configA);
    await putCfg(adminB, configB);
    const removed = await delCfg(adminA);
    expect(removed.status).toBe(200);
    expect(removed.body.data.config).toBeNull();
    expect(await configOf(adminA)).toBeNull();
    expect(await configOf(adminB)).toMatchObject({ baseUrl: URL_B });
  });

  it("13.2 A's sealed key copied into B's row cannot be opened (AAD)", async () => {
    await putCfg(adminA, configA);
    await putCfg(adminB, configB);
    const rowA = (await rowOf(tenantA))!;
    const rowB = (await rowOf(tenantB))!;

    // Spec: AAD is `ai_provider_config:<tenantId>:<rowId>`.
    expect(
      openSecret(
        rowA.api_key_encrypted!,
        `ai_provider_config:${tenantA}:${rowA.id}`,
      ),
    ).toBe(KEY_A);
    expect(() =>
      openSecret(
        rowA.api_key_encrypted!,
        `ai_provider_config:${tenantB}:${rowB.id}`,
      ),
    ).toThrow();

    await inTenant(tenantB, (c) =>
      c.query(
        `UPDATE ai_provider_configs
            SET api_key_encrypted = $2, api_key_key_version = $3
          WHERE tenant_id = $1`,
        [tenantB, rowA.api_key_encrypted, rowA.api_key_key_version],
      ),
    );
    calls = [];
    const probed = await testCfg(adminB);
    expect(probed.status, probed.text).toBe(200);
    expect(probed.body.data).toMatchObject({
      status: "failed",
      errorCode: "KEY_UNREADABLE",
    });
    expect(calls, "no request leaves with an unreadable key").toHaveLength(0);

    // A misconfigured tenant is not silently served by the platform key
    // (butir 10.2): the call is unavailable, and nothing goes out, even while
    // a working platform provider exists.
    const platform = plainAnswer("Jawaban platform.");
    setPlatformAiProviderForTests(platform);
    try {
      const asked = await ask(adminB);
      expect(asked.status).toBe(503);
      expect(codeOf(asked)).toBe("AI_PROVIDER_UNAVAILABLE");
      expect(calls).toHaveLength(0);
      expect(platform.requests, "platform key never used").toHaveLength(0);
    } finally {
      setPlatformAiProviderForTests(undefined);
    }
  }, 60_000);
});

// ---- 13.3 permissions -----------------------------------------------------------------

describe("13.3 only ai.governance.manage may use the four routes", () => {
  it("13.3 a user with only ai.ask gets 403 on GET, PUT, DELETE and POST test", async () => {
    const asker = await plainUserA(["ai.ask"], "Penanya saja");
    expect((await putCfg(adminA, configA)).status).toBe(200);

    const results = [
      await getCfg(asker),
      await putCfg(asker, { ...configA, baseUrl: URL_B }),
      await delCfg(asker),
      await testCfg(asker),
    ];
    expect(results.map((res) => res.status)).toEqual([403, 403, 403, 403]);
    for (const res of results) expect(res.text).not.toContain(KEY_A);

    // Nothing changed behind the refusals.
    expect(await configOf(adminA)).toMatchObject({ baseUrl: URL_A });
    expect(calls).toHaveLength(0);
  });

  it("13.3 anonymous callers get 401 and a cookie mutation from a foreign origin gets 403", async () => {
    const anon = agent(app);
    anon.set("Host", tenantHost);
    expect((await anon.get("/api/ai/provider")).status).toBe(401);

    const foreign = await adminA.client
      .put("/api/ai/provider")
      .set("Origin", "https://evil.example")
      .send(configA);
    expect(foreign.status).toBe(403);
    expect(await configOf(adminA)).toBeNull();
  });
});

// ---- 13.4 URL guard -------------------------------------------------------------------

describe("13.4 the URL guard protects PUT and the connection test", () => {
  const blockedUrls: [string, string][] = [
    ["loopback IPv4", "https://127.0.0.1/v1"],
    ["private 10/8", "https://10.0.0.5/v1"],
    ["private 192.168/16", "https://192.168.1.10/v1"],
    ["link-local cloud metadata", "https://169.254.169.254/latest/meta-data"],
    ["loopback IPv6", "https://[::1]/v1"],
    ["plain http on a public host", "http://llm.public.example/v1"],
    ["localhost name", "https://localhost/v1"],
    ["name that resolves to a private IP", "https://sneaky.example/v1"],
  ];

  it.each(blockedUrls)(
    "13.4 PUT refuses %s with AI_PROVIDER_URL_BLOCKED and makes no request",
    async (_label, baseUrl) => {
      dns["sneaky.example"] = ["10.0.0.9"];
      const res = await putCfg(adminA, { ...configA, baseUrl });
      expect(res.status, res.text).toBe(422);
      expect(codeOf(res)).toBe("AI_PROVIDER_URL_BLOCKED");
      expect(res.text).not.toContain(KEY_A);
      expect(calls).toHaveLength(0);
      expect(await configOf(adminA)).toBeNull();
    },
  );

  it("13.4 the test route re-checks a saved name that now resolves to a private IP", async () => {
    expect((await putCfg(adminA, configA)).status).toBe(200);
    dns["llm.tenant-a.example"] = ["10.0.0.9"];
    const probed = await testCfg(adminA);
    expect(probed.status, probed.text).toBe(200);
    expect(probed.body.data).toMatchObject({
      status: "failed",
      errorCode: "URL_BLOCKED",
    });
    expect(calls, "blocked before any fetch").toHaveLength(0);
    expect(await configOf(adminA)).toMatchObject({
      lastTest: { status: "failed", errorCode: "URL_BLOCKED" },
    });
  });

  it("13.4 the test route refuses a stored internal URL (row written behind PUT)", async () => {
    expect((await putCfg(adminA, configA)).status).toBe(200);
    await inTenant(tenantA, (c) =>
      c.query(
        "UPDATE ai_provider_configs SET base_url = 'https://169.254.169.254/v1' WHERE tenant_id = $1",
        [tenantA],
      ),
    );
    const probed = await testCfg(adminA);
    expect(probed.body.data).toMatchObject({
      status: "failed",
      errorCode: "URL_BLOCKED",
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["explicit port 8443", "https://llm.tenant-a.example:8443/v1"],
    ["port 80", "https://llm.tenant-a.example:80/v1"],
    ["public IP on port 8443", `https://${PUBLIC_IP}:8443/v1`],
  ])(
    "13.4 PUT refuses %s with AI_PROVIDER_URL_BLOCKED",
    async (_label, baseUrl) => {
      const res = await putCfg(adminA, { ...configA, baseUrl });
      expect(res.status, res.text).toBe(422);
      expect(codeOf(res)).toBe("AI_PROVIDER_URL_BLOCKED");
      expect(calls).toHaveLength(0);
      expect(await configOf(adminA)).toBeNull();
    },
  );

  it("13.4 PUT accepts an explicit :443", async () => {
    const res = await putCfg(adminA, {
      ...configA,
      baseUrl: "https://llm.tenant-a.example:443/v1",
    });
    expect(res.status, res.text).toBe(200);
  });

  it("13.4 the client message is the same for a private-resolving and an unknown name", async () => {
    dns["private.example"] = ["10.0.0.9"];
    dns["unknown.example"] = [];
    const messages: string[] = [];
    for (const host of ["private.example", "unknown.example"]) {
      const res = await putCfg(adminA, {
        ...configA,
        baseUrl: `https://${host}/v1`,
      });
      expect(codeOf(res)).toBe("AI_PROVIDER_URL_BLOCKED");
      expect(res.text).not.toMatch(/not found|private|resolve/i);
      messages.push(String(res.body.error?.message));
    }
    expect(messages[0]).toBe(messages[1]);
  });

  it("13.4 a stored URL with a non-443 port is refused by the test route and never called", async () => {
    expect((await putCfg(adminA, configA)).status).toBe(200);
    await inTenant(tenantA, (c) =>
      c.query(
        "UPDATE ai_provider_configs SET base_url = 'https://llm.tenant-a.example:8443/v1' WHERE tenant_id = $1",
        [tenantA],
      ),
    );
    const probed = await testCfg(adminA);
    expect(probed.body.data).toMatchObject({
      status: "failed",
      errorCode: "URL_BLOCKED",
    });
    expect(calls).toHaveLength(0);
  });

  it("13.4 a 302 answer is REDIRECT_REFUSED and the target is never fetched", async () => {
    expect((await putCfg(adminA, configA)).status).toBe(200);
    responder = () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data" },
      });
    const probed = await testCfg(adminA);
    expect(probed.status, probed.text).toBe(200);
    expect(probed.body.data).toMatchObject({
      status: "failed",
      errorCode: "REDIRECT_REFUSED",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${URL_A}/chat/completions`);
    expect(calls[0]!.init?.redirect).toBe("manual");
    expect(calls.some((call) => call.url.includes("169.254.169.254"))).toBe(
      false,
    );
  });
});

// ---- 13.5 connection test outcomes -------------------------------------------------------

describe("13.5 connection test", () => {
  it("13.5 success sends one chat completion with the stored model and key and records ok", async () => {
    await putCfg(adminA, configA);
    const probed = await testCfg(adminA);
    expect(probed.status, probed.text).toBe(200);
    expect(probed.body.data).toMatchObject({ status: "ok", errorCode: null });
    expect(typeof probed.body.data.testedAt).toBe("string");

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${URL_A}/chat/completions`);
    expect(call.headers.get("authorization")).toBe(`Bearer ${KEY_A}`);
    expect(call.body?.model).toBe(MODEL_A);
    expect(await configOf(adminA)).toMatchObject({
      lastTest: { status: "ok", errorCode: null },
    });
  });

  it("13.5 a provider timeout is TIMEOUT", async () => {
    await putCfg(adminA, configA);
    responder = () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    const probed = await testCfg(adminA);
    expect(probed.status, probed.text).toBe(200);
    expect(probed.body.data).toMatchObject({
      status: "failed",
      errorCode: "TIMEOUT",
    });
  });

  it("13.5 provider answers map to fixed codes and never expose provider text", async () => {
    await putCfg(adminA, configA);
    const secretText = `provider-internal-detail-${randomUUID()}`;
    const cases: [string, Responder, string][] = [
      ["401", () => new Response(secretText, { status: 401 }), "AUTH_FAILED"],
      ["404", () => new Response(secretText, { status: 404 }), "NOT_FOUND"],
      [
        "422",
        () => new Response(secretText, { status: 422 }),
        "REQUEST_REJECTED",
      ],
      ["429", () => new Response(secretText, { status: 429 }), "RATE_LIMITED"],
      [
        "500",
        () => new Response(secretText, { status: 500 }),
        "PROVIDER_ERROR",
      ],
      [
        "200 without choices",
        () => Response.json({ hello: "world" }),
        "BAD_RESPONSE",
      ],
      [
        "network failure",
        () => {
          throw new Error(secretText);
        },
        "NETWORK_ERROR",
      ],
    ];
    for (const [label, answer, code] of cases) {
      await backdateTest(tenantA);
      responder = answer;
      const probed = await testCfg(adminA);
      expect(probed.status, `${label}: ${probed.text}`).toBe(200);
      expect(probed.body.data, label).toMatchObject({
        status: "failed",
        errorCode: code,
      });
      expect(probed.text, label).not.toContain(secretText);
      expect((await getCfg(adminA)).text, label).not.toContain(secretText);
    }
  }, 60_000);

  it("13.5 a second test within 10 seconds is refused with AI_PROVIDER_TEST_TOO_SOON", async () => {
    await putCfg(adminA, configA);
    expect((await testCfg(adminA)).status).toBe(200);
    const sent = calls.length;
    const again = await testCfg(adminA);
    expect(again.status).toBe(429);
    expect(codeOf(again)).toBe("AI_PROVIDER_TEST_TOO_SOON");
    expect(calls).toHaveLength(sent);
  });

  it("13.5 two concurrent tests: only one reaches the provider, the other is 429", async () => {
    await putCfg(adminA, configA);
    await backdateTest(tenantA);
    const sent = calls.length;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    responder = async () => {
      await gate;
      return chatOk();
    };
    const first = testCfg(adminA).then((res) => res);
    const second = testCfg(adminA).then((res) => res);
    // The loser answers at once; the winner waits on the gate.
    const loser = await Promise.race([first, second]);
    expect(loser.status).toBe(429);
    expect(codeOf(loser)).toBe("AI_PROVIDER_TEST_TOO_SOON");
    release();
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status].sort()).toEqual([200, 429]);
    expect(calls.length - sent).toBe(1);
  });
});

// ---- 13.6 save rules ----------------------------------------------------------------------

describe("13.6 save rules (PUT)", () => {
  it("13.6 a new config without apiKey is AI_PROVIDER_KEY_REQUIRED", async () => {
    const withoutKey: Partial<typeof configA> = { ...configA };
    delete withoutKey.apiKey;
    const res = await putCfg(adminA, withoutKey);
    expect(res.status, res.text).toBe(422);
    expect(codeOf(res)).toBe("AI_PROVIDER_KEY_REQUIRED");
    expect(await configOf(adminA)).toBeNull();
  });

  it("13.6 changing baseUrl without a new apiKey is AI_PROVIDER_KEY_REQUIRED; the old key is never sent to the new host", async () => {
    await putCfg(adminA, configA);
    const withoutKey: Partial<typeof configA> = { ...configA };
    delete withoutKey.apiKey;

    const moved = await putCfg(adminA, { ...withoutKey, baseUrl: URL_B });
    expect(moved.status, moved.text).toBe(422);
    expect(codeOf(moved)).toBe("AI_PROVIDER_KEY_REQUIRED");
    expect(await configOf(adminA)).toMatchObject({
      baseUrl: URL_A,
      keyLast4: KEY_A.slice(-4),
    });

    // With a new key the move is allowed and the test carries only the new key.
    expect(
      (await putCfg(adminA, { ...withoutKey, baseUrl: URL_B, apiKey: KEY_B }))
        .status,
    ).toBe(200);
    expect(await configOf(adminA)).toMatchObject({
      baseUrl: URL_B,
      keyLast4: KEY_B.slice(-4),
    });
    await testCfg(adminA);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${URL_B}/chat/completions`);
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${KEY_B}`);
  });

  it("13.6 same baseUrl without apiKey keeps the key; trailing slash is normalized; any change clears the last test", async () => {
    await putCfg(adminA, configA);
    await testCfg(adminA);
    expect(await configOf(adminA)).toMatchObject({
      lastTest: { status: "ok" },
    });

    const withoutKey: Partial<typeof configA> = { ...configA };
    delete withoutKey.apiKey;
    const edited = await putCfg(adminA, {
      ...withoutKey,
      baseUrl: `${URL_A}/`,
      defaultModel: "another-model",
    });
    expect(edited.status, edited.text).toBe(200);
    expect(await configOf(adminA)).toMatchObject({
      baseUrl: URL_A,
      defaultModel: "another-model",
      hasKey: true,
      keyLast4: KEY_A.slice(-4),
      lastTest: null,
    });

    // The kept key still works.
    await testCfg(adminA);
    expect(calls.at(-1)!.headers.get("authorization")).toBe(`Bearer ${KEY_A}`);
    expect(calls.at(-1)!.body?.model).toBe("another-model");
  });

  it("13.6 chatgpt_oauth is reserved and refused with AI_PROVIDER_CONNECTION_UNSUPPORTED", async () => {
    const res = await putCfg(adminA, {
      ...configA,
      connectionType: "chatgpt_oauth",
    });
    expect(res.status, res.text).toBe(422);
    expect(codeOf(res)).toBe("AI_PROVIDER_CONNECTION_UNSUPPORTED");
    expect(await configOf(adminA)).toBeNull();
  });

  it("13.6 DELETE removes the config; a second DELETE is AI_PROVIDER_NOT_CONFIGURED", async () => {
    await putCfg(adminA, configA);
    const removed = await delCfg(adminA);
    expect(removed.status).toBe(200);
    expect(removed.body.data.config).toBeNull();
    expect(await rowOf(tenantA)).toBeUndefined();
    const again = await delCfg(adminA);
    expect(again.status).toBe(404);
    expect(codeOf(again)).toBe("AI_PROVIDER_NOT_CONFIGURED");
  });

  it("13.6 a tenant without config sees config null and a fallback flag", async () => {
    const res = await getCfg(adminB);
    expect(res.status).toBe(200);
    expect(res.body.data.config).toBeNull();
    expect(typeof res.body.data.fallbackAvailable).toBe("boolean");
  });
});

// ---- 13.7 provider resolution and budget -----------------------------------------------------

describe("13.7 provider resolution and budget", () => {
  it("13.7 a tenant with config calls its own baseUrl, model and key and records that model", async () => {
    await putCfg(adminA, configA);
    responder = () => chatOk("Jawaban tenant.");
    const res = await ask(adminA);
    expect(res.status, res.text).toBe(200);
    expect(res.body.data.assistantMessage.content).toBe("Jawaban tenant.");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url).toBe(`${URL_A}/chat/completions`);
      expect(call.headers.get("authorization")).toBe(`Bearer ${KEY_A}`);
      expect(call.body?.model).toBe(MODEL_A);
    }
    const usage = await usageRows(tenantA);
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.some((row) => row.model === MODEL_A)).toBe(true);
  }, 60_000);

  it("13.7 cost is priced with the tenant's configured model, not the model the server reports", async () => {
    await putCfg(adminA, configA);
    // A cheap model name reported by the tenant's server must not lower the bill.
    responder = () =>
      Response.json({
        id: "chatcmpl-test",
        object: "chat.completion",
        model: "claude-haiku-5-5",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Jawaban." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      });
    const res = await ask(adminA);
    expect(res.status, res.text).toBe(200);
    // Every ok call returns the same fixed usage, so any ok row proves the cost.
    const row = await inTenant(tenantA, async (c) => {
      const r = await c.query<{ cost_micro_usd: string }>(
        `SELECT cost_micro_usd FROM ai_usage_events
          WHERE tenant_id = $1 AND status = 'ok'
          ORDER BY cost_micro_usd DESC, id LIMIT 1`,
        [tenantA],
      );
      return r.rows[0];
    });
    // MODEL_A is unknown to the price list: opus price, 12 in + 4 out tokens.
    expect(Number(row?.cost_micro_usd)).toBe(
      costMicroUsd(MODEL_A, {
        inputTokens: 12,
        outputTokens: 4,
      }),
    );
    expect(
      costMicroUsd("claude-haiku-5-5", { inputTokens: 12, outputTokens: 4 }),
    ).toBeLessThan(Number(row?.cost_micro_usd));
  }, 60_000);

  it("13.7 a tenant without config uses the platform fallback provider and env.AI_MODEL", async () => {
    const platform = plainAnswer("Jawaban cadangan.");
    setAiProviderForTests(platform);
    const res = await ask(adminB);
    expect(res.status, res.text).toBe(200);
    expect(res.body.data.assistantMessage.content).toBe("Jawaban cadangan.");
    expect(platform.requests.length).toBeGreaterThan(0);
    expect(calls, "no tenant request was made").toHaveLength(0);
    // Spec butir 10.3 says the fallback model is env.AI_MODEL, but under the
    // test override (butir 10.1) the model is not defined, and the scripted
    // provider reports its own. So only the provider name is asserted.
    const usage = await usageRows(tenantB);
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.some((row) => row.provider === "scripted")).toBe(true);
    expect(env.AI_MODEL).toBeTruthy();
  }, 60_000);

  it("13.7 a config added to one tenant does not move another tenant off the fallback", async () => {
    await putCfg(adminA, configA);
    const platform = plainAnswer("Jawaban cadangan.");
    setAiProviderForTests(platform);
    const res = await ask(adminB);
    expect(res.status, res.text).toBe(200);
    expect(platform.requests.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
  }, 60_000);

  it("13.7 budget 0 blocks with AI_BUDGET_EXCEEDED even when the tenant has a config", async () => {
    await putCfg(adminA, configA);
    const patched = await patchGovernance(adminA, { monthlyBudgetIdr: 0 });
    expect(patched.status, patched.text).toBe(200);
    const res = await ask(adminA);
    expect(res.status, res.text).toBe(402);
    expect(codeOf(res)).toBe("AI_BUDGET_EXCEEDED");
    expect(calls, "the tenant's provider is not called").toHaveLength(0);
  }, 60_000);

  it("13.7 budget 0 also blocks a tenant on the fallback", async () => {
    const platform = plainAnswer();
    setAiProviderForTests(platform);
    expect(
      (await patchGovernance(adminB, { monthlyBudgetIdr: 0 })).status,
    ).toBe(200);
    const res = await ask(adminB);
    expect(res.status).toBe(402);
    expect(codeOf(res)).toBe("AI_BUDGET_EXCEEDED");
    expect(platform.requests).toHaveLength(0);
  }, 60_000);

  it("13.7 after DELETE the tenant is served by the fallback again", async () => {
    await putCfg(adminA, configA);
    await delCfg(adminA);
    const platform = plainAnswer("Kembali ke cadangan.");
    setAiProviderForTests(platform);
    const res = await ask(adminA);
    expect(res.status, res.text).toBe(200);
    expect(platform.requests.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
  }, 60_000);
});

// ---- 13.8 rotation -------------------------------------------------------------------------------

describe("13.8 key rotation", () => {
  it("13.8 rotateAiProviderKeys re-seals a row of an older version and the key still works", async () => {
    await putCfg(adminA, configA);
    const before = (await rowOf(tenantA))!;
    expect(sealedVersion(before.api_key_encrypted!)).toBe(currentSealVersion());

    const old = Math.max(0, currentSealVersion() - 1);
    await inTenant(tenantA, (c) =>
      c.query(
        "UPDATE ai_provider_configs SET api_key_key_version = $2 WHERE tenant_id = $1",
        [tenantA, old],
      ),
    );

    // Assumption: like rotateIntegrationCredentials it works per tenant and takes
    // a trusted scoped tenant context; the spec text shows no argument.
    const rotated = await rotateAiProviderKeys(contextFor(tenantA));
    expect(rotated).toEqual({ rotated: 1, unreadable: 0 });

    const after = (await rowOf(tenantA))!;
    expect(after.api_key_key_version).toBe(currentSealVersion());
    expect(sealedVersion(after.api_key_encrypted!)).toBe(currentSealVersion());
    expect(after.api_key_encrypted).not.toBe(before.api_key_encrypted);
    expect(
      openSecret(
        after.api_key_encrypted!,
        `ai_provider_config:${tenantA}:${after.id}`,
      ),
    ).toBe(KEY_A);
    expect(after.api_key_last4).toBe(KEY_A.slice(-4));

    // A row already on the current version is left alone.
    expect(await rotateAiProviderKeys(contextFor(tenantA))).toEqual({
      rotated: 0,
      unreadable: 0,
    });

    const probed = await testCfg(adminA);
    expect(probed.body.data).toMatchObject({ status: "ok" });
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${KEY_A}`);
  });
});

// ---- legend-39d.8 discovery and administrator overrides --------------------------

const discoveredModel = (id: string, context = 32_768) => ({
  id,
  context_length: context,
  max_output_tokens: 2048,
  supported_parameters: ["tools", "reasoning_effort"],
});

describe("legend-39d.8 tenant capability persistence", () => {
  it("legend-39d.8 A2 versions two override saves even within the same application-clock millisecond", async () => {
    metadataResponder = () =>
      Response.json({ data: [discoveredModel(MODEL_A)] });
    const fixedNow = new Date();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fixedNow);
    try {
      expect((await putCfg(adminA, configA)).status).toBe(200);
      const version = () =>
        inTenant(tenantA, async (c) => {
          const rows = await c.query<{ version: string }>(
            "SELECT updated_at::text AS version FROM ai_provider_configs WHERE tenant_id=$1",
            [tenantA],
          );
          return rows.rows[0]!.version;
        });
      const before = await version();
      const first = await putCfg(adminA, {
        ...configA,
        capabilityOverrides: { maxOutputTokens: 1024 },
      });
      expect(first.status, first.text).toBe(200);
      const middle = await version();
      const second = await putCfg(adminA, {
        ...configA,
        capabilityOverrides: { maxOutputTokens: 512 },
      });
      expect(second.status, second.text).toBe(200);
      const after = await version();
      expect(middle).not.toBe(before);
      expect(after).not.toBe(middle);
    } finally {
      vi.useRealTimers();
    }
  });

  it("legend-39d.8 A1 persists metadata detection on save without exposing credentials", async () => {
    metadataResponder = () =>
      Response.json({ data: [discoveredModel(MODEL_A)] });
    const saved = await putCfg(adminA, configA);
    expect(saved.status, saved.text).toBe(200);
    const expected = {
      contextWindow: 32_768,
      maxOutputTokens: 2048,
      supportsTools: true,
      supportsReasoning: true,
      reasoningEfforts: ["low", "medium", "high"],
      source: "metadata",
    };
    expect(saved.body.data.config.capabilities).toEqual(expected);
    expect(saved.body.data.config.capabilityOverrides).toBeNull();
    expect((await configOf(adminA))?.capabilities).toEqual(expected);
    const persisted = await inTenant(tenantA, async (c) => {
      const result = await c.query<{
        detected_capabilities: unknown;
        capability_overrides: unknown;
      }>(
        "SELECT detected_capabilities, capability_overrides FROM ai_provider_configs WHERE tenant_id = $1",
        [tenantA],
      );
      return result.rows[0];
    });
    expect(persisted?.detected_capabilities).toEqual(expected);
    expect(persisted?.capability_overrides).toBeNull();
    expect(metadataCalls).toHaveLength(1);
    expect(metadataCalls[0]!.url).toBe(`${URL_A}/models`);
    expect(metadataCalls[0]!.headers.get("authorization")).toBe(
      `Bearer ${KEY_A}`,
    );
    expect(saved.text).not.toContain(KEY_A);
  });

  it("legend-39d.8 A1 persists known-model and safe-default fallbacks when standard metadata omits limits", async () => {
    metadataResponder = () =>
      Response.json({
        data: [{ id: "gpt-4o", object: "model", owned_by: "openai" }],
      });
    const known = await putCfg(adminA, { ...configA, defaultModel: "gpt-4o" });
    expect(known.status, known.text).toBe(200);
    expect((await configOf(adminA))?.capabilities).toMatchObject({
      contextWindow: 128_000,
      supportsTools: true,
      supportsReasoning: false,
      source: "known",
    });
    const safe = await putCfg(adminA, configA);
    expect(safe.status, safe.text).toBe(200);
    expect((await configOf(adminA))?.capabilities).toEqual({
      contextWindow: 4096,
      maxOutputTokens: 1024,
      supportsTools: false,
      supportsReasoning: false,
      reasoningEfforts: [],
      source: "default",
    });
  });

  it("legend-39d.8 A2 keeps administrator overrides separate, preserves omitted overrides, and clears explicit null", async () => {
    metadataResponder = () =>
      Response.json({ data: [discoveredModel(MODEL_A)] });
    const overrides = {
      contextWindow: 16_384,
      maxOutputTokens: 1024,
      supportsReasoning: false,
    };
    const saved = await putCfg(adminA, {
      ...configA,
      capabilityOverrides: overrides,
    });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.body.data.config.capabilityOverrides).toEqual(overrides);
    expect(saved.body.data.config.capabilities).toMatchObject({
      ...overrides,
      supportsTools: true,
      reasoningEfforts: [],
    });
    const withoutKey = {
      connectionType: "api_key",
      baseUrl: URL_A,
      defaultModel: MODEL_A,
    };
    expect((await putCfg(adminA, withoutKey)).status).toBe(200);
    expect((await configOf(adminA))?.capabilityOverrides).toEqual(overrides);
    const cleared = await putCfg(adminA, {
      ...withoutKey,
      capabilityOverrides: null,
    });
    expect(cleared.status, cleared.text).toBe(200);
    expect(cleared.body.data.config.capabilityOverrides).toBeNull();
    expect(cleared.body.data.config.capabilities).toMatchObject({
      contextWindow: 32_768,
      maxOutputTokens: 2048,
      supportsReasoning: true,
    });
    const persisted = await inTenant(tenantA, (c) =>
      c.query<{ capability_overrides: unknown }>(
        "SELECT capability_overrides FROM ai_provider_configs WHERE tenant_id = $1",
        [tenantA],
      ),
    );
    expect(persisted.rows[0]!.capability_overrides).toBeNull();
  });

  it("legend-39d.8 A2 discards stale overrides when the selected model changes", async () => {
    metadataResponder = () =>
      Response.json({
        data: [discoveredModel(MODEL_A), discoveredModel(MODEL_B, 8192)],
      });
    expect(
      (
        await putCfg(adminA, {
          ...configA,
          capabilityOverrides: { contextWindow: 100_000 },
        })
      ).status,
    ).toBe(200);
    const changed = await putCfg(adminA, {
      connectionType: "api_key",
      baseUrl: URL_A,
      defaultModel: MODEL_B,
    });
    expect(changed.status, changed.text).toBe(200);
    expect(changed.body.data.config.capabilityOverrides).toBeNull();
    expect(changed.body.data.config.capabilities.contextWindow).toBe(8192);
  });

  it("legend-39d.8 A1 refreshes detected limits on connection test and keeps tenant capabilities isolated", async () => {
    metadataResponder = (call) =>
      Response.json({
        data: [
          discoveredModel(
            call.url.startsWith(URL_A) ? MODEL_A : MODEL_B,
            call.url.startsWith(URL_A) ? 32_768 : 65_536,
          ),
        ],
      });
    expect((await putCfg(adminA, configA)).status).toBe(200);
    expect((await putCfg(adminB, configB)).status).toBe(200);
    expect((await configOf(adminA))?.capabilities).toMatchObject({
      contextWindow: 32_768,
    });
    expect((await configOf(adminB))?.capabilities).toMatchObject({
      contextWindow: 65_536,
    });
    metadataResponder = () =>
      Response.json({ data: [discoveredModel(MODEL_A, 16_384)] });
    const tested = await testCfg(adminA);
    expect(tested.status, tested.text).toBe(200);
    expect(tested.body.data.status).toBe("ok");
    expect((await configOf(adminA))?.capabilities).toMatchObject({
      contextWindow: 16_384,
    });
    expect((await configOf(adminB))?.capabilities).toMatchObject({
      contextWindow: 65_536,
    });
    expect(
      metadataCalls.filter((call) => call.url.startsWith(URL_A)),
    ).toHaveLength(2);
    expect(
      metadataCalls.filter((call) => call.url.startsWith(URL_B)),
    ).toHaveLength(1);
  });

  it("legend-39d.8 A2 refuses invalid or owner-supplied override fields before any metadata request", async () => {
    for (const capabilityOverrides of [
      { contextWindow: -1 },
      { contextWindow: 4096, maxOutputTokens: 4096 },
      { tenantId: tenantB },
      { reasoningEfforts: ["unlimited"] },
    ]) {
      const refused = await putCfg(adminA, { ...configA, capabilityOverrides });
      expect(refused.status, refused.text).toBe(422);
    }
    expect(metadataCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(await configOf(adminA)).toBeNull();
  });

  it("legend-39d.8 A2 invalidates an earlier cached answer after an override change", async () => {
    metadataResponder = () =>
      Response.json({ data: [discoveredModel("gpt-4o", 128_000)] });
    const config = { ...configA, defaultModel: "gpt-4o" };
    expect((await putCfg(adminA, config)).status).toBe(200);
    const question = `Berapa total penjualan ${randomUUID()}?`;
    responder = () => chatOk("Jawaban sebelum override.");
    const first = await ask(adminA, question);
    expect(first.status, first.text).toBe(200);
    const cached = await ask(adminA, question);
    expect(cached.status, cached.text).toBe(200);
    const beforeChange = calls.length;
    expect(
      (
        await putCfg(adminA, {
          ...config,
          capabilityOverrides: { maxOutputTokens: 1024 },
        })
      ).status,
    ).toBe(200);
    responder = () => chatOk("Jawaban setelah override.");
    const refreshed = await ask(adminA, question);
    expect(refreshed.status, refreshed.text).toBe(200);
    expect(refreshed.body.data.assistantMessage.content).toBe(
      "Jawaban setelah override.",
    );
    expect(calls.length).toBeGreaterThan(beforeChange);
  }, 60_000);
});

describe("legend-39d.8 UI capability PATCH", () => {
  it("legend-39d.8 A2 PATCH merges supplied capability fields without replacing earlier overrides or fetching metadata", async () => {
    metadataResponder = () =>
      Response.json({ data: [discoveredModel(MODEL_A)] });
    const initial = await putCfg(adminA, {
      ...configA,
      capabilityOverrides: { contextWindow: 16_384, supportsTools: false },
    });
    expect(initial.status, initial.text).toBe(200);
    const before = metadataCalls.length;
    const patched = await patchCfg(adminA, {
      capabilityOverrides: { maxOutputTokens: 1024 },
    });
    expect(patched.status, patched.text).toBe(200);
    expect(patched.body.data.config.capabilityOverrides).toEqual({
      contextWindow: 16_384,
      maxOutputTokens: 1024,
      supportsTools: false,
    });
    expect(patched.body.data.config.capabilities).toMatchObject({
      contextWindow: 16_384,
      maxOutputTokens: 1024,
      supportsTools: false,
    });
    expect((await configOf(adminA))?.capabilityOverrides).toEqual({
      contextWindow: 16_384,
      maxOutputTokens: 1024,
      supportsTools: false,
    });
    expect(metadataCalls).toHaveLength(before);
    expect(calls).toHaveLength(0);
  });

  it("legend-39d.8 A2 preserves omitted override fields on PUT and empty PATCH overrides, then clears explicit null", async () => {
    metadataResponder = () =>
      Response.json({ data: [discoveredModel(MODEL_A)] });
    const existing = { contextWindow: 16_384, maxOutputTokens: 1024 };
    expect(
      (await putCfg(adminA, { ...configA, capabilityOverrides: existing }))
        .status,
    ).toBe(200);
    const merged = await putCfg(adminA, {
      ...configA,
      capabilityOverrides: { supportsTools: false },
    });
    expect(merged.status, merged.text).toBe(200);
    expect(merged.body.data.config.capabilityOverrides).toEqual({
      ...existing,
      supportsTools: false,
    });
    const omitted = await putCfg(adminA, configA);
    expect(omitted.status).toBe(200);
    expect(omitted.body.data.config.capabilityOverrides).toEqual({
      ...existing,
      supportsTools: false,
    });
    const before = metadataCalls.length;
    const unchanged = await patchCfg(adminA, { capabilityOverrides: {} });
    expect(unchanged.status, unchanged.text).toBe(200);
    expect(unchanged.body.data.config.capabilityOverrides).toEqual({
      ...existing,
      supportsTools: false,
    });
    const cleared = await patchCfg(adminA, { capabilityOverrides: null });
    expect(cleared.status, cleared.text).toBe(200);
    expect(cleared.body.data.config.capabilityOverrides).toBeNull();
    expect(cleared.body.data.config.capabilities).toMatchObject({
      contextWindow: 32_768,
      maxOutputTokens: 2048,
      supportsTools: true,
    });
    expect(metadataCalls).toHaveLength(before);
  });

  it("legend-39d.8 A2 rejects a partial update whose merged output would no longer fit its context", async () => {
    metadataResponder = () =>
      Response.json({ data: [discoveredModel(MODEL_A)] });
    const original = { contextWindow: 8192, maxOutputTokens: 4096 };
    expect(
      (await putCfg(adminA, { ...configA, capabilityOverrides: original }))
        .status,
    ).toBe(200);
    const refused = await patchCfg(adminA, {
      capabilityOverrides: { contextWindow: 2048 },
    });
    expect(refused.status, refused.text).toBe(422);
    expect((await configOf(adminA))?.capabilityOverrides).toEqual(original);
  });

  it("legend-39d.8 A2 keeps both partial capability changes under concurrent PATCH requests", async () => {
    metadataResponder = () =>
      Response.json({ data: [discoveredModel(MODEL_A)] });
    expect(
      (
        await putCfg(adminA, {
          ...configA,
          capabilityOverrides: { contextWindow: 16_384 },
        })
      ).status,
    ).toBe(200);
    const before = metadataCalls.length;
    const results = await Promise.all([
      patchCfg(adminA, { capabilityOverrides: { maxOutputTokens: 1024 } }),
      patchCfg(adminA, { capabilityOverrides: { supportsTools: false } }),
    ]);
    for (const result of results) expect(result.status, result.text).toBe(200);
    expect((await configOf(adminA))?.capabilityOverrides).toEqual({
      contextWindow: 16_384,
      maxOutputTokens: 1024,
      supportsTools: false,
    });
    expect(metadataCalls).toHaveLength(before);
  });

  it("legend-39d.8 A2 applies PATCH only to the current tenant and refuses a submitted target tenant", async () => {
    expect(
      (
        await putCfg(adminA, {
          ...configA,
          capabilityOverrides: { maxOutputTokens: 512 },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await putCfg(adminB, {
          ...configB,
          capabilityOverrides: { maxOutputTokens: 768 },
        })
      ).status,
    ).toBe(200);
    const patched = await patchCfg(adminA, {
      capabilityOverrides: { contextWindow: 8192 },
    });
    expect(patched.status, patched.text).toBe(200);
    expect((await configOf(adminA))?.capabilityOverrides).toEqual({
      maxOutputTokens: 512,
      contextWindow: 8192,
    });
    expect((await configOf(adminB))?.capabilityOverrides).toEqual({
      maxOutputTokens: 768,
    });
    const injected = await patchCfg(adminA, {
      capabilityOverrides: { maxOutputTokens: 1024 },
      tenantId: tenantB,
    });
    expect(injected.status).toBe(422);
    expect((await configOf(adminB))?.capabilityOverrides).toEqual({
      maxOutputTokens: 768,
    });
  });

  it("legend-39d.8 A2 PATCH requires auth, trusted origin, governance permission, a valid body and an existing config", async () => {
    const anonymous = await agent(app)
      .patch("/api/ai/provider")
      .set("Host", tenantHost)
      .set(originHeader)
      .send({ capabilityOverrides: null });
    expect(anonymous.status).toBe(401);
    const missing = await patchCfg(adminA, { capabilityOverrides: null });
    expect(missing.status, missing.text).toBe(404);
    expect(codeOf(missing)).toBe("AI_PROVIDER_NOT_CONFIGURED");
    expect((await putCfg(adminA, configA)).status).toBe(200);
    const foreign = await adminA.client
      .patch("/api/ai/provider")
      .set("Origin", "https://evil.example")
      .send({ capabilityOverrides: null });
    expect(foreign.status).toBe(403);
    const withoutPermission = await plainUserA(
      ["ai.ask"],
      "Capability observer",
    );
    expect(
      (await patchCfg(withoutPermission, { capabilityOverrides: null })).status,
    ).toBe(403);
    for (const body of [
      {},
      { capabilities: { contextWindow: 8192 } },
      { capabilityOverrides: { ownerId: adminA.userId } },
      { capabilityOverrides: { contextWindow: -1 } },
    ])
      expect((await patchCfg(adminA, body)).status).toBe(422);
  });
});
