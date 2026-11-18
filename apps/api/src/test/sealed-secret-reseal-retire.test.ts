// legend-rj284 K3 (docs/design/reseal-chatgpt-push.md sections 4.4 and 7, R1-R6):
// the weekly sealed-secret-reseal job must also move ChatGPT tokens, ChatGPT
// pending device codes and push subscriptions to the active data key, and its
// report must say when an old key can retire.
//
// Written from the design (not from how the job or the service is built).
// Retirement rule (design 4.4): the report is retirement-ready only when
// aborted == false, failedTenants == 0 and, for every key, failed == 0 and
// remaining == 0.
//
// Assumptions:
//   - Rings follow sealed-secret-reseal-voucher-idempotency.test.ts: rows are
//     sealed under ring2 (key 2 only, active 2), the job runs under ringBoth
//     (keys 2+3, active 3), and the "after retirement" ring3 has key 3 only.
//     The design calls the old/new keys v1/v2; this file uses explicit key
//     material (2 and 3) so the old key can really leave the ring.
//   - runSealedSecretReseal accepts `columns`, `listTenantIds`, `batchSize`,
//     `log`, `signal`, `reportOnly` and `serviceSweeps` (design 4.1). The
//     registry is narrowed to the push_subscriptions entry; a non-empty
//     `columns` skips the built-in sweeps unless `serviceSweeps` is passed, so
//     it is always passed here. `listTenantIds` also limits the service sweep.
//   - Tenants are handled one after another, and the job checks `signal`
//     between tenants (R3), so which tenant is reached first is not asserted.
//   - The report has one entry per `<table>.<column>`; an optional `busy`
//     count is present for service sweeps (absent counts as 0).
//   - Aborted run: the report of tenants that were not reached is not asserted
//     (only that their rows are untouched and `aborted` is true).
//   - Instead of driving the HTTP device poll, R1 proves the poll path can
//     still read the pending code by opening it with the service AAD
//     `ai_chatgpt:<tenant>:<rowId>:pending` under the key ring without key 2.
//     Tokens are read through the real `getChatgptCredentials(context, 1)`
//     with AI_CHATGPT_ENABLED on and an expiry far in the future (no refresh).
//   - ai_chatgpt_connections: status 'connected' needs enabled and tokens;
//     'pending' with only a pending code is a valid row; consent columns are
//     required whenever enabled (migration 0315 CHECKs).
//   - A row is busy when operation_id is set and the lease ends in the future.
//   - Rows are inserted as the table owner with foreign keys off (fixtures
//     only); the job itself runs as the restricted app role (RLS on).
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
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
import { roleTemplate } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";

const KEY2 = randomBytes(32).toString("base64");
const KEY3 = randomBytes(32).toString("base64");

vi.hoisted(() => {
  // Config reads the environment when it loads; start with key 2 active.
  process.env.DATA_ENCRYPTION_KEYS = `2:${Buffer.alloc(32, 7).toString("base64")}`;
  process.env.DATA_ENCRYPTION_ACTIVE_KEY_VERSION = "2";
});

const fixtureTenant = cafeLegendPlatformFixtures.tenant.id;
const tenantA = randomUUID();
const tenantB = randomUUID();
const tenants = [tenantA, tenantB];
// Real tenant owners: the ChatGPT service re-checks that the person who
// accepted the risk is still an owner (ai.governance.manage) of the tenant.
const ownerUsers = new Map<string, string>();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

/** Fresh module graph (secrets, push, ChatGPT service, job) under one key ring. */
async function load(keys: string, active: string) {
  vi.resetModules();
  vi.stubEnv("DATA_ENCRYPTION_KEYS", keys);
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_VERSION", active);
  const secrets = await import("../lib/secrets.ts");
  const push = await import("../lib/push-subscription.ts");
  const chatgpt = await import("../services/ai-chatgpt.service.ts");
  const job = await import("../worker/sealed-secret-reseal.job.ts");
  const config = await import("../config/env.ts");
  // The trusted-context marker lives in the module graph: build contexts from
  // the same (freshly reset) graph the service under test was loaded from.
  const core = await import("@starter/shared/core/server");
  return { secrets, push, chatgpt, job, config, core };
}
type Ring = Awaited<ReturnType<typeof load>>;
type Sweep = Ring["job"]["SEALED_SERVICE_SWEEPS"][number];
type JobResult = Awaited<ReturnType<Ring["job"]["runSealedSecretReseal"]>>;

let ring2: Ring; // rows "written before the rotation": key 2 only, active 2
let ringBoth: Ring; // the rotation run: keys 2 and 3, active 3

const TOKENS_KEY = "ai_chatgpt_connections.tokens_encrypted";
const PENDING_KEY = "ai_chatgpt_connections.pending_encrypted";
const PUSH_KEY = "push_subscriptions.subscription_ciphertext";

// --- database helpers -------------------------------------------------------

async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
    );
    // Fixtures only: no foreign keys or triggers while seeding or cleaning.
    await client.query("SET LOCAL session_replication_role = replica");
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

const chatgptAad = (tenant: string, id: string, kind: "tokens" | "pending") =>
  `ai_chatgpt:${tenant}:${id}:${kind}`;

type Conn = {
  tenant: string;
  id: string;
  accessToken: string | null;
  tokens: string | null;
  pending: string | null;
  pendingPlain: string | null;
};

/** One ChatGPT connection row sealed under ring2 (the pre-rotation key). */
async function seedChatgpt(
  tenant: string,
  options: { tokens?: boolean; pending?: boolean; busy?: boolean },
): Promise<Conn> {
  const id = randomUUID();
  const accessToken = options.tokens
    ? jwt({ sub: `owner-${randomUUID()}` })
    : null;
  const tokensPlain = accessToken
    ? JSON.stringify({
        accessToken,
        refreshToken: `refresh-${randomUUID()}`,
        accountId: "acct-fixture",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
    : null;
  const pendingPlain = options.pending
    ? JSON.stringify({ marker: `pending-${randomUUID()}` })
    : null;
  const tokens = tokensPlain
    ? ring2.secrets.sealSecret(tokensPlain, chatgptAad(tenant, id, "tokens"))
    : null;
  const pending = pendingPlain
    ? ring2.secrets.sealSecret(pendingPlain, chatgptAad(tenant, id, "pending"))
    : null;
  await asOwner(tenant, (client) =>
    client.query(
      `INSERT INTO ai_chatgpt_connections
         (id, tenant_id, enabled, status, model, generation, attempt_id,
          tokens_encrypted, pending_encrypted, risk_accepted_by, risk_accepted_at,
          connected_at, operation_id, operation_lease_until)
       VALUES ($1, $2, true, $3, 'gpt-5-codex', 1, $4, $5, $6, $7, now(),
          $8, $9, $10)`,
      [
        id,
        tenant,
        options.tokens ? "connected" : "pending",
        randomUUID(),
        tokens,
        pending,
        ownerUsers.get(tenant),
        options.tokens ? new Date() : null,
        options.busy ? randomUUID() : null,
        options.busy ? new Date(Date.now() + 5 * 60_000) : null,
      ],
    ),
  );
  return { tenant, id, accessToken, tokens, pending, pendingPlain };
}

type Row = Record<string, unknown>;

async function rawConnection(tenant: string): Promise<Row> {
  return asOwner(tenant, async (client) => {
    const { rows } = await client.query(
      "SELECT row_to_json(x) AS row FROM ai_chatgpt_connections x WHERE tenant_id = $1",
      [tenant],
    );
    expect(rows, `connection of ${tenant}`).toHaveLength(1);
    return rows[0].row as Row;
  });
}

/** Everything except the two sealed columns (updated_at, lease, generation ...). */
const withoutCipher = (row: Row): Row => {
  const { tokens_encrypted, pending_encrypted, ...rest } = row;
  void tokens_encrypted;
  void pending_encrypted;
  return rest;
};

function browserSubscription() {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
    keys: {
      p256dh: key.getPublicKey().toString("base64url"),
      auth: Buffer.alloc(16, 7).toString("base64url"),
    },
  };
}

type Push = {
  tenant: string;
  id: string;
  userId: string;
  subscription: ReturnType<typeof browserSubscription>;
  endpointHash: string;
  ciphertext: string;
};

/** One push subscription sealed under ring2 through the real protector. */
async function seedPush(tenant: string): Promise<Push> {
  const userId = randomUUID();
  const subscription = browserSubscription();
  const sealed = await ring2.push
    .createPushSubscriptionProtector()
    .seal(subscription, tenant, userId);
  const id = randomUUID();
  await asOwner(tenant, (client) =>
    client.query(
      `INSERT INTO push_subscriptions
         (tenant_id, id, user_id, endpoint_hash, subscription_ciphertext, key_version,
          device_label, created_at, registered_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'HP uji', now(), now())`,
      [
        tenant,
        id,
        userId,
        sealed.endpointHash,
        sealed.ciphertext,
        sealed.keyVersion,
      ],
    ),
  );
  return {
    tenant,
    id,
    userId,
    subscription,
    endpointHash: sealed.endpointHash,
    ciphertext: sealed.ciphertext,
  };
}

async function rawPush(row: Push): Promise<Row> {
  return asOwner(row.tenant, async (client) => {
    const { rows } = await client.query(
      "SELECT row_to_json(x) AS row FROM push_subscriptions x WHERE id = $1",
      [row.id],
    );
    expect(rows, `push row ${row.id}`).toHaveLength(1);
    return rows[0].row as Row;
  });
}

async function cleanRows() {
  await owner.query(
    "DELETE FROM sealed_secret_reseal_state WHERE scope_key = ANY($1)",
    [tenants],
  );
  for (const tenant of tenants)
    await asOwner(tenant, async (client) => {
      await client.query(
        "DELETE FROM push_subscriptions WHERE tenant_id = $1",
        [tenant],
      );
      await client.query(
        "DELETE FROM ai_chatgpt_connections WHERE tenant_id = $1",
        [tenant],
      );
    });
}

// --- job helpers ------------------------------------------------------------

function pushColumn(ring: Ring) {
  const column = ring.job.SEALED_SECRET_COLUMNS.find(
    (c) =>
      c.table === "push_subscriptions" &&
      c.column === "subscription_ciphertext",
  );
  if (!column) throw new Error("registry has no push_subscriptions column");
  return column;
}

/** The ChatGPT sweep the job ships with (K3 wires it into SEALED_SERVICE_SWEEPS). */
function chatgptSweep(ring: Ring): Sweep {
  const sweep = ring.job.SEALED_SERVICE_SWEEPS.find(
    (s) => s.table === "ai_chatgpt_connections",
  );
  expect(
    sweep,
    "SEALED_SERVICE_SWEEPS has an ai_chatgpt_connections sweep",
  ).toBeDefined();
  return sweep!;
}

async function runJob(
  ring: Ring,
  options: {
    tenantIds?: string[];
    sweeps?: readonly Sweep[];
    reportOnly?: boolean;
    signal?: AbortSignal;
    log?: { error: (m: string) => void };
  } = {},
): Promise<JobResult> {
  return ring.job.runSealedSecretReseal({
    columns: [pushColumn(ring)],
    serviceSweeps: options.sweeps ?? [chatgptSweep(ring)],
    listTenantIds: async () => options.tenantIds ?? tenants,
    batchSize: 2,
    log: options.log ?? { error: () => {} },
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.reportOnly ? { reportOnly: true } : {}),
  });
}

/** Design 4.4: may the old key leave DATA_ENCRYPTION_KEYS after this report? */
function retirementReady(result: JobResult): boolean {
  return (
    !result.aborted &&
    result.failedTenants === 0 &&
    Object.values(result.tables).every(
      (t) => t.failed === 0 && t.remaining === 0,
    )
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  for (const tenant of tenants)
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Reseal retire tenant', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [tenant, `reseal-retire-${tenant.slice(0, 8)}`, fixtureTenant],
    );
  for (const tenant of tenants) await seedTenantOwner(tenant);
  ring2 = await load(`2:${KEY2}`, "2");
  ringBoth = await load(`2:${KEY2},3:${KEY3}`, "3");
}, 60_000);

/** A real user holding the Owner template at tenant scope (copy of newOwner in ai-acceptance-helpers, for a private tenant). */
async function seedTenantOwner(tenant: string): Promise<void> {
  const userId = randomUUID();
  const owner_ = roleTemplate("owner");
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [userId, "Reseal retire owner", `reseal-retire-${userId}@example.com`],
  );
  const role = await owner.query<{ id: string }>(
    `INSERT INTO roles
       (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, 'Owner', true, 'owner', $2::jsonb, false, $3::jsonb)
     RETURNING id`,
    [
      tenant,
      JSON.stringify(owner_.permissions),
      JSON.stringify(owner_.allowedScopeTypes),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant, userId, role.rows[0]!.id],
  );
  ownerUsers.set(tenant, userId);
}

async function dropTenantOwners(): Promise<void> {
  for (const tenant of tenants) {
    await owner.query("DELETE FROM role_assignments WHERE tenant_id = $1", [
      tenant,
    ]);
    await owner.query("DELETE FROM roles WHERE tenant_id = $1", [tenant]);
  }
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    [...ownerUsers.values()],
  ]);
}

beforeEach(cleanRows);
afterEach(cleanRows);

afterAll(async () => {
  await cleanRows();
  await dropTenantOwners();
  for (const tenant of tenants)
    await asOwner(tenant, (client) =>
      client.query("DELETE FROM tenants WHERE id = $1", [tenant]),
    );
  await owner.end();
  vi.unstubAllEnvs();
});

// --- retirement -------------------------------------------------------------

describe("[legend-rj284] key rotation covers ChatGPT tokens, pending codes and push subscriptions", () => {
  it("R1 full rotation: a whole job run leaves nothing on the old key and every secret still opens without it", async () => {
    const connA = await seedChatgpt(tenantA, { tokens: true, pending: true });
    const connB = await seedChatgpt(tenantB, { pending: true });
    const pushA = await seedPush(tenantA);
    const pushB = await seedPush(tenantB);
    // Precondition: everything is on key 2.
    for (const sealed of [
      connA.tokens!,
      connA.pending!,
      connB.pending!,
      pushA.ciphertext,
      pushB.ciphertext,
    ])
      expect(ring2.secrets.sealedVersion(sealed)).toBe(2);

    // The sweep list the job ships with (not a stub) must cover ChatGPT.
    chatgptSweep(ringBoth);
    const result = await runJob(ringBoth, {
      sweeps: ringBoth.job.SEALED_SERVICE_SWEEPS,
    });

    expect(result.aborted).toBe(false);
    expect(result.failedTenants).toBe(0);
    expect(result.tables[TOKENS_KEY]).toMatchObject({
      resealed: 1,
      failed: 0,
      remaining: 0,
    });
    expect(result.tables[PENDING_KEY]).toMatchObject({
      resealed: 2,
      failed: 0,
      remaining: 0,
    });
    expect(result.tables[PUSH_KEY]).toMatchObject({
      resealed: 2,
      failed: 0,
      remaining: 0,
    });
    for (const key of [TOKENS_KEY, PENDING_KEY])
      expect(result.tables[key]?.busy ?? 0, key).toBe(0);
    expect(ringBoth.job.sealedSecretUnresolved(result)).toBe(0);
    expect(retirementReady(result)).toBe(true);

    // Stored values are on key 3 now, push label in step.
    const afterA = await rawConnection(tenantA);
    const afterB = await rawConnection(tenantB);
    expect(
      ringBoth.secrets.sealedVersion(String(afterA.tokens_encrypted)),
    ).toBe(3);
    expect(
      ringBoth.secrets.sealedVersion(String(afterA.pending_encrypted)),
    ).toBe(3);
    expect(
      ringBoth.secrets.sealedVersion(String(afterB.pending_encrypted)),
    ).toBe(3);
    for (const row of [pushA, pushB]) {
      const stored = await rawPush(row);
      expect(
        ringBoth.secrets.sealedVersion(String(stored.subscription_ciphertext)),
      ).toBe(3);
      expect(stored.key_version).toBe("v3");
    }

    // Key 2 leaves the ring.
    const ring3 = await load(`3:${KEY3}`, "3");
    Object.assign(ring3.config.env, { AI_CHATGPT_ENABLED: true });

    const credentials = await ring3.chatgpt.getChatgptCredentials(
      ring3.core.establishScopedTenantContext(
        ring3.core.establishTenantContext({
          tenantId: tenantA,
          brandId: null,
          source: "session",
        }),
        { kind: "tenant" },
      ),
      1,
    );
    expect(credentials?.accessToken).toBe(connA.accessToken);
    expect(afterA.status).toBe("connected");

    // The pending device codes (poll path input) still open, to the same value.
    expect(
      ring3.secrets.openSecret(
        String(afterA.pending_encrypted),
        chatgptAad(tenantA, connA.id, "pending"),
      ),
    ).toBe(connA.pendingPlain);
    expect(
      ring3.secrets.openSecret(
        String(afterB.pending_encrypted),
        chatgptAad(tenantB, connB.id, "pending"),
      ),
    ).toBe(connB.pendingPlain);

    // Push subscriptions open with their endpoint hash.
    for (const row of [pushA, pushB]) {
      const stored = await rawPush(row);
      expect(
        ring3.push.openPushSubscription(
          String(stored.subscription_ciphertext),
          row.tenant,
          row.userId,
          row.endpointHash,
        ),
      ).toEqual(row.subscription);
    }

    // The envelopes captured before the rotation cannot be opened any more.
    expect(() =>
      ring3.secrets.openSecret(
        connA.tokens!,
        chatgptAad(tenantA, connA.id, "tokens"),
      ),
    ).toThrow();
    expect(() =>
      ring3.secrets.openSecret(
        connA.pending!,
        chatgptAad(tenantA, connA.id, "pending"),
      ),
    ).toThrow();
    expect(() =>
      ring3.push.openPushSubscription(
        pushA.ciphertext,
        pushA.tenant,
        pushA.userId,
        pushA.endpointHash,
      ),
    ).toThrow();
  }, 60_000);

  it("R2 busy ChatGPT row: the report counts it as remaining and busy, so it is not retirement-ready", async () => {
    const conn = await seedChatgpt(tenantA, { tokens: true, busy: true });
    const before = await rawConnection(tenantA);

    const result = await runJob(ringBoth, { tenantIds: [tenantA] });

    expect(result.tables[TOKENS_KEY]).toMatchObject({
      resealed: 0,
      failed: 0,
      remaining: 1,
      busy: 1,
    });
    expect(ringBoth.job.sealedSecretUnresolved(result)).toBeGreaterThan(0);
    expect(retirementReady(result)).toBe(false);
    // The row an operation is using is left exactly as it was.
    expect(await rawConnection(tenantA)).toEqual(before);
    expect(conn.tokens).toBe(before.tokens_encrypted);
  });

  it("R3 abort between tenants: aborted is true and the tenant that was not reached stays untouched", async () => {
    const connA = await seedChatgpt(tenantA, { tokens: true });
    const connB = await seedChatgpt(tenantB, { tokens: true });
    const real = chatgptSweep(ringBoth);
    const controller = new AbortController();
    const visited: string[] = [];
    const abortingSweep: Sweep = {
      ...real,
      reseal: async (tx, tenantId, active) => {
        visited.push(tenantId);
        const out = await real.reseal(tx, tenantId, active);
        controller.abort();
        return out;
      },
    };

    const result = await runJob(ringBoth, {
      sweeps: [abortingSweep],
      signal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    expect(retirementReady(result)).toBe(false);
    expect(visited).toHaveLength(1);
    const reached = [connA, connB].find((c) => c.tenant === visited[0])!;
    const skipped = [connA, connB].find((c) => c.tenant !== visited[0])!;
    const reachedRow = await rawConnection(reached.tenant);
    const skippedRow = await rawConnection(skipped.tenant);
    expect(
      ringBoth.secrets.sealedVersion(String(reachedRow.tokens_encrypted)),
    ).toBe(3);
    expect(skippedRow.tokens_encrypted).toBe(skipped.tokens);
  });

  it("R4 rerunning the whole job at the same active version changes nothing", async () => {
    const connA = await seedChatgpt(tenantA, { tokens: true, pending: true });
    await seedChatgpt(tenantB, { pending: true });
    const pushA = await seedPush(tenantA);
    const seededA = await rawConnection(tenantA);

    const first = await runJob(ringBoth);
    expect(first.tables[TOKENS_KEY]?.resealed).toBe(1);
    expect(retirementReady(first)).toBe(true);
    const afterFirstA = await rawConnection(tenantA);
    const afterFirstB = await rawConnection(tenantB);
    const afterFirstPush = await rawPush(pushA);
    // Re-sealing is not a business change: updated_at, generation, lease stay.
    expect(withoutCipher(afterFirstA)).toEqual(withoutCipher(seededA));
    expect(afterFirstA.tokens_encrypted).not.toBe(connA.tokens);

    const second = await runJob(ringBoth);

    for (const key of [TOKENS_KEY, PENDING_KEY, PUSH_KEY])
      expect(second.tables[key], key).toMatchObject({
        resealed: 0,
        failed: 0,
        remaining: 0,
      });
    expect(second.aborted).toBe(false);
    expect(second.failedTenants).toBe(0);
    expect(retirementReady(second)).toBe(true);
    expect(await rawConnection(tenantA)).toEqual(afterFirstA);
    expect(await rawConnection(tenantB)).toEqual(afterFirstB);
    expect(await rawPush(pushA)).toEqual(afterFirstPush);
  });

  it("R5 reportOnly counts the three keys, never calls the ChatGPT sweep and changes nothing", async () => {
    await seedChatgpt(tenantA, { tokens: true, pending: true });
    const pushA = await seedPush(tenantA);
    const beforeConn = await rawConnection(tenantA);
    const beforePush = await rawPush(pushA);
    const real = chatgptSweep(ringBoth);
    const reseal = vi.fn(real.reseal);

    const result = await runJob(ringBoth, {
      tenantIds: [tenantA],
      reportOnly: true,
      sweeps: [{ ...real, reseal }],
    });

    expect(reseal).not.toHaveBeenCalled();
    for (const key of [TOKENS_KEY, PENDING_KEY, PUSH_KEY])
      expect(result.tables[key], key).toMatchObject({
        resealed: 0,
        failed: 0,
        remaining: 1,
      });
    expect(ringBoth.job.sealedSecretUnresolved(result)).toBe(3);
    expect(retirementReady(result)).toBe(false);
    // Bytes and updated_at identical.
    expect(await rawConnection(tenantA)).toEqual(beforeConn);
    expect(await rawPush(pushA)).toEqual(beforePush);
  });

  it("R6 a sweep that throws for one tenant: that tenant is a failed tenant, its stale rows still count, the others are resealed", async () => {
    const connA = await seedChatgpt(tenantA, { tokens: true });
    const connB = await seedChatgpt(tenantB, { tokens: true });
    const real = chatgptSweep(ringBoth);
    const lines: string[] = [];
    const throwingSweep: Sweep = {
      ...real,
      reseal: async (tx, tenantId, active) => {
        if (tenantId === tenantA) throw new Error("sweep failed for tenant");
        return real.reseal(tx, tenantId, active);
      },
    };

    const result = await runJob(ringBoth, {
      sweeps: [throwingSweep],
      log: { error: (m) => void lines.push(String(m)) },
    });

    expect(result.aborted).toBe(false);
    expect(result.failedTenants).toBe(1);
    // A throwing sweep adds 1 failed per column (same as a registry scope).
    expect(result.tables[TOKENS_KEY]).toMatchObject({
      resealed: 1,
      failed: 1,
      remaining: 1,
    });
    expect(retirementReady(result)).toBe(false);
    // Tenant A is untouched; tenant B moved on.
    expect((await rawConnection(tenantA)).tokens_encrypted).toBe(connA.tokens);
    expect(
      ringBoth.secrets.sealedVersion(
        String((await rawConnection(tenantB)).tokens_encrypted),
      ),
    ).toBe(3);
    // The log never carries secret values.
    const logged = lines.join("\n");
    for (const secret of [connA.tokens!, connB.tokens!, connA.accessToken!])
      expect(logged).not.toContain(secret);
  });
});
