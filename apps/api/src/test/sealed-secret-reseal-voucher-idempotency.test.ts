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
//     than the reviewed NOISE_TABLES list (audit, outbox, notification, login and
//     session plumbing) gains or loses a row on replay. Financial event tables
//     (order_events, bank_reconciliation_case_events, gateway_webhook_events) and
//     table_sessions / table_session_carts are counted (legend-59jya).
//   - A snapshot that "will not open" is one sealed under key 2 with the wrong AAD;
//     the job documents such a row as counted `failed`, left unchanged, still in
//     `remaining`, and not stopping the rest. A row "locked by another
//     transaction" is skipped (SKIP LOCKED): neither resealed nor failed, still in
//     `remaining`, picked up by the next run.
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
/**
 * Tenant tables a voucher replay may legitimately write: audit, outbox,
 * notification, login and session plumbing, telemetry. This is an explicit,
 * reviewed list on purpose (legend-59jya): the former regex
 * /audit|outbox|event|notification|session|login/i also hid financial event
 * tables such as order_events. A new table matching that old pattern fails the
 * classification test below until someone puts it in one of the two lists.
 */
const NOISE_TABLES = new Set([
  "ai_usage_events",
  "audit_logs",
  "customer_display_sessions",
  "domain_event_consumptions",
  "domain_event_gap_requests",
  "domain_event_offsets",
  "domain_event_outbox",
  "domain_event_replays",
  "edge_deferred_events",
  "edge_inbound_events",
  "edge_received_events",
  "edge_txn_ledger_events",
  "login_challenges",
  "notification_outbox",
  "notification_policies",
  "notification_preferences",
  "notification_templates",
  "notifications",
  "panic_press_events",
  "panic_receiver_sessions",
  "session",
  "session_active_outlets",
  "session_participants",
  "wa_login_reply_policies",
  "wifi_sessions",
]);
/** Event/session-named tables that carry money or order state: always counted. */
const COUNTED_EVENT_TABLES = [
  "bank_reconciliation_case_events",
  "gateway_webhook_events",
  "order_events",
  "table_session_carts",
  "table_sessions",
];
const LEGACY_NOISE = /audit|outbox|event|notification|session|login/i;

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

/** Every base table in public with a uuid tenant_id column. */
async function tenantTables(tenant: string): Promise<string[]> {
  return asTenant(tenant, async (client) => {
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id' AND data_type = 'uuid'
          AND table_name IN (SELECT table_name FROM information_schema.tables
                              WHERE table_schema = 'public' AND table_type = 'BASE TABLE')
        ORDER BY table_name`,
    );
    return rows.map((row: { table_name: string }) => row.table_name);
  });
}

/** Row counts of every tenant-scoped table the replay could touch. */
async function tenantCounts(tenant: string): Promise<Record<string, number>> {
  const names = await tenantTables(tenant);
  return asTenant(tenant, async (client) => {
    const counts: Record<string, number> = {};
    for (const name of names) {
      if (NOISE_TABLES.has(name)) continue;
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
  log?: { error: (...args: unknown[]) => void };
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
    log: options.log ?? { error: () => {} },
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

/** Fixture cleanup: every row of the tenant, then the tenant itself. */
async function purgeTenant(tenant: Tenant | undefined) {
  if (!tenant) return;
  await asTenant(tenant.id, async (client) => {
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id' AND data_type = 'uuid'
          AND table_name IN (SELECT table_name FROM information_schema.tables
                              WHERE table_schema = 'public' AND table_type = 'BASE TABLE')`,
    );
    for (const { table_name: name } of rows)
      await client.query(`DELETE FROM public."${name}" WHERE tenant_id = $1`, [
        tenant.id,
      ]);
  }).catch(() => undefined);
  await owner
    .query("DELETE FROM tenants WHERE id = $1", [tenant.id])
    .catch(() => undefined);
}

afterAll(async () => {
  for (const tenant of [tenantA, tenantB]) await purgeTenant(tenant);
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

// --- legend-59jya: failure, lock and filter edge cases ------------------------

const JSON_ENTRY = "promo_command_idempotency.response";

/** Totals over every report of a run (only the JSON sweep exists here). */
function totals(result: Awaited<ReturnType<typeof sweep>>) {
  const sum = { resealed: 0, failed: 0, remaining: 0 };
  for (const report of Object.values(result.tables)) {
    sum.resealed += report.resealed;
    sum.failed += report.failed;
    sum.remaining += report.remaining;
  }
  return sum;
}

function setAt(response: Json, path: string[], value: string) {
  let node = response;
  for (const part of path.slice(0, -1)) node = node[part] as Json;
  node[path[path.length - 1]!] = value;
}

describe("[legend-59jya] reseal sweep edge cases (failed row, locked row, counting filter)", () => {
  let tenantC: Tenant;

  type Seeded = { kind: Kind; key: string; code: string; sealed: string };

  /**
   * A stale (key 2) snapshot in tenant C, cloned from a real row so the JSON
   * shape is what the commands store. `aadKey` differs from `key` for a row
   * that cannot be opened with the AAD the job uses.
   */
  async function seedStale(
    kind: Kind,
    key: string,
    aadKey: string = key,
  ): Promise<Seeded> {
    const source = issuedIn(tenantA.id).find((i) => i.kind === kind)!;
    const stored = await storedRow(source.tenant, source.key);
    const code = `C-${randomBytes(6).toString("hex").toUpperCase()}`;
    const sealed = ring2.secrets.sealSecret(
      code,
      aadOf(kind, tenantC.id, aadKey),
    );
    const response = structuredClone(stored.response);
    setAt(response, sealedPath(kind), sealed);
    await asTenant(tenantC.id, (client) =>
      client.query(
        `INSERT INTO promo_command_idempotency
         SELECT (json_populate_record(NULL::promo_command_idempotency, $1::json)).*`,
        [
          JSON.stringify({
            ...stored.rest,
            tenant_id: tenantC.id,
            key,
            response,
          }),
        ],
      ),
    );
    return { kind, key, code, sealed };
  }

  beforeAll(async () => {
    tenantC = await createTenant(`ra1k-c-${randomUUID().slice(0, 6)}`);
  }, 120_000);

  beforeEach(async () => {
    await owner.query(
      "DELETE FROM sealed_secret_reseal_state WHERE scope_key = $1",
      [tenantC.id],
    );
    await asTenant(tenantC.id, (client) =>
      client.query(
        "DELETE FROM promo_command_idempotency WHERE tenant_id = $1",
        [tenantC.id],
      ),
    );
  });

  afterAll(async () => {
    await purgeTenant(tenantC);
  });

  it("a snapshot that will not open is counted failed, stays unchanged and in remaining, and does not stop the rest", async () => {
    const prefix = randomUUID().slice(0, 6);
    // Sorted by key: good, bad, good, bad. The bad ones are sealed under the
    // right key version but with another AAD, so the job cannot open them.
    const goodPromo = await seedStale("promo", `c1-${prefix}-good`);
    const badPromo = await seedStale(
      "promo",
      `c2-${prefix}-bad`,
      `c2-${prefix}-other`,
    );
    const goodApology = await seedStale("apology", `c3-${prefix}-good`);
    const badApology = await seedStale(
      "apology",
      `c4-${prefix}-bad`,
      `c4-${prefix}-other`,
    );
    const badBefore = await Promise.all(
      [badPromo, badApology].map((row) => storedRow(tenantC.id, row.key)),
    );

    const logged: unknown[][] = [];
    const run = () =>
      sweep(ringBoth, {
        tenantIds: [tenantC.id],
        batchSize: 2,
        log: { error: (...args) => logged.push(args) },
      });
    const first = await run();

    // A row failure is not a tenant failure, and the run was not cut short.
    expect(first).toMatchObject({ aborted: false, failedTenants: 0 });
    expect(Object.keys(first.tables)).toContain(JSON_ENTRY);
    expect(totals(first)).toEqual({ resealed: 2, failed: 2, remaining: 2 });
    // The failed rows still block key retirement.
    expect(ringBoth.job.sealedSecretUnresolved(first)).toBe(2);

    // Good rows (before and after the bad ones) moved to key 3, same plaintext.
    for (const row of [goodPromo, goodApology]) {
      const { response } = await storedRow(tenantC.id, row.key);
      const sealed = readAt(response, sealedPath(row.kind));
      expect(keyVersion(ringBoth, sealed)).toBe(3);
      expect(
        ringBoth.secrets.openSecret(
          sealed,
          aadOf(row.kind, tenantC.id, row.key),
        ),
      ).toBe(row.code);
    }
    // Bad rows are byte-for-byte what they were, still key 2.
    const badAfter = await Promise.all(
      [badPromo, badApology].map((row) => storedRow(tenantC.id, row.key)),
    );
    expect(badAfter).toEqual(badBefore);
    for (const row of [badPromo, badApology])
      expect(keyVersion(ringBoth, row.sealed)).toBe(2);

    // Nothing sealed or opened reaches the log.
    const logText = JSON.stringify(logged);
    for (const row of [goodPromo, badPromo, goodApology, badApology]) {
      expect(logText).not.toContain(row.sealed);
      expect(logText).not.toContain(row.code);
    }

    // A rerun is stable: the bad rows are retried, fail again, nothing else moves.
    const second = await run();
    expect(totals(second)).toEqual({ resealed: 0, failed: 2, remaining: 2 });
    expect(await storedRow(tenantC.id, badPromo.key)).toEqual(badBefore[0]);
    expect(await storedRow(tenantC.id, badApology.key)).toEqual(badBefore[1]);
  });

  it("a snapshot locked by another transaction is skipped (neither resealed nor failed), counted in remaining, and done by the next run", async () => {
    const prefix = randomUUID().slice(0, 6);
    const first = await seedStale("promo", `l1-${prefix}`);
    const locked = await seedStale("promo", `l2-${prefix}`);
    const last = await seedStale("apology", `l3-${prefix}`);
    const lockedBefore = await storedRow(tenantC.id, locked.key);

    // Another transaction holds the row lock for the whole first sweep.
    const holder = await owner.connect();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      try {
        await holder.query("ROLLBACK");
      } finally {
        holder.release();
      }
    };
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantC.id],
      );
      const lock = await holder.query(
        "SELECT key FROM promo_command_idempotency WHERE tenant_id = $1 AND key = $2 FOR UPDATE",
        [tenantC.id, locked.key],
      );
      expect(lock.rows, "the test holds the row lock").toHaveLength(1);

      // batchSize 1: the rows after the locked one are still reached.
      const during = await sweep(ringBoth, {
        tenantIds: [tenantC.id],
        batchSize: 1,
      });
      expect(during).toMatchObject({ aborted: false, failedTenants: 0 });
      expect(totals(during)).toEqual({ resealed: 2, failed: 0, remaining: 1 });
      expect(ringBoth.job.sealedSecretUnresolved(during)).toBe(1);

      for (const row of [first, last]) {
        const { response } = await storedRow(tenantC.id, row.key);
        const sealed = readAt(response, sealedPath(row.kind));
        expect(keyVersion(ringBoth, sealed)).toBe(3);
        expect(
          ringBoth.secrets.openSecret(
            sealed,
            aadOf(row.kind, tenantC.id, row.key),
          ),
        ).toBe(row.code);
      }
      // The locked row was not touched.
      expect(await storedRow(tenantC.id, locked.key)).toEqual(lockedBefore);
    } finally {
      await release();
    }

    // Lock gone: the next run finishes it, with the same plaintext and AAD.
    const after = await sweep(ringBoth, {
      tenantIds: [tenantC.id],
      batchSize: 1,
    });
    expect(totals(after)).toEqual({ resealed: 1, failed: 0, remaining: 0 });
    expect(ringBoth.job.sealedSecretUnresolved(after)).toBe(0);
    const { response } = await storedRow(tenantC.id, locked.key);
    const sealed = readAt(response, sealedPath(locked.kind));
    expect(keyVersion(ringBoth, sealed)).toBe(3);
    expect(
      ringBoth.secrets.openSecret(
        sealed,
        aadOf(locked.kind, tenantC.id, locked.key),
      ),
    ).toBe(locked.code);
  });

  it("the table filter of the no-second-record check hides only reviewed plumbing tables, never a financial event table", async () => {
    const tables = await tenantTables(tenantC.id);
    const classified = new Set([...NOISE_TABLES, ...COUNTED_EVENT_TABLES]);

    // Every tenant table the old regex would have hidden is classified by a
    // person. A new *_events / *_sessions table lands here and must be put in
    // NOISE_TABLES (plumbing) or COUNTED_EVENT_TABLES (money or order state).
    const unclassified = tables.filter(
      (name) => LEGACY_NOISE.test(name) && !classified.has(name),
    );
    expect(unclassified, "classify these tables").toEqual([]);

    // The financial event tables are counted ...
    const counts = await tenantCounts(tenantC.id);
    for (const name of COUNTED_EVENT_TABLES)
      if (tables.includes(name))
        expect(Object.keys(counts), `${name} is counted`).toContain(name);
    expect(tables).toContain("order_events");
    expect(Object.keys(counts)).toContain("order_events");
    // ... and the plumbing list never swallows one of them.
    for (const name of COUNTED_EVENT_TABLES)
      expect(NOISE_TABLES.has(name), `${name} is not noise`).toBe(false);
    // Only listed plumbing tables are missing from the counts.
    const hidden = tables.filter((name) => !(name in counts));
    expect(hidden.filter((name) => !NOISE_TABLES.has(name))).toEqual([]);

    // A row appearing in a counted table shows up in the diff.
    expect(
      diffCounts(
        { ...counts },
        { ...counts, order_events: counts.order_events! + 1 },
      ),
    ).toEqual({
      order_events: [counts.order_events, counts.order_events! + 1],
    });
  });
});
