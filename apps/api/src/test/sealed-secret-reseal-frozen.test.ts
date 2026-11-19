// Re-seal of the four FROZEN sealed columns (beads legend-4vfmn, legend-49onu;
// brief docs/briefs/sub-1189-sealed-reseal-frozen.md). Written from the brief,
// not from the implementation.
//
// The four columns cannot be updated by the application role: completed or
// voided orders and their tenders sit behind an immutability trigger, and
// apology_vouchers is append-only (REVOKE UPDATE). The brief gives them one
// door: the SECURITY DEFINER function
//   app.reseal_frozen_sealed(p_table, p_column, p_tenant, p_id, p_expected, p_new)
// that only role legend_sealed_reseal may run (legend_app reaches the role with
// SET ROLE), and the job calls it for rows that match `frozenWhere`.
//
// Evidence list (a)-(f) of the brief:
//   (a) job reseals frozen rows of all four columns: same plaintext, other
//       columns untouched;
//   (b) the function refuses a pair outside the whitelist, empty or non-base64
//       values, an unchanged value and a version that goes down; the job never
//       changes a plaintext (a row it cannot open is `failed`, left as written);
//   (c) a direct UPDATE of any other column of a frozen row stays refused by the
//       trigger, also when the login sets the GUC itself;
//   (d) the plain application login (no SET ROLE) cannot EXECUTE the function;
//   (e) `remaining` counts frozen rows, and is 0 after a successful job;
//   (f) tenant isolation: a tenant GUC that does not match p_tenant is refused,
//       and a job for one tenant never touches another tenant's rows.
//
// Assumptions (the brief is silent), each easy to change:
//   - Error codes are only pinned where the brief gives them (whitelist 22023,
//     tenant mismatch 42501). Other refusals are checked as "the call fails and
//     the row is unchanged", and not as "permission denied".
//   - `resealed` counts frozen rows resealed; `frozen` after success is not
//     asserted (stale-only versus all-matching is not defined by the brief).
//   - The pool in STARTER_TEST_DATABASE_URL is the migrator that owns the
//     function, so a direct UPDATE from it plays the "function owner" in the
//     trigger tests (a sanity check proves it).
//   - The new guard on apology_vouchers refuses a code_sealed change by the
//     owner too when the GUC is not set (brief: "hanya bila ... + GUC").
//   - `SELECT app.reseal_frozen_sealed(...)` without SET ROLE fails with
//     42501 "permission denied for function".
//
// Cases that already pass before the change are regression guards of the
// brief's "do not loosen" rule: the (c) refusals and the app-role part of (d).
//
// Fix 1198 (card legend-qwm9r, docs/briefs/sub-1198-reseal-so1196.md), written
// from the brief and the second opinion, not from the implementation:
//   - P1: the app login (pool `appPool`) can neither SET ROLE legend_sealed_reseal
//     nor EXECUTE the function, whatever tenant GUC it sets; no login of the app
//     is a member of the group. Only a dedicated login legend_reseal_<16 hex>
//     (member INHERIT TRUE, SET FALSE, no ADMIN) runs the function, without any
//     SET ROLE. The function reads the tenant from the target row: a p_tenant that
//     does not match the row raises 42501, an absent row returns 0. The GUC
//     app.tenant_id plays no part. The tests create that login by hand (the shared
//     test database is provisioned without it); provisioning of the real login is
//     covered in src/db/provision-roles-audit.test.ts.
//   - P2 row lock: a row held by another transaction makes the function return -1
//     (SELECT ... FOR NO KEY UPDATE SKIP LOCKED) at once instead of waiting.
// Assumption: "hung" is detected by a 15 s bound on the call; the correct
// behaviour answers in milliseconds, so the bound never decides a green test.
import { randomBytes, randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
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

// Config reads the environment when it loads, before the imports below run.
vi.hoisted(() => {
  const key = Buffer.alloc(32, 7).toString("base64");
  process.env.DATA_ENCRYPTION_KEYS = `2:${key}`;
  process.env.DATA_ENCRYPTION_ACTIVE_KEY_VERSION = "2";
});

import { uuidToUlid } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { pool as appPool } from "../db/index.ts";
import {
  openSecret,
  sealSecret,
  sealSecretBaseKey,
  sealedVersion,
} from "../lib/secrets.ts";
import {
  SEALED_SECRET_COLUMNS,
  runSealedSecretReseal,
  sealedSecretUnresolved,
  type SealedSecretResealResult,
} from "../worker/sealed-secret-reseal.job.ts";

const fixtureTenant = cafeLegendPlatformFixtures.tenant.id;
const tenantA = randomUUID();
const tenantB = randomUUID();
const tenants = [tenantA, tenantB];

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

// The dedicated reseal login (brief 1198, P1). Created by hand here with the
// shape the brief fixes: member of the group INHERIT TRUE, SET FALSE, no ADMIN,
// no other right.
const resealLogin = `legend_reseal_${randomBytes(8).toString("hex")}`;
const resealPassword = randomBytes(24).toString("hex");
let resealPool: Pool;

async function createResealLogin() {
  const database = decodeURIComponent(
    new URL(process.env.STARTER_TEST_DATABASE_URL as string).pathname.slice(1),
  );
  await owner.query(
    `CREATE ROLE "${resealLogin}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${resealPassword}'`,
  );
  await owner.query(
    `GRANT legend_sealed_reseal TO "${resealLogin}" WITH INHERIT TRUE, SET FALSE, ADMIN FALSE`,
  );
  await owner.query(
    `GRANT CONNECT ON DATABASE "${database}" TO "${resealLogin}"`,
  );
  const url = new URL(process.env.STARTER_TEST_DATABASE_URL as string);
  url.username = resealLogin;
  url.password = resealPassword;
  resealPool = new Pool({ connectionString: url.toString(), max: 3 });
}

async function dropResealLogin() {
  await resealPool?.end();
  const database = decodeURIComponent(
    new URL(process.env.STARTER_TEST_DATABASE_URL as string).pathname.slice(1),
  );
  await owner
    .query(`REVOKE CONNECT ON DATABASE "${database}" FROM "${resealLogin}"`)
    .catch(() => undefined);
  await owner
    .query(`REVOKE legend_sealed_reseal FROM "${resealLogin}"`)
    .catch(() => undefined);
  await owner
    .query(`DROP ROLE IF EXISTS "${resealLogin}"`)
    .catch(() => undefined);
}

type Settled<T> = { done: true; value: T } | { done: false };

/** Resolves with the value, or with `{ done: false }` when it is still pending after `ms`. */
async function settles<T>(
  promise: Promise<T>,
  ms = 15_000,
): Promise<Settled<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ done: true as const, value })),
      new Promise<{ done: false }>((resolve) => {
        timer = setTimeout(() => resolve({ done: false }), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Holds `SELECT ... FOR UPDATE` on one row in a second connection until released. */
async function lockRow(row: { kind: Kind; tenant: string; id: string }) {
  const client = await owner.connect();
  await client.query("BEGIN");
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
    [row.tenant],
  );
  await client.query(
    `SELECT id FROM public."${KINDS[row.kind].table}" WHERE id = $1 FOR UPDATE`,
    [row.id],
  );
  return {
    release: async () => {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    },
  };
}

// --- the four frozen columns ------------------------------------------------

type Kind = "orderLink" | "orderClaim" | "tender" | "voucher";
type KindSpec = {
  table: string;
  column: string;
  /** Value of the GUC the function sets and the trigger checks. */
  guc: string;
  idIsUlid: boolean;
  defaults: () => Record<string, unknown>;
  aad: (c: {
    tenant: string;
    id: string;
    ulid: string;
    voucher?: string;
  }) => string;
  /** A column other than the sealed one, and a value for it. */
  other: { column: string; value: string };
};

const orderDefaults = {
  channel: "pos",
  payment_mode: "pay_first",
  service_type: "dine_in",
  subtotal_idr: 0,
  discount_idr: 0,
  service_charge_idr: 0,
  tax_idr: 0,
  rounding_idr: 0,
  total_idr: 0,
  prices_include_tax: false,
};

const KINDS: Record<Kind, KindSpec> = {
  orderLink: {
    table: "orders",
    column: "payment_link_token_sealed",
    guc: "orders.payment_link_token_sealed",
    idIsUlid: true,
    defaults: () => ({
      ...orderDefaults,
      status: "completed",
      payment_link_id: randomUUID(),
    }),
    aad: (c) => `qr-order-payment-link:${c.tenant}:${c.ulid}`,
    other: { column: "note", value: "changed" },
  },
  orderClaim: {
    table: "orders",
    column: "claim_token_sealed",
    guc: "orders.claim_token_sealed",
    idIsUlid: true,
    defaults: () => ({
      ...orderDefaults,
      status: "completed",
      claim_token_hash: randomBytes(32).toString("hex"),
    }),
    aad: (c) => `order-claim:${c.tenant}:${c.ulid}`,
    other: { column: "note", value: "changed" },
  },
  tender: {
    table: "pos_order_tenders",
    column: "payment_link_token_sealed",
    guc: "pos_order_tenders.payment_link_token_sealed",
    idIsUlid: false,
    defaults: () => ({
      method: "qris",
      provider: "doit",
      status: "authorized",
      amount_idr: 1000,
      payment_link_id: randomUUID(),
    }),
    aad: (c) => `pos-order-payment-link:${c.tenant}:${c.id}`,
    other: { column: "reference", value: "changed" },
  },
  voucher: {
    table: "apology_vouchers",
    column: "code_sealed",
    guc: "apology_vouchers.code_sealed",
    idIsUlid: false,
    defaults: () => ({}),
    aad: (c) => `apology-voucher:${c.tenant}:${c.voucher}`,
    other: { column: "reason", value: "changed" },
  },
};
const KIND_NAMES = Object.keys(KINDS) as Kind[];
const keyOf = (kind: Kind) => `${KINDS[kind].table}.${KINDS[kind].column}`;

// --- database helpers (owner pool, fixtures only) ---------------------------

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

type Filler = { name: string; type: string; udt: string; max: number | null };
const fillerCache = new Map<string, Filler[]>();

async function requiredColumns(
  client: PoolClient,
  table: string,
): Promise<Filler[]> {
  const cached = fillerCache.get(table);
  if (cached) return cached;
  const { rows } = await client.query(
    `SELECT column_name, data_type, udt_name, character_maximum_length FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND is_nullable = 'NO'
        AND column_default IS NULL AND is_generated = 'NEVER' AND is_identity = 'NO'`,
    [table],
  );
  const found = rows.map((r) => ({
    name: String(r.column_name),
    type: String(r.data_type),
    udt: String(r.udt_name),
    max:
      r.character_maximum_length === null
        ? null
        : Number(r.character_maximum_length),
  }));
  fillerCache.set(table, found);
  return found;
}

async function fillValue(client: PoolClient, f: Filler): Promise<unknown> {
  switch (f.type) {
    case "uuid":
      return randomUUID();
    case "text":
    case "character varying":
    case "character":
      return `s${randomUUID()
        .replaceAll("-", "")
        .slice(0, Math.max((f.max ?? 12) - 1, 1))}`;
    case "integer":
    case "smallint":
    case "bigint":
    case "numeric":
      return 1;
    case "boolean":
      return false;
    case "date":
      return "2026-01-01";
    case "timestamp with time zone":
    case "timestamp without time zone":
      return new Date();
    case "jsonb":
    case "json":
      return "{}";
    case "bytea":
      return Buffer.from([1]);
    case "ARRAY":
      return "{}";
    case "USER-DEFINED": {
      const { rows } = await client.query(
        `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = $1 ORDER BY e.enumsortorder LIMIT 1`,
        [f.udt],
      );
      return rows[0]?.enumlabel;
    }
    default:
      throw new Error(`no filler for ${f.type}`);
  }
}

const touched: { table: string; id: string; tenant: string }[] = [];

type Seeded = {
  kind: Kind;
  tenant: string;
  id: string;
  plain: string;
  aad: string;
  /** What was written, base64 of the envelope. */
  sealed: string;
};
type SeedOptions = {
  tenant?: string;
  /** Seal under the active version (2) instead of the old one (1). */
  current?: boolean;
  /** Seal under this AAD instead of the writer's (a row that cannot open). */
  aadOverride?: string;
  /** Parent order status for orders and tenders; default "completed". "sent" is not frozen. */
  status?: "completed" | "voided" | "sent";
};

async function insertRow(
  table: string,
  tenant: string,
  values: Record<string, unknown>,
) {
  await asOwner(tenant, async (client) => {
    for (const f of await requiredColumns(client, table))
      if (!(f.name in values)) values[f.name] = await fillValue(client, f);
    const names = Object.keys(values);
    await client.query(
      `INSERT INTO public."${table}" (${names.map((n) => `"${n}"`).join(", ")})
       VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      names.map((n) => values[n]),
    );
  });
  touched.push({ table, id: String(values.id), tenant });
}

/** A frozen row: completed/voided order, tender of such an order, or voucher. */
async function seedFrozen(
  kind: Kind,
  options: SeedOptions = {},
): Promise<Seeded> {
  const spec = KINDS[kind];
  const tenant = options.tenant ?? tenantA;
  const id = randomUUID();
  const voucher = randomUUID();
  const aad =
    options.aadOverride ??
    spec.aad({
      tenant,
      id,
      ulid: spec.idIsUlid ? uuidToUlid(id) : id,
      voucher,
    });
  const plain = `plain-${randomBytes(9).toString("hex")}`;
  const sealed = options.current
    ? sealSecret(plain, aad)
    : sealSecretBaseKey(plain, aad);

  const values: Record<string, unknown> = {
    id,
    tenant_id: tenant,
    ...spec.defaults(),
    [spec.column]: sealed,
  };
  if (kind === "voucher") values.voucher_id = voucher;
  if (kind === "orderLink" || kind === "orderClaim")
    values.status = options.status ?? "completed";
  if (kind === "tender") {
    // Parent order frozen, its own sealed token already current so that only
    // the tender is stale.
    const parent = randomUUID();
    await insertRow("orders", tenant, {
      id: parent,
      tenant_id: tenant,
      ...orderDefaults,
      status: options.status ?? "completed",
      claim_token_hash: randomBytes(32).toString("hex"),
      claim_token_sealed: sealSecret(
        "parent",
        `order-claim:${tenant}:${uuidToUlid(parent)}`,
      ),
    });
    values.order_id = parent;
  }
  await insertRow(spec.table, tenant, values);
  return { kind, tenant, id, plain, aad, sealed };
}

async function storedSealed(row: Seeded): Promise<string> {
  const { table, column } = KINDS[row.kind];
  return asOwner(row.tenant, async (client) => {
    const { rows } = await client.query(
      `SELECT "${column}" AS sealed FROM public."${table}" WHERE id = $1`,
      [row.id],
    );
    return String(rows[0]?.sealed);
  });
}

/** Every column of the row except the sealed one, as JSON. */
async function others(row: Seeded): Promise<unknown> {
  const { table, column } = KINDS[row.kind];
  return asOwner(row.tenant, async (client) => {
    const { rows } = await client.query(
      `SELECT to_jsonb(t) - $2::text AS j FROM public."${table}" t WHERE id = $1`,
      [row.id, column],
    );
    return rows[0]?.j;
  });
}

async function otherValue(row: Seeded): Promise<unknown> {
  const { table, other } = KINDS[row.kind];
  return asOwner(row.tenant, async (client) => {
    const { rows } = await client.query(
      `SELECT "${other.column}" AS v FROM public."${table}" WHERE id = $1`,
      [row.id],
    );
    return rows[0]?.v;
  });
}

// --- the job ----------------------------------------------------------------

function columnsFor(kinds: Kind[]) {
  return kinds.map((kind) => {
    const c = SEALED_SECRET_COLUMNS.find(
      (x) => `${x.table}.${x.column}` === keyOf(kind),
    );
    if (!c) throw new Error(`registry has no ${keyOf(kind)}`);
    return c;
  });
}

async function run(
  kinds: Kind[],
  options: {
    tenantIds?: string[];
    batchSize?: number;
    reportOnly?: boolean;
    /** Default: the reseal login's pool. `false` = no resealDatabase at all. */
    resealDatabase?: false;
    log?: {
      error: (m: string) => void;
      warn?: (m: string) => void;
      info?: (m: string) => void;
    };
  } = {},
): Promise<SealedSecretResealResult> {
  return runSealedSecretReseal({
    columns: columnsFor(kinds),
    listTenantIds: async () => options.tenantIds ?? [tenantA],
    batchSize: options.batchSize ?? 2,
    log: options.log ?? { error: () => {} },
    ...(options.resealDatabase === false
      ? {}
      : { resealDatabase: drizzle(resealPool) }),
    ...(options.reportOnly ? { reportOnly: true } : {}),
  } as Parameters<typeof runSealedSecretReseal>[0]);
}

async function clearState() {
  await owner.query(
    "DELETE FROM sealed_secret_reseal_state WHERE scope_key = ANY($1) OR scope_key = 'global'",
    [tenants],
  );
}

// --- calling the function / raw statements as a login -----------------------

type Outcome =
  { ok: true; n: number } | { ok: false; code: string; message: string };
type Call = {
  table: string;
  column: string;
  tenant: string | null;
  id: string;
  expected: string | null;
  next: string | null;
};

/**
 * One transaction. `as` = "reseal" (default) is the dedicated reseal login, which
 * calls the function directly; `as` = "app" is the application login (appPool).
 * `guc` is the tenant the session runs under (default: the call's own tenant for
 * the app login, none for the reseal login; null = not set). `setRole` runs
 * SET LOCAL ROLE legend_sealed_reseal first. A refused SET ROLE is an outcome
 * (it is what the app login must get), not a setup error.
 */
async function callReseal(
  call: Call,
  options: {
    as?: "reseal" | "app";
    guc?: string | null;
    setRole?: boolean;
  } = {},
): Promise<Outcome> {
  const as = options.as ?? "reseal";
  const client = await (as === "reseal" ? resealPool : appPool).connect();
  try {
    await client.query("BEGIN");
    const guc =
      "guc" in options ? options.guc : as === "app" ? call.tenant : null;
    if (guc !== null && guc !== undefined)
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [guc],
      );
    try {
      if (options.setRole)
        await client.query("SET LOCAL ROLE legend_sealed_reseal");
      const { rows } = await client.query(
        "SELECT app.reseal_frozen_sealed($1::text, $2::text, $3::uuid, $4::uuid, $5::text, $6::text) AS n",
        [
          call.table,
          call.column,
          call.tenant,
          call.id,
          call.expected,
          call.next,
        ],
      );
      await client.query("COMMIT");
      return { ok: true, n: Number(rows[0]?.n) };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      await client.query("ROLLBACK");
      return {
        ok: false,
        code: String(e.code),
        message: String(e.message),
      };
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function callFor(
  row: Seeded,
  next: string | null,
  overrides: Partial<Call> = {},
): Call {
  const spec = KINDS[row.kind];
  return {
    table: spec.table,
    column: spec.column,
    tenant: row.tenant,
    id: row.id,
    expected: row.sealed,
    next,
    ...overrides,
  };
}

/** A fresh envelope of the row's own plaintext under the active key. */
const resealed = (row: Seeded) => sealSecret(row.plain, row.aad);

/**
 * Plain statements in one transaction as `who`, under the row's tenant, with the
 * GUC `app.sealed_reseal_column` set to `guc` when given. Triggers are active.
 */
async function execAs(
  who: "owner" | "app",
  tenant: string,
  statements: [string, unknown[]][],
  guc?: string,
): Promise<
  { ok: true; rowCount: number } | { ok: false; code: string; message: string }
> {
  const client = await (who === "owner" ? owner : appPool).connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
    );
    if (guc !== undefined)
      await client.query(
        "SELECT set_config('app.sealed_reseal_column', $1, true)",
        [guc],
      );
    let rowCount = 0;
    try {
      for (const [text, params] of statements) {
        const result = await client.query(text, params);
        rowCount = result.rowCount ?? 0;
      }
      await client.query("COMMIT");
      return { ok: true, rowCount };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      await client.query("ROLLBACK");
      return { ok: false, code: String(e.code), message: String(e.message) };
    }
  } finally {
    client.release();
  }
}

const update = (
  row: Seeded,
  column: string,
  value: string,
): [string, unknown[]] => [
  `UPDATE public."${KINDS[row.kind].table}" SET "${column}" = $1 WHERE id = $2`,
  [value, row.id],
];

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await createResealLogin();
  for (const tenant of tenants)
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Frozen reseal tenant', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [tenant, `frozen-reseal-${tenant.slice(0, 8)}`, fixtureTenant],
    );
});

beforeEach(clearState);

afterEach(async () => {
  // Children first: tenders before their parent orders.
  const rows = touched.splice(0).reverse();
  for (const row of rows)
    await asOwner(row.tenant, (client) =>
      client.query(`DELETE FROM public."${row.table}" WHERE id = $1`, [row.id]),
    ).catch(() => undefined);
});

afterAll(async () => {
  await clearState();
  for (const tenant of tenants)
    await asOwner(tenant, (client) =>
      client.query("DELETE FROM tenants WHERE id = $1", [tenant]),
    );
  await dropResealLogin();
  await owner.end();
});

// --- (a) + (e): the job ------------------------------------------------------

describe("[legend-4vfmn] (a) the job reseals frozen rows", () => {
  for (const kind of KIND_NAMES)
    it(`${keyOf(kind)}: stale frozen row moves to the active key, same plaintext and AAD, other columns untouched`, async () => {
      const row = await seedFrozen(kind);
      expect(sealedVersion(row.sealed)).toBe(1);
      const before = await others(row);

      const result = await run([kind]);

      expect(result).toMatchObject({ failedTenants: 0, aborted: false });
      expect(result.tables[keyOf(kind)]).toMatchObject({
        resealed: 1,
        failed: 0,
        remaining: 0,
      });
      expect(sealedSecretUnresolved(result)).toBe(0);

      const after = await storedSealed(row);
      expect(sealedVersion(after)).toBe(2);
      expect(after).not.toBe(row.sealed);
      expect(openSecret(after, row.aad)).toBe(row.plain);
      expect(() => openSecret(after, `${row.aad}:other`)).toThrow();
      expect(await others(row)).toEqual(before);
    });

  for (const kind of ["orderLink", "orderClaim", "tender"] as const)
    it(`${keyOf(kind)}: a voided order's row is resealed too`, async () => {
      const completed = await seedFrozen(kind);
      const voided = await seedFrozen(kind, { status: "voided" });
      const result = await run([kind]);
      expect(result.tables[keyOf(kind)]).toMatchObject({
        resealed: 2,
        failed: 0,
        remaining: 0,
      });
      for (const row of [completed, voided]) {
        const after = await storedSealed(row);
        expect(sealedVersion(after)).toBe(2);
        expect(openSecret(after, row.aad)).toBe(row.plain);
      }
    });

  for (const kind of KIND_NAMES)
    it(`${keyOf(kind)}: a frozen row already on the active key is left alone`, async () => {
      const row = await seedFrozen(kind, { current: true });
      const result = await run([kind]);
      expect(result.tables[keyOf(kind)]).toMatchObject({
        resealed: 0,
        failed: 0,
        remaining: 0,
      });
      expect(await storedSealed(row)).toBe(row.sealed);
    });

  it("walks more frozen rows than one batch (cursor of the frozen pass) and a second run changes nothing", async () => {
    const rows = [
      await seedFrozen("voucher"),
      await seedFrozen("voucher"),
      await seedFrozen("voucher"),
    ];
    const first = await run(["voucher"], { batchSize: 1 });
    expect(first.tables[keyOf("voucher")]).toMatchObject({
      resealed: 3,
      failed: 0,
      remaining: 0,
    });
    const afterFirst = await Promise.all(rows.map(storedSealed));
    for (const [i, row] of rows.entries()) {
      expect(sealedVersion(afterFirst[i]!)).toBe(2);
      expect(openSecret(afterFirst[i]!, row.aad)).toBe(row.plain);
    }

    await clearState();
    const second = await run(["voucher"], { batchSize: 1 });
    expect(second.tables[keyOf("voucher")]).toMatchObject({
      resealed: 0,
      failed: 0,
      remaining: 0,
    });
    expect(await Promise.all(rows.map(storedSealed))).toEqual(afterFirst);
  });

  it("a frozen row that will not open is counted failed and left as written; the rest of the column still moves", async () => {
    const good = await seedFrozen("orderClaim");
    const bad = await seedFrozen("orderClaim", {
      aadOverride: "order-claim:wrong:binding",
    });
    const alsoGood = await seedFrozen("orderClaim");
    const result = await run(["orderClaim"], { batchSize: 1 });
    expect(result).toMatchObject({ aborted: false });
    expect(result.tables[keyOf("orderClaim")]).toMatchObject({
      resealed: 2,
      failed: 1,
      remaining: 1,
    });
    expect(await storedSealed(bad)).toBe(bad.sealed);
    for (const row of [good, alsoGood]) {
      const after = await storedSealed(row);
      expect(sealedVersion(after)).toBe(2);
      expect(openSecret(after, row.aad)).toBe(row.plain);
    }
  });
});

describe("[legend-4vfmn] (e) remaining counts frozen rows, then reaches 0", () => {
  it("a report-only run counts them as remaining and changes nothing; a real run brings remaining to 0", async () => {
    const rows = [
      await seedFrozen("orderLink"),
      await seedFrozen("orderLink", { status: "voided" }),
    ];

    const report = await run(["orderLink"], { reportOnly: true });
    expect(report.tables[keyOf("orderLink")]).toMatchObject({
      resealed: 0,
      remaining: 2,
    });
    expect(sealedSecretUnresolved(report)).toBe(2);
    for (const row of rows) expect(await storedSealed(row)).toBe(row.sealed);

    const real = await run(["orderLink"]);
    expect(real.tables[keyOf("orderLink")]).toMatchObject({
      resealed: 2,
      failed: 0,
      remaining: 0,
    });
    expect(sealedSecretUnresolved(real)).toBe(0);

    await clearState();
    const verify = await run(["orderLink"], { reportOnly: true });
    expect(sealedSecretUnresolved(verify)).toBe(0);
  });

  it("all four frozen columns in one run: nothing is left, so the old key may retire", async () => {
    const rows = await Promise.all(KIND_NAMES.map((k) => seedFrozen(k)));
    const result = await run(KIND_NAMES);
    expect(result).toMatchObject({ failedTenants: 0, aborted: false });
    expect(sealedSecretUnresolved(result)).toBe(0);
    for (const row of rows) {
      const after = await storedSealed(row);
      expect(sealedVersion(after)).toBe(2);
      expect(openSecret(after, row.aad)).toBe(row.plain);
    }
  });
});

// --- (f) tenant isolation of the job ----------------------------------------

describe("[legend-4vfmn] (f) the job keeps tenants apart", () => {
  it("a run for tenant A leaves tenant B's frozen rows alone; a run for B then moves them", async () => {
    const mine = await Promise.all(KIND_NAMES.map((k) => seedFrozen(k)));
    const theirs = await Promise.all(
      KIND_NAMES.map((k) => seedFrozen(k, { tenant: tenantB })),
    );

    const first = await run(KIND_NAMES, { tenantIds: [tenantA] });
    expect(sealedSecretUnresolved(first)).toBe(0);
    for (const row of mine)
      expect(sealedVersion(await storedSealed(row))).toBe(2);
    for (const row of theirs) expect(await storedSealed(row)).toBe(row.sealed);

    await clearState();
    const second = await run(KIND_NAMES, { tenantIds: [tenantB] });
    expect(sealedSecretUnresolved(second)).toBe(0);
    for (const row of theirs) {
      const after = await storedSealed(row);
      expect(sealedVersion(after)).toBe(2);
      expect(openSecret(after, row.aad)).toBe(row.plain);
    }
  });
});

// --- (d) + (b) + (f): the function ------------------------------------------

describe("[legend-4vfmn] (d) who may run the function", () => {
  const signature =
    "app.reseal_frozen_sealed(text, text, uuid, uuid, text, text)";

  it("is SECURITY DEFINER with a pinned search_path and executable by legend_sealed_reseal only", async () => {
    const { rows } = await owner.query(
      `SELECT p.prosecdef AS definer, p.provolatile AS volatility,
              pg_get_function_result(p.oid) AS result,
              p.proconfig AS config,
              has_function_privilege('legend_sealed_reseal', p.oid, 'EXECUTE') AS group_may,
              has_function_privilege('legend_app', p.oid, 'EXECUTE') AS app_may,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_may,
              pg_get_userbyid(p.proowner) = current_user AS owned_by_test_owner
         FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
      [signature],
    );
    expect(rows).toHaveLength(1);
    const fn = rows[0];
    expect(fn).toMatchObject({
      definer: true,
      volatility: "v",
      result: "integer",
      group_may: true,
      app_may: false,
      public_may: false,
      // Sanity for the trigger tests below: the owner pool plays the owner.
      owned_by_test_owner: true,
    });
    expect(String(fn.config)).toMatch(/search_path=pg_catalog, pg_temp/);
  });

  it("legend_sealed_reseal: NOLOGIN, no superuser, no BYPASSRLS, NOINHERIT; legend_app is NOT a member and cannot SET ROLE to it", async () => {
    const role = await owner.query(
      `SELECT rolcanlogin, rolsuper, rolbypassrls, rolinherit FROM pg_roles WHERE rolname = 'legend_sealed_reseal'`,
    );
    expect(role.rows).toEqual([
      {
        rolcanlogin: false,
        rolsuper: false,
        rolbypassrls: false,
        rolinherit: false,
      },
    ]);
    const app = await owner.query(
      `SELECT pg_has_role('legend_app', 'legend_sealed_reseal', 'MEMBER') AS member,
              pg_has_role('legend_app', 'legend_sealed_reseal', 'USAGE') AS usage,
              pg_has_role('legend_app', 'legend_sealed_reseal', 'SET') AS can_set`,
    );
    expect(app.rows).toEqual([{ member: false, usage: false, can_set: false }]);
  });

  it("the dedicated reseal login is a member INHERIT TRUE, SET FALSE, without ADMIN", async () => {
    const member = await owner.query(
      `SELECT inherit_option AS inherit, set_option AS set, admin_option AS admin
         FROM pg_auth_members
        WHERE roleid = 'legend_sealed_reseal'::regrole AND member = $1::regrole`,
      [resealLogin],
    );
    expect(member.rows).toEqual([{ inherit: true, set: false, admin: false }]);
    expect(resealLogin).toMatch(/^legend_reseal_[a-f0-9]{16}$/);
  });

  it("the group holds the schema USAGE and no table rights at all", async () => {
    const { rows } = await owner.query(
      `SELECT has_schema_privilege('legend_sealed_reseal', 'app', 'USAGE') AS usage,
              (SELECT bool_or(has_table_privilege('legend_sealed_reseal', format('public.%I', t), p))
                 FROM unnest(ARRAY['orders','pos_order_tenders','apology_vouchers']) AS t,
                      unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p) AS any_table_right`,
    );
    expect(rows[0]).toEqual({ usage: true, any_table_right: false });
  });

  it("the plain application login (no SET ROLE) cannot EXECUTE it", async () => {
    const row = await seedFrozen("orderClaim");
    const outcome = await callReseal(callFor(row, resealed(row)), {
      as: "app",
    });
    expect(outcome).toMatchObject({ ok: false, code: "42501" });
    expect((outcome as { message: string }).message).toMatch(
      /permission denied for function/i,
    );
    expect(await storedSealed(row)).toBe(row.sealed);
  });

  it("legend_app keeps no table right on the frozen tables that the job could have used instead", async () => {
    const { rows } = await owner.query(
      `SELECT has_table_privilege('legend_app', 'public.apology_vouchers', 'UPDATE') AS voucher_update,
              has_table_privilege('legend_app', 'public.apology_vouchers', 'DELETE') AS voucher_delete`,
    );
    expect(rows[0]).toEqual({ voucher_update: false, voucher_delete: false });
  });

  it("the reseal login calls it directly (no SET ROLE) for every frozen column, once (compare-and-set)", async () => {
    for (const kind of KIND_NAMES) {
      const row = await seedFrozen(kind);
      const next = resealed(row);
      expect(await callReseal(callFor(row, next))).toEqual({ ok: true, n: 1 });
      const after = await storedSealed(row);
      expect(after).toBe(next);
      expect(openSecret(after, row.aad)).toBe(row.plain);
      // The stored value is no longer the expected one: the second call loses.
      expect(await callReseal(callFor(row, resealed(row)))).toEqual({
        ok: true,
        n: 0,
      });
      expect(await storedSealed(row)).toBe(next);
    }
  });

  it("a row id that does not exist changes nothing and returns 0", async () => {
    const row = await seedFrozen("orderClaim");
    const outcome = await callReseal(
      callFor(row, resealed(row), { id: randomUUID() }),
    );
    expect(outcome).toEqual({ ok: true, n: 0 });
    expect(await storedSealed(row)).toBe(row.sealed);
  });
});

describe("[legend-4vfmn] (b) what the function refuses", () => {
  const notPermission = /permission denied/i;

  it("refuses a table/column pair outside the four, with 22023", async () => {
    const row = await seedFrozen("orderClaim");
    const next = resealed(row);
    const pairs: [string, string][] = [
      ["orders", "note"],
      ["orders", "subtotal_idr"],
      ["orders", "status"],
      ["pos_order_tenders", "amount_idr"],
      ["apology_vouchers", "reason"],
      // sealed, but not frozen: they have their own, normal path
      ["tables", "qr_token_sealed"],
      ["shareholders", "npwp_sealed"],
      // not a column of that table
      ["pos_order_tenders", "claim_token_sealed"],
      ["orders", "orders; DROP TABLE orders"],
      ["orders; SELECT 1", "claim_token_sealed"],
      ["", ""],
    ];
    for (const [table, column] of pairs) {
      const outcome = await callReseal(callFor(row, next, { table, column }));
      expect(outcome, `${table}.${column}`).toMatchObject({
        ok: false,
        code: "22023",
      });
      expect((outcome as { message: string }).message).not.toMatch(
        notPermission,
      );
    }
    expect(await storedSealed(row)).toBe(row.sealed);
  });

  it("refuses empty, null, unchanged and non-base64 values and leaves the row as written", async () => {
    const row = await seedFrozen("orderClaim");
    const next = resealed(row);
    const bad: [string, Partial<Call>][] = [
      ["null expected", { expected: null }],
      ["null new", { next: null }],
      ["empty expected", { expected: "" }],
      ["empty new", { next: "" }],
      ["new equals expected", { next: row.sealed }],
      ["new is not base64", { next: "!!!!not-base64!!!!" }],
      ["expected is not base64", { expected: "!!!!not-base64!!!!" }],
    ];
    for (const [label, overrides] of bad) {
      const outcome = await callReseal(callFor(row, next, overrides));
      expect(outcome, label).toMatchObject({ ok: false });
      expect((outcome as { message: string }).message, label).not.toMatch(
        notPermission,
      );
      expect(await storedSealed(row), label).toBe(row.sealed);
    }
  });

  // Review fix M1: p_new must be a complete base64 envelope (>= 29 bytes), of the
  // same decoded length as p_expected, with a version byte that does not go down.
  it("refuses a new value that is short garbage (fewer than 29 decoded bytes)", async () => {
    const row = await seedFrozen("orderClaim");
    const short: [string, string][] = [
      ["1 byte", Buffer.from([2]).toString("base64")],
      ["10 bytes", Buffer.alloc(10, 2).toString("base64")],
      ["28 bytes", Buffer.alloc(28, 2).toString("base64")],
    ];
    for (const [label, next] of short) {
      const outcome = await callReseal(callFor(row, next));
      expect(outcome, label).toMatchObject({ ok: false, code: "22023" });
      expect(await storedSealed(row), label).toBe(row.sealed);
    }
  });

  it("refuses a new value of another length than the expected one, even with a higher version", async () => {
    const row = await seedFrozen("orderClaim");
    expect(sealedVersion(row.sealed)).toBe(1);
    const longer = sealSecret(`${row.plain}x`, row.aad);
    const shorter = sealSecret(row.plain.slice(0, -1), row.aad);
    for (const [label, next] of [
      ["longer", longer],
      ["shorter", shorter],
    ] as const) {
      expect(sealedVersion(next), label).toBe(2);
      const outcome = await callReseal(callFor(row, next));
      expect(outcome, label).toMatchObject({ ok: false, code: "22023" });
      expect(await storedSealed(row), label).toBe(row.sealed);
    }
  });

  it("refuses a new value that is incomplete base64 or has other characters", async () => {
    const row = await seedFrozen("orderClaim");
    const good = resealed(row);
    const bad: [string, string][] = [
      ["last character cut off", good.slice(0, -1)],
      ["truncated to a multiple of 4", good.slice(0, 40)],
      ["extra padding", `${good}==`],
      ["trailing garbage", `${good}!!`],
      ["hyphen inside", `${good.slice(0, 10)}-${good.slice(11)}`],
      ["whitespace inside", `${good.slice(0, 12)} ${good.slice(12)}`],
      ["newline at the end", `${good}\n`],
      ["leading space", ` ${good}`],
    ];
    for (const [label, next] of bad) {
      const outcome = await callReseal(callFor(row, next));
      expect(outcome, label).toMatchObject({ ok: false, code: "22023" });
      expect(await storedSealed(row), label).toBe(row.sealed);
    }
  });

  it("still accepts a proper reseal: same length, version up", async () => {
    const row = await seedFrozen("orderClaim");
    const next = resealed(row);
    expect(sealedVersion(next)).toBeGreaterThan(sealedVersion(row.sealed));
    expect(Buffer.from(next, "base64").length).toBe(
      Buffer.from(row.sealed, "base64").length,
    );
    expect(await callReseal(callFor(row, next))).toEqual({ ok: true, n: 1 });
    expect(await storedSealed(row)).toBe(next);
  });

  it("refuses a new value whose envelope version is lower than the expected one; equal or higher is allowed", async () => {
    // A row already on version 2 (the active one).
    const row = await seedFrozen("voucher", { current: true });
    const down = sealSecretBaseKey(row.plain, row.aad);
    expect(sealedVersion(down)).toBe(1);
    const refused = await callReseal(callFor(row, down));
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { message: string }).message).not.toMatch(notPermission);
    expect(await storedSealed(row)).toBe(row.sealed);

    // Same version, fresh nonce: not a downgrade.
    const sameVersion = sealSecret(row.plain, row.aad);
    expect(sealedVersion(sameVersion)).toBe(2);
    expect(await callReseal(callFor(row, sameVersion))).toEqual({
      ok: true,
      n: 1,
    });
    expect(await storedSealed(row)).toBe(sameVersion);
  });

  it("only ever writes the sealed column: the job's reseal cannot alter the plaintext it carries", async () => {
    // The function never sees a key, so it cannot compare plaintext. The job
    // does: it opens the old value and seals that same plaintext. Proof here:
    // after a job run the opened plaintext of every frozen kind is identical.
    const rows = await Promise.all(KIND_NAMES.map((k) => seedFrozen(k)));
    await run(KIND_NAMES);
    for (const row of rows)
      expect(openSecret(await storedSealed(row), row.aad)).toBe(row.plain);
  });
});

describe("[legend-4vfmn][legend-qwm9r] (f) the function keeps tenants apart by the row's own tenant", () => {
  it("refuses a p_tenant that is not the row's tenant (42501), for every frozen column, and changes nothing", async () => {
    for (const kind of KIND_NAMES) {
      const theirs = await seedFrozen(kind, { tenant: tenantB });
      // The session claims tenant A, which equals p_tenant: only the row's own
      // tenant (B) can make this fail. (The old function trusted the session GUC
      // and would have answered 0 here.)
      const outcome = await callReseal(
        callFor(theirs, resealed(theirs), { tenant: tenantA }),
        { guc: tenantA },
      );
      expect(outcome, kind).toMatchObject({ ok: false, code: "42501" });
      expect((outcome as { message: string }).message, kind).not.toMatch(
        /permission denied for function/i,
      );
      expect(await storedSealed(theirs), kind).toBe(theirs.sealed);
    }
  });

  it("the transaction tenant GUC plays no part: a session that claims another tenant, or none, still reseals a row whose p_tenant is right", async () => {
    const mine = await seedFrozen("voucher", { tenant: tenantB });
    const other = await seedFrozen("orderClaim", { tenant: tenantB });
    const next = resealed(mine);
    expect(await callReseal(callFor(mine, next), { guc: tenantA })).toEqual({
      ok: true,
      n: 1,
    });
    expect(await storedSealed(mine)).toBe(next);
    const nextOther = resealed(other);
    expect(await callReseal(callFor(other, nextOther), { guc: null })).toEqual({
      ok: true,
      n: 1,
    });
    expect(await storedSealed(other)).toBe(nextOther);
  });

  it("an absent row id returns 0 even for a p_tenant that no row of that id has", async () => {
    const row = await seedFrozen("tender");
    const outcome = await callReseal(
      callFor(row, resealed(row), { id: randomUUID(), tenant: tenantB }),
    );
    expect(outcome).toEqual({ ok: true, n: 0 });
    expect(await storedSealed(row)).toBe(row.sealed);
  });
});

// --- P1 (second opinion 1196): a compromised app login cannot reach the door --

describe("[legend-qwm9r] P1 the application login cannot reach the reseal door", () => {
  // Attack from the second opinion: the app login sets app.tenant_id to tenant B
  // and outlet_ids '*', reads B's ciphertext, then SET ROLE legend_sealed_reseal
  // and calls the function with B and a junk envelope of the same length and a
  // version that does not go down. It must be refused, for every frozen column.
  const junkFor = (sealed: string) => {
    const bytes = Buffer.from(sealed, "base64");
    bytes[0] = 9;
    return bytes.toString("base64");
  };

  for (const kind of KIND_NAMES)
    it(`${keyOf(kind)}: SET ROLE legend_sealed_reseal is refused for the app login claiming tenant B, and the junk envelope is not written`, async () => {
      const theirs = await seedFrozen(kind, { tenant: tenantB });
      const outcome = await callReseal(
        callFor(theirs, junkFor(theirs.sealed)),
        { as: "app", guc: tenantB, setRole: true },
      );
      expect(outcome).toMatchObject({ ok: false, code: "42501" });
      expect((outcome as { message: string }).message).toMatch(
        /permission denied to set role/i,
      );
      expect(await storedSealed(theirs)).toBe(theirs.sealed);
    });

  it("EXECUTE on the function is refused for the app login claiming tenant B (no SET ROLE)", async () => {
    const theirs = await seedFrozen("voucher", { tenant: tenantB });
    const outcome = await callReseal(callFor(theirs, junkFor(theirs.sealed)), {
      as: "app",
      guc: tenantB,
    });
    expect(outcome).toMatchObject({ ok: false, code: "42501" });
    expect((outcome as { message: string }).message).toMatch(
      /permission denied for function/i,
    );
    expect(await storedSealed(theirs)).toBe(theirs.sealed);
  });

  it("the reseal login itself cannot SET ROLE to the group either (SET FALSE)", async () => {
    const row = await seedFrozen("orderLink");
    const outcome = await callReseal(callFor(row, resealed(row)), {
      setRole: true,
    });
    expect(outcome).toMatchObject({ ok: false, code: "42501" });
    expect(await storedSealed(row)).toBe(row.sealed);
  });

  for (const kind of KIND_NAMES)
    it(`${keyOf(kind)}: the reseal login reseals tenant B's row without changing the plaintext or any other column`, async () => {
      const theirs = await seedFrozen(kind, { tenant: tenantB });
      const before = await others(theirs);
      const next = resealed(theirs);
      expect(await callReseal(callFor(theirs, next))).toEqual({
        ok: true,
        n: 1,
      });
      const after = await storedSealed(theirs);
      expect(after).toBe(next);
      expect(sealedVersion(after)).toBe(2);
      expect(openSecret(after, theirs.aad)).toBe(theirs.plain);
      expect(await others(theirs)).toEqual(before);
    });
});

// --- P2 row lock ------------------------------------------------------------

describe("[legend-qwm9r] P2 a row held by another transaction is skipped, not waited for", () => {
  it("the function returns -1 at once for a locked row, leaves it as written, and works after the lock is gone", async () => {
    const row = await seedFrozen("orderClaim");
    const next = resealed(row);
    const lock = await lockRow(row);
    let pending: Promise<Outcome> | undefined;
    let snapshot: string | undefined;
    let settled: Settled<Outcome> = { done: false };
    try {
      // The session GUC is set to the row's tenant so that the old function, which
      // checked it, reached its UPDATE and waited for the lock (red for the lock).
      pending = callReseal(callFor(row, next), { guc: row.tenant });
      settled = await settles(pending);
      snapshot = await storedSealed(row);
    } finally {
      await lock.release();
      await pending?.catch(() => undefined);
    }
    expect(settled.done, "the call must not wait for the lock").toBe(true);
    expect(settled.done && settled.value).toEqual({ ok: true, n: -1 });
    expect(snapshot).toBe(row.sealed);

    expect(await callReseal(callFor(row, next), { guc: row.tenant })).toEqual({
      ok: true,
      n: 1,
    });
    expect(await storedSealed(row)).toBe(next);
  });

  it("0 still means the compare-and-set lost, not busy: an unlocked row with another stored value", async () => {
    const row = await seedFrozen("voucher");
    const stale = sealSecretBaseKey(row.plain, row.aad);
    expect(stale).not.toBe(row.sealed);
    expect(
      await callReseal(callFor(row, resealed(row), { expected: stale }), {
        guc: row.tenant,
      }),
    ).toEqual({ ok: true, n: 0 });
    expect(await storedSealed(row)).toBe(row.sealed);
  });
});

// --- (c) the triggers and the append-only rule stay -------------------------

describe("[legend-4vfmn] (c) other columns of a frozen row stay frozen", () => {
  for (const kind of KIND_NAMES) {
    const spec = KINDS[kind];

    it(`${keyOf(kind)}: the application login cannot change another column, with or without the GUC`, async () => {
      const row = await seedFrozen(kind);
      const before = await otherValue(row);
      for (const guc of [
        undefined,
        spec.guc,
        `${spec.table}.${spec.other.column}`,
      ]) {
        const outcome = await execAs(
          "app",
          row.tenant,
          [update(row, spec.other.column, spec.other.value)],
          guc,
        );
        expect(outcome.ok, `guc=${guc}`).toBe(false);
        expect(await otherValue(row), `guc=${guc}`).toBe(before);
      }
    });

    it(`${keyOf(kind)}: the application login cannot write the sealed column itself, even with the GUC set by hand`, async () => {
      const row = await seedFrozen(kind);
      const next = resealed(row);
      for (const guc of [undefined, spec.guc]) {
        const outcome = await execAs(
          "app",
          row.tenant,
          [update(row, spec.column, next)],
          guc,
        );
        expect(outcome.ok, `guc=${guc}`).toBe(false);
        expect(await storedSealed(row)).toBe(row.sealed);
      }
    });

    it(`${keyOf(kind)}: a row cannot be deleted by the application login`, async () => {
      const row = await seedFrozen(kind);
      const outcome = await execAs(
        "app",
        row.tenant,
        [[`DELETE FROM public."${spec.table}" WHERE id = $1`, [row.id]]],
        spec.guc,
      );
      expect(outcome.ok).toBe(false);
      expect(await storedSealed(row)).toBe(row.sealed);
    });

    it(`${keyOf(kind)}: the reseal login has no table right: neither UPDATE nor SELECT, GUC set by hand or not`, async () => {
      const row = await seedFrozen(kind);
      const client = await resealPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true), set_config('app.sealed_reseal_column', $2, true)",
          [row.tenant, spec.guc],
        );
        await expect(
          client.query(
            `UPDATE public."${spec.table}" SET "${spec.column}" = $1 WHERE id = $2`,
            [resealed(row), row.id],
          ),
        ).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK");
        await client.query("BEGIN");
        await expect(
          client.query(`SELECT id FROM public."${spec.table}" WHERE id = $1`, [
            row.id,
          ]),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      expect(await storedSealed(row)).toBe(row.sealed);
    });
  }

  // The trigger itself (orders, tenders): the owner of the function is the only
  // login that may change a final row, only the one sealed column named by the
  // GUC, nothing else. The owner pool plays that owner (checked in (d)).
  for (const kind of ["orderLink", "orderClaim", "tender"] as const) {
    const spec = KINDS[kind];
    const wrong =
      kind === "tender"
        ? "orders.payment_link_token_sealed"
        : kind === "orderLink"
          ? "orders.claim_token_sealed"
          : "orders.payment_link_token_sealed";

    it(`${keyOf(kind)}: the trigger lets the function owner change exactly the named sealed column of a final row`, async () => {
      const row = await seedFrozen(kind);
      const next = resealed(row);
      const before = await others(row);
      const outcome = await execAs(
        "owner",
        row.tenant,
        [update(row, spec.column, next)],
        spec.guc,
      );
      expect(outcome).toMatchObject({ ok: true, rowCount: 1 });
      expect(await storedSealed(row)).toBe(next);
      expect(await others(row)).toEqual(before);
    });

    it(`${keyOf(kind)}: the trigger still refuses the owner without the GUC, with another column's GUC, or with another column changed too`, async () => {
      const row = await seedFrozen(kind);
      const next = resealed(row);
      const before = await others(row);

      for (const guc of [
        undefined,
        "",
        wrong,
        `${spec.table}.${spec.other.column}`,
      ]) {
        const outcome = await execAs(
          "owner",
          row.tenant,
          [update(row, spec.column, next)],
          guc,
        );
        expect(outcome.ok, `guc=${String(guc)}`).toBe(false);
      }

      // Right GUC, but the same statement also changes a second column.
      const both = await execAs(
        "owner",
        row.tenant,
        [
          [
            `UPDATE public."${spec.table}" SET "${spec.column}" = $1, "${spec.other.column}" = $2 WHERE id = $3`,
            [next, spec.other.value, row.id],
          ],
        ],
        spec.guc,
      );
      expect(both.ok).toBe(false);

      // Right GUC, only the other column changes.
      const onlyOther = await execAs(
        "owner",
        row.tenant,
        [update(row, spec.other.column, spec.other.value)],
        spec.guc,
      );
      expect(onlyOther.ok).toBe(false);

      // DELETE is never allowed, GUC or not.
      const del = await execAs(
        "owner",
        row.tenant,
        [[`DELETE FROM public."${spec.table}" WHERE id = $1`, [row.id]]],
        spec.guc,
      );
      expect(del.ok).toBe(false);

      expect(await storedSealed(row)).toBe(row.sealed);
      expect(await others(row)).toEqual(before);
    });
  }

  // apology_vouchers: the new guard trigger (brief point 4).
  it("apology_vouchers: the guard lets the owner change only code_sealed, only with the GUC", async () => {
    const row = await seedFrozen("voucher");
    const spec = KINDS.voucher;
    const next = resealed(row);
    const before = await others(row);

    for (const guc of [undefined, "", "orders.claim_token_sealed"]) {
      const outcome = await execAs(
        "owner",
        row.tenant,
        [update(row, spec.column, next)],
        guc,
      );
      expect(outcome.ok, `guc=${String(guc)}`).toBe(false);
    }
    const otherOnly = await execAs(
      "owner",
      row.tenant,
      [update(row, spec.other.column, spec.other.value)],
      spec.guc,
    );
    expect(otherOnly.ok).toBe(false);
    const both = await execAs(
      "owner",
      row.tenant,
      [
        [
          `UPDATE public.apology_vouchers SET code_sealed = $1, reason = $2 WHERE id = $3`,
          [next, spec.other.value, row.id],
        ],
      ],
      spec.guc,
    );
    expect(both.ok).toBe(false);
    expect(await storedSealed(row)).toBe(row.sealed);

    const allowed = await execAs(
      "owner",
      row.tenant,
      [update(row, spec.column, next)],
      spec.guc,
    );
    expect(allowed).toMatchObject({ ok: true, rowCount: 1 });
    expect(await storedSealed(row)).toBe(next);
    expect(await others(row)).toEqual(before);
  });
});
