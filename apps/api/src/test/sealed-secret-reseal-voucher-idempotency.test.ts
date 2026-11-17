// legend-ra1k0 (SO 957 finding P2-1, docs/qa/second-opinion-akses-946-951.md):
// the voucher code snapshots kept inside promo_command_idempotency.response
// (promo voucher and apology voucher, written for Idempotency-Key replay) must
// move to the active data key in the sealed-secret reseal sweep, and leftovers
// must count in the "remaining" report that gates retiring the old key.
//
// Written from the second-opinion "Usul test" and the job's documented contract
// (worker/sealed-secret-reseal.job.ts header), not from how the sweep is built.
// Vouchers are issued through the real HTTP commands (POST /api/vouchers and
// POST /api/apology-vouchers with an Idempotency-Key) while key 2 is active.
//
// Assumptions:
//   - Both commands store the replay snapshot in promo_command_idempotency
//     (columns tenant_id, key, response) and seal the voucher code inside it:
//     promo at response.code (AAD promo-voucher-idem:<tenant>:<key>), apology
//     at response.voucher.code (AAD apology-voucher-idem:<tenant>:<key>).
//   - The JSON sweep runs inside runSealedSecretReseal whatever `columns` is
//     passed (the test passes an empty registry, so only this sweep can move or
//     count anything), is limited by `listTenantIds`, honours `batchSize`,
//     `afterBatch`, `signal` and `reportOnly`, and is included in
//     sealedSecretUnresolved(result).
//   - The key ring may contain key 3 alone (key 2 retired) once the sweep is done.
//   - Replay of a stored key answers 200 or 201 with the same voucher id/code.
//   - "No second financial record" is checked as: no tenant-scoped table other
//     than audit/outbox/session noise gains or loses a row on replay.
//   - Role permissions "promo.manage" and "order.apology_voucher.issue" are
//     enough for the two commands (an approval policy exists as in the
//     order-recovery world; the voucher value is below its floor).
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const KEY2 = randomBytes(32).toString("base64");
const KEY3 = randomBytes(32).toString("base64");

vi.hoisted(() => {
  // Config reads the environment when it loads; start with key 2 active.
  process.env.DATA_ENCRYPTION_KEYS = `2:${Buffer.alloc(32, 7).toString("base64")}`;
  process.env.DATA_ENCRYPTION_ACTIVE_KEY_VERSION = "2";
});

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

const PASSWORD = "Test-password-123!";
const NOISE = /audit|outbox|event|notification|session|login/i;

type Ring = Awaited<ReturnType<typeof load>>;

/** Fresh module graph (app, db, secrets, job) under one key ring. */
async function load(keys: string, active: string) {
  vi.resetModules();
  vi.stubEnv("DATA_ENCRYPTION_KEYS", keys);
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_VERSION", active);
  const { createApp } = await import("../app");
  const helpers = await import("./helpers");
  const secrets = await import("../lib/secrets.ts");
  const job = await import("../worker/sealed-secret-reseal.job.ts");
  return { app: createApp(), helpers, secrets, job };
}

// --- database helpers -------------------------------------------------------

async function asTenant<T>(
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

type Kind = "promo" | "apology";
type Issued = {
  kind: Kind;
  tenant: string;
  key: string;
  path: string;
  body: Record<string, unknown>;
  id: string;
  code: string;
};

const aadOf = (kind: Kind, tenant: string, key: string) =>
  kind === "promo"
    ? `promo-voucher-idem:${tenant}:${key}`
    : `apology-voucher-idem:${tenant}:${key}`;

/** Where the sealed code sits inside the stored response JSON. */
const sealedPath = (kind: Kind): string[] =>
  kind === "promo" ? ["code"] : ["voucher", "code"];

type Json = Record<string, unknown>;

function readAt(response: Json, path: string[]): string {
  let node: unknown = response;
  for (const part of path) node = (node as Json | undefined)?.[part];
  return String(node);
}

function withoutSealed(response: Json, path: string[]): Json {
  const copy = structuredClone(response);
  let node = copy;
  for (const part of path.slice(0, -1)) node = node[part] as Json;
  delete node[path[path.length - 1]!];
  return copy;
}

type Stored = { response: Json; rest: Json };

async function storedRow(tenant: string, key: string): Promise<Stored> {
  return asTenant(tenant, async (client) => {
    const { rows } = await client.query(
      "SELECT to_jsonb(t) AS j FROM promo_command_idempotency t WHERE tenant_id = $1 AND key = $2",
      [tenant, key],
    );
    expect(rows, `idempotency row ${key}`).toHaveLength(1);
    const { response, ...rest } = rows[0].j as Json;
    return { response: response as Json, rest };
  });
}

/** Row counts of every tenant-scoped table the replay could touch. */
async function tenantCounts(tenant: string): Promise<Record<string, number>> {
  return asTenant(tenant, async (client) => {
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id' AND data_type = 'uuid'
          AND table_name IN (SELECT table_name FROM information_schema.tables
                              WHERE table_schema = 'public' AND table_type = 'BASE TABLE')
        ORDER BY table_name`,
    );
    const counts: Record<string, number> = {};
    for (const { table_name: name } of rows) {
      if (NOISE.test(name)) continue;
      const result = await client.query(
        `SELECT count(*)::int AS n FROM public."${name}" WHERE tenant_id = $1`,
        [tenant],
      );
      counts[name] = result.rows[0].n;
    }
    return counts;
  });
}

function diffCounts(
  before: Record<string, number>,
  after: Record<string, number>,
) {
  const diff: Record<string, [number, number]> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (before[name] !== after[name])
      diff[name] = [before[name] ?? 0, after[name] ?? 0];
  return diff;
}

// --- fixtures ---------------------------------------------------------------

type Tenant = { id: string; outletId: string; hostname: string; role: string };
type Account = { email: string; userId: string };

async function createTenant(label: string): Promise<Tenant> {
  const f = await import("./floor-test-helpers");
  const t = await f.createIsolatedTenant(label);
  const role = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Voucher Uji', false, NULL, $3, false, '["tenant","outlet"]')`,
    [
      role,
      t.tenantId,
      JSON.stringify([
        "promo.manage",
        "order.view",
        "order.create",
        "order.apology_voucher.issue",
      ]),
    ],
  );
  // Same approval matrix as the order-recovery world: below Rp100.000 needs none.
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
     VALUES ($1, 'apology_voucher', 100000, $2, 1, true)`,
    [t.tenantId, role],
  );
  return { id: t.tenantId, outletId: t.outletId, hostname: t.hostname, role };
}

async function createAccount(
  ring: Ring,
  tenant: Tenant,
  scope: "tenant" | "outlet",
): Promise<{ account: Account; client: ReturnType<Ring["helpers"]["agent"]> }> {
  const client = ring.helpers.agent(ring.app);
  const email = await ring.helpers.signUp(client, "Voucher Staff");
  await ring.helpers.setRole(email, null);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenant.id,
      userId,
      tenant.role,
      scope,
      scope === "outlet" ? tenant.outletId : null,
    ],
  );
  return { account: { email, userId }, client };
}

async function signIn(ring: Ring, account: Account) {
  const client = ring.helpers.agent(ring.app);
  const response = await client
    .post("/api/auth/sign-in/email")
    .set(ring.helpers.originHeader)
    .send({ email: account.email, password: PASSWORD });
  if (response.status !== 200)
    throw new Error(`Sign-in failed with ${response.status}`);
  return client;
}

// --- state shared by the ordered scenario ----------------------------------

let tenantA: Tenant;
let tenantB: Tenant;
let promoStaff: Account;
let apologyStaff: Account;
const issued: Issued[] = [];
/** Snapshots of the two cloned rows seeded into tenant B (key 2, B's own AAD). */
const seededB: { kind: Kind; key: string; code: string }[] = [];
let ring3: Ring;

const issuedIn = (tenant: string) => issued.filter((i) => i.tenant === tenant);
const keyVersion = (ring: Ring, sealed: string) =>
  ring.secrets.sealedVersion(sealed);

async function versionsOf(ring: Ring, rows: Issued[]) {
  const out: number[] = [];
  for (const row of rows) {
    const { response } = await storedRow(row.tenant, row.key);
    out.push(keyVersion(ring, readAt(response, sealedPath(row.kind))));
  }
  return out;
}

type RunOptions = {
  tenantIds: string[];
  batchSize?: number;
  signal?: AbortSignal;
  afterBatch?: () => void | Promise<void>;
  reportOnly?: boolean;
};

/** The sweep under test, with an empty column registry (JSON snapshots only). */
async function sweep(ring: Ring, options: RunOptions) {
  return ring.job.runSealedSecretReseal({
    columns: [],
    listTenantIds: async () => options.tenantIds,
    batchSize: options.batchSize ?? 2,
    log: { error: () => {} },
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.afterBatch ? { afterBatch: options.afterBatch } : {}),
    ...(options.reportOnly ? { reportOnly: true } : {}),
  });
}

let ring2: Ring;
let ringBoth: Ring;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenantA = await createTenant(`ra1k-a-${randomUUID().slice(0, 6)}`);
  tenantB = await createTenant(`ra1k-b-${randomUUID().slice(0, 6)}`);

  // Phase 1: key 2 is the only and the active key.
  ring2 = await load(`2:${KEY2}`, "2");
  const promo = await createAccount(ring2, tenantA, "tenant");
  const apology = await createAccount(ring2, tenantA, "outlet");
  promoStaff = promo.account;
  apologyStaff = apology.account;

  const validFrom = new Date(Date.now() - 3_600_000).toISOString();
  for (let i = 0; i < 3; i++) {
    const key = `promo-${randomUUID()}`;
    const body = {
      promotionId: null,
      customerProfileId: null,
      source: "manual",
      valueIdr: 20_000 + i * 1_000,
      validFrom,
      validUntil: null,
    };
    const res = await promo.client
      .post("/api/vouchers")
      .set("Host", tenantA.hostname)
      .set(ring2.helpers.originHeader)
      .set("Idempotency-Key", key)
      .send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    issued.push({
      kind: "promo",
      tenant: tenantA.id,
      key,
      path: "/api/vouchers",
      body,
      id: res.body.data.voucher.id,
      code: res.body.data.code,
    });
  }
  for (let i = 0; i < 2; i++) {
    const key = `apology-${randomUUID()}`;
    const body = {
      valueIdr: 20_000 + i * 1_000,
      reason: "Roti habis, mohon maaf atas ketidaknyamanan",
    };
    const res = await apology.client
      .post("/api/apology-vouchers")
      .set("Host", tenantA.hostname)
      .set(ring2.helpers.originHeader)
      .set("Idempotency-Key", key)
      .send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    issued.push({
      kind: "apology",
      tenant: tenantA.id,
      key,
      path: "/api/apology-vouchers",
      body,
      id: res.body.data.id,
      code: res.body.data.code,
    });
  }

  // Tenant B: one snapshot of each kind written under key 2 with B's own AAD,
  // copied from a real row so the JSON shape is exactly what the commands store.
  for (const kind of ["promo", "apology"] as const) {
    const source = issued.find((i) => i.kind === kind)!;
    const stored = await storedRow(source.tenant, source.key);
    const key = `b-${kind}-${randomUUID()}`;
    const code = `B-${randomBytes(6).toString("hex").toUpperCase()}`;
    const response = structuredClone(stored.response);
    const path = sealedPath(kind);
    let node = response;
    for (const part of path.slice(0, -1)) node = node[part] as Json;
    node[path[path.length - 1]!] = ring2.secrets.sealSecret(
      code,
      aadOf(kind, tenantB.id, key),
    );
    await asTenant(tenantB.id, (client) =>
      client.query(
        `INSERT INTO promo_command_idempotency
         SELECT (json_populate_record(NULL::promo_command_idempotency, $1::json)).*`,
        [
          JSON.stringify({
            ...stored.rest,
            tenant_id: tenantB.id,
            key,
            response,
          }),
        ],
      ),
    );
    seededB.push({ kind, key, code });
  }

  // Phase 2: key 3 active, keys 2 and 3 both known (the sweep opens key 2).
  ringBoth = await load(`2:${KEY2},3:${KEY3}`, "3");
}, 180_000);

beforeEach(async () => {
  await owner.query(
    "DELETE FROM sealed_secret_reseal_state WHERE scope_key = ANY($1)",
    [[tenantA.id, tenantB.id]],
  );
});

afterAll(async () => {
  for (const tenant of [tenantA, tenantB]) {
    if (!tenant) continue;
    await asTenant(tenant.id, async (client) => {
      const { rows } = await client.query(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'tenant_id' AND data_type = 'uuid'
            AND table_name IN (SELECT table_name FROM information_schema.tables
                                WHERE table_schema = 'public' AND table_type = 'BASE TABLE')`,
      );
      for (const { table_name: name } of rows)
        await client.query(
          `DELETE FROM public."${name}" WHERE tenant_id = $1`,
          [tenant.id],
        );
    }).catch(() => undefined);
    await owner
      .query("DELETE FROM tenants WHERE id = $1", [tenant.id])
      .catch(() => undefined);
  }
  await owner.end();
});

// --- scenario ---------------------------------------------------------------

describe("[legend-ra1k0] voucher idempotency snapshots follow the key rotation", () => {
  it("precondition: both commands stored the code sealed under key 2 with their own AAD", async () => {
    expect(issued).toHaveLength(5);
    for (const row of issuedIn(tenantA.id)) {
      const { response } = await storedRow(row.tenant, row.key);
      const sealed = readAt(response, sealedPath(row.kind));
      expect(keyVersion(ring2, sealed)).toBe(2);
      expect(sealed).not.toContain(row.code);
      expect(
        ring2.secrets.openSecret(sealed, aadOf(row.kind, row.tenant, row.key)),
      ).toBe(row.code);
    }
  });

  it("remaining report counts the leftover JSON snapshots although the column registry is empty", async () => {
    const before = await versionsOf(ringBoth, issuedIn(tenantA.id));
    const result = await sweep(ringBoth, {
      tenantIds: [tenantA.id],
      reportOnly: true,
    });
    // Five key-2 snapshots in tenant A: they block retiring key 2.
    expect(ringBoth.job.sealedSecretUnresolved(result)).toBe(5);
    // A report changes nothing.
    expect(await versionsOf(ringBoth, issuedIn(tenantA.id))).toEqual(before);
  });

  it("an interrupted sweep keeps the finished batch, a rerun finishes the rest, and the sweep is idempotent", async () => {
    const rows = issuedIn(tenantA.id);
    const controller = new AbortController();
    const first = await sweep(ringBoth, {
      tenantIds: [tenantA.id],
      batchSize: 1,
      signal: controller.signal,
      afterBatch: () => controller.abort(),
    });
    expect(first.aborted).toBe(true);
    const midVersions = await versionsOf(ringBoth, rows);
    const moved = midVersions.filter((v) => v === 3).length;
    expect(moved).toBeGreaterThanOrEqual(1);
    expect(moved).toBeLessThan(5);
    const mid = await Promise.all(rows.map((r) => storedRow(r.tenant, r.key)));

    const second = await sweep(ringBoth, {
      tenantIds: [tenantA.id],
      batchSize: 1,
    });
    expect(second).toMatchObject({ aborted: false, failedTenants: 0 });
    expect(ringBoth.job.sealedSecretUnresolved(second)).toBe(0);
    expect(await versionsOf(ringBoth, rows)).toEqual([3, 3, 3, 3, 3]);
    const after = await Promise.all(
      rows.map((r) => storedRow(r.tenant, r.key)),
    );

    for (const [index, row] of rows.entries()) {
      const path = sealedPath(row.kind);
      const sealed = readAt(after[index]!.response, path);
      // Same plaintext, same AAD binding, now under key 3.
      expect(
        ringBoth.secrets.openSecret(
          sealed,
          aadOf(row.kind, row.tenant, row.key),
        ),
      ).toBe(row.code);
      expect(() =>
        ringBoth.secrets.openSecret(
          sealed,
          aadOf(row.kind, row.tenant, "other"),
        ),
      ).toThrow();
      // Fingerprint, other columns and every other response field are kept.
      expect(after[index]!.rest).toEqual(mid[index]!.rest);
      expect(withoutSealed(after[index]!.response, path)).toEqual(
        withoutSealed(mid[index]!.response, path),
      );
      // A snapshot finished before the interruption was not written again.
      if (midVersions[index] === 3)
        expect(readAt(after[index]!.response, path)).toBe(
          readAt(mid[index]!.response, path),
        );
    }

    // A further sweep changes nothing.
    const third = await sweep(ringBoth, { tenantIds: [tenantA.id] });
    expect(ringBoth.job.sealedSecretUnresolved(third)).toBe(0);
    const again = await Promise.all(
      rows.map((r) => storedRow(r.tenant, r.key)),
    );
    expect(again).toEqual(after);
  });

  it("another tenant's snapshots are untouched by a sweep of tenant A, and are still counted as remaining", async () => {
    for (const row of seededB) {
      const { response } = await storedRow(tenantB.id, row.key);
      const sealed = readAt(response, sealedPath(row.kind));
      expect(keyVersion(ringBoth, sealed)).toBe(2);
      expect(
        ringBoth.secrets.openSecret(
          sealed,
          aadOf(row.kind, tenantB.id, row.key),
        ),
      ).toBe(row.code);
    }
    // Tenant A is done, so a report over A alone is clean ...
    const clean = await sweep(ringBoth, {
      tenantIds: [tenantA.id],
      reportOnly: true,
    });
    expect(ringBoth.job.sealedSecretUnresolved(clean)).toBe(0);
    // ... but key 2 may not retire while tenant B still holds two of them.
    const both = await sweep(ringBoth, {
      tenantIds: [tenantA.id, tenantB.id],
      reportOnly: true,
    });
    expect(ringBoth.job.sealedSecretUnresolved(both)).toBe(2);

    const done = await sweep(ringBoth, { tenantIds: [tenantB.id] });
    expect(ringBoth.job.sealedSecretUnresolved(done)).toBe(0);
    for (const row of seededB) {
      const { response } = await storedRow(tenantB.id, row.key);
      const sealed = readAt(response, sealedPath(row.kind));
      expect(keyVersion(ringBoth, sealed)).toBe(3);
      expect(
        ringBoth.secrets.openSecret(
          sealed,
          aadOf(row.kind, tenantB.id, row.key),
        ),
      ).toBe(row.code);
    }
    const final = await sweep(ringBoth, {
      tenantIds: [tenantA.id, tenantB.id],
      reportOnly: true,
    });
    expect(ringBoth.job.sealedSecretUnresolved(final)).toBe(0);
  });

  it("with key 2 gone from the key ring, replay returns the same voucher code, with no second voucher and no second financial record", async () => {
    // Phase 3: key ring holds key 3 only.
    ring3 = await load(`3:${KEY3}`, "3");
    const promoClient = await signIn(ring3, promoStaff);
    const apologyClient = await signIn(ring3, apologyStaff);
    const before = await tenantCounts(tenantA.id);

    for (const row of issuedIn(tenantA.id)) {
      const client = row.kind === "promo" ? promoClient : apologyClient;
      const replay = await client
        .post(row.path)
        .set("Host", tenantA.hostname)
        .set(ring3.helpers.originHeader)
        .set("Idempotency-Key", row.key)
        .send(row.body);
      expect(
        [200, 201],
        `${row.kind} replay: ${JSON.stringify(replay.body)}`,
      ).toContain(replay.status);
      const data = replay.body.data;
      expect(data.code).toBe(row.code);
      expect(row.kind === "promo" ? data.voucher.id : data.id).toBe(row.id);
    }

    // No new voucher, no journal/ledger row: every tenant table keeps its count.
    expect(diffCounts(before, await tenantCounts(tenantA.id))).toEqual({});
    const { rows } = await owner.query(
      "SELECT count(*)::int AS n FROM apology_vouchers WHERE tenant_id = $1",
      [tenantA.id],
    );
    expect(rows[0].n).toBe(2);
  });
});
