// Sealed-secret re-seal job (bead legend-tetyr) against PostgreSQL with the
// restricted app role (RLS enforced). The suite runs with a key ring of
// versions 1 and 2 and version 2 active. Rows "written before the rotation"
// are sealed with `sealSecretBaseKey` (envelope version byte 1).
//
// Written from the job's documented contract (header comment of
// worker/sealed-secret-reseal.job.ts), not from how it is implemented:
//   - stale = envelope version byte below the active version;
//   - a stale row opens under its own version and is sealed under the active
//     one with the SAME AAD the writer uses;
//   - current rows are not touched;
//   - resumable: a killed or aborted run continues after the last committed batch;
//   - a row that will not open is counted `failed` and does not stop the column;
//   - a tenant row is only ever handled under its own tenant;
//   - completed/voided order rows (and their tenders) and the append-only
//     apology codes are frozen for the app role; since legend-4vfmn the job
//     reseals them through app.reseal_frozen_sealed (see
//     sealed-secret-reseal-frozen.test.ts), so they no longer stay in `remaining`;
//   - nothing but counts and names is returned or logged.
//
// Assumptions:
//   - Every registry table has a uuid `id` column (the job casts ids to uuid).
//   - Required columns the test does not care about are filled generically from
//     information_schema; foreign keys and triggers are bypassed while seeding
//     only (session_replication_role = replica, as the HRIS reseal test does).
//   - `orders.status` has a default that is not completed/voided.
//   - Global-scope runs are narrowed to the test's own rows through the
//     registry's `where` hook (the `columns` option), so rows other test files
//     leave in the shared database do not change the counts.
//   - Fix 1198 (card legend-qwm9r, docs/briefs/sub-1198-reseal-so1196.md): the
//     frozen pass calls app.reseal_frozen_sealed through the job option
//     `resealDatabase` (pool of the dedicated login legend_reseal_<16 hex>), not
//     through `database` with SET ROLE. Without `resealDatabase` the frozen pass
//     is skipped: not a failure, `remaining` still counts the frozen rows, one
//     warn line per run. A frozen row held by another transaction is skipped
//     (the function answers -1 at once): not `failed`, still in `remaining`, the
//     other rows move, and a rerun takes it once the lock is gone. The tests
//     create the login by hand (the shared test database is provisioned without
//     it). Log shape assumed `{ error, warn?, info? }`; "warn once" is read as
//     once per run, however many tenants and columns are skipped. A 15 s bound
//     detects a hung job; a correct job answers in milliseconds.
//   - `sealedSecretUnresolved` counts every row still below the active version,
//     frozen rows included (the old key cannot retire while any is left); after a
//     successful job it is 0.
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
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
import { db } from "../db/index.ts";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  currentSealVersion,
  openSecret,
  sealSecret,
  sealSecretBaseKey,
  sealedVersion,
} from "../lib/secrets.ts";
import {
  SEALED_SECRET_COLUMNS,
  runSealedSecretReseal,
  sealedSecretUnresolved,
  type SealedSecretColumn,
  type SealedSecretResealResult,
  registerSealedSecretResealJob,
} from "../worker/sealed-secret-reseal.job.ts";

const fixtureTenant = cafeLegendPlatformFixtures.tenant.id;
const tenantA = randomUUID();
const tenantB = randomUUID();
const tenants = [tenantA, tenantB];

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

// The dedicated reseal login (brief 1198): member of legend_sealed_reseal
// INHERIT TRUE, SET FALSE, no ADMIN, no other right.
const resealLogin = `legend_reseal_${randomBytes(8).toString("hex")}`;
const resealPassword = randomBytes(24).toString("hex");
let resealPool: Pool;
const databaseName = () =>
  decodeURIComponent(
    new URL(process.env.STARTER_TEST_DATABASE_URL as string).pathname.slice(1),
  );

async function createResealLogin() {
  await owner.query(
    `CREATE ROLE "${resealLogin}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${resealPassword}'`,
  );
  await owner.query(
    `GRANT legend_sealed_reseal TO "${resealLogin}" WITH INHERIT TRUE, SET FALSE, ADMIN FALSE`,
  );
  await owner.query(
    `GRANT CONNECT ON DATABASE "${databaseName()}" TO "${resealLogin}"`,
  );
  const url = new URL(process.env.STARTER_TEST_DATABASE_URL as string);
  url.username = resealLogin;
  url.password = resealPassword;
  resealPool = new Pool({ connectionString: url.toString(), max: 3 });
}

async function dropResealLogin() {
  await resealPool?.end();
  await owner
    .query(
      `REVOKE CONNECT ON DATABASE "${databaseName()}" FROM "${resealLogin}"`,
    )
    .catch(() => undefined);
  await owner
    .query(`REVOKE legend_sealed_reseal FROM "${resealLogin}"`)
    .catch(() => undefined);
  await owner
    .query(`DROP ROLE IF EXISTS "${resealLogin}"`)
    .catch(() => undefined);
}

type Settled<T> = { done: true; value: T } | { done: false };

/** Resolves with the value, or with `{ done: false }` when still pending after `ms`. */
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
async function lockRow(row: Seeded) {
  const client = await owner.connect();
  await client.query("BEGIN");
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
    [row.tenant],
  );
  await client.query(
    `SELECT id FROM public."${row.spec.table}" WHERE id = $1 FOR UPDATE`,
    [row.id],
  );
  return {
    release: async () => {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    },
  };
}

type Extra = Record<string, string | number>;
type Ctx = { tenant: string; id: string; ulid: string; extra: Extra };
type Spec = {
  table: string;
  column: string;
  scope: "tenant" | "global";
  encoding: "text" | "bytea";
  idIsUlid?: boolean;
  /** Extra column values the AAD depends on. */
  extra?: () => Extra;
  /** Column values the table's CHECK constraints need (not part of the AAD). */
  defaults?: () => Record<string, unknown>;
  /** Writer AAD, copied from the writer named in the registry comments. */
  aad: (c: Ctx) => string;
};

const SPECS: Spec[] = [
  {
    table: "mfa_factors",
    column: "secret_encrypted",
    scope: "global",
    encoding: "text",
    extra: () => ({ user_id: randomUUID() }),
    aad: (c) => `mfa-factor:${c.id}:${String(c.extra.user_id).toLowerCase()}`,
  },
  {
    table: "user_identities",
    column: "value_encrypted",
    scope: "global",
    encoding: "text",
    extra: () => ({
      user_id: randomUUID(),
      type: "email",
      value_hash: randomBytes(32).toString("hex"),
    }),
    aad: (c) => `user_identity:${c.extra.type}:${c.extra.value_hash}`,
  },
  {
    table: "login_challenges",
    column: "email_encrypted",
    defaults: () => ({ channel: "email_magic_link" }),
    scope: "global",
    encoding: "text",
    aad: (c) => `login_challenge:email:${c.id}`,
  },
  {
    table: "legal_entities",
    column: "npwp_encrypted",
    defaults: () => ({ npwp_last4: "1234" }),
    scope: "tenant",
    encoding: "text",
    aad: (c) => `legal_entity:${c.tenant}`,
  },
  {
    table: "shareholders",
    column: "npwp_sealed",
    defaults: () => ({ type: "person", npwp_last4: "1234" }),
    scope: "tenant",
    encoding: "text",
    aad: (c) => `shareholder:${c.tenant}:${c.id}:npwp`,
  },
  {
    table: "shareholders",
    column: "payout_account_sealed",
    defaults: () => ({
      type: "person",
      payout_bank: "BCA",
      payout_account_last4: "1234",
      payout_account_holder: "Holder",
    }),
    scope: "tenant",
    encoding: "text",
    aad: (c) => `shareholder:${c.tenant}:${c.id}:payout_account`,
  },
  {
    table: "bank_accounts",
    column: "account_number_encrypted",
    defaults: () => ({
      account_number_last4: "1234",
      account_number_hmac: randomBytes(32).toString("hex"),
      bank: "BCA",
      account_name: "Holder",
    }),
    scope: "tenant",
    encoding: "bytea",
    extra: () => ({ account_number_key_version: 1 }),
    aad: (c) =>
      `bank:bank_accounts:${c.tenant.toLowerCase()}:${c.id.toLowerCase()}:account_number:k${c.extra.account_number_key_version}`,
  },
  {
    table: "tables",
    column: "qr_token_sealed",
    defaults: () => ({
      code: `T-${randomBytes(4).toString("hex").toUpperCase()}`,
      qr_token_hash: randomBytes(32).toString("hex"),
      type: "regular",
    }),
    scope: "tenant",
    encoding: "text",
    aad: (c) => `table-qr:${c.tenant}:${c.id}`,
  },
  {
    table: "table_sessions",
    column: "session_token_sealed",
    defaults: () => ({ payment_mode: "open_bill", status: "open" }),
    scope: "tenant",
    encoding: "text",
    aad: (c) => `table-session:${c.tenant}:${c.id}`,
  },
  {
    table: "bill_splits",
    column: "claim_token_sealed",
    defaults: () => ({ method: "equal" }),
    scope: "tenant",
    encoding: "text",
    aad: (c) => `bill-split-claim:${c.tenant}:${c.id}`,
  },
  {
    table: "orders",
    column: "payment_link_token_sealed",
    defaults: () => ({
      channel: "pos",
      payment_mode: "pay_first",
      service_type: "dine_in",
      status: "draft",
      subtotal_idr: 0,
      discount_idr: 0,
      service_charge_idr: 0,
      tax_idr: 0,
      rounding_idr: 0,
      total_idr: 0,
      prices_include_tax: false,
      payment_link_id: randomUUID(),
    }),
    scope: "tenant",
    encoding: "text",
    idIsUlid: true,
    aad: (c) => `qr-order-payment-link:${c.tenant}:${c.ulid}`,
  },
  {
    table: "orders",
    column: "claim_token_sealed",
    defaults: () => ({
      channel: "pos",
      payment_mode: "pay_first",
      service_type: "dine_in",
      status: "sent",
      subtotal_idr: 0,
      discount_idr: 0,
      service_charge_idr: 0,
      tax_idr: 0,
      rounding_idr: 0,
      total_idr: 0,
      prices_include_tax: false,
      claim_token_hash: randomBytes(32).toString("hex"),
    }),
    scope: "tenant",
    encoding: "text",
    idIsUlid: true,
    aad: (c) => `order-claim:${c.tenant}:${c.ulid}`,
  },
  {
    table: "reservations",
    column: "deposit_link_sealed",
    defaults: () => ({
      pax: 2,
      duration_minutes: 60,
      source: "website",
      status: "confirmed",
    }),
    scope: "tenant",
    encoding: "text",
    aad: (c) => `reservation-deposit:${c.tenant}:${c.id}`,
  },
  {
    table: "apology_vouchers",
    column: "code_sealed",
    scope: "tenant",
    encoding: "text",
    extra: () => ({ voucher_id: randomUUID() }),
    aad: (c) => `apology-voucher:${c.tenant}:${c.extra.voucher_id}`,
  },
  {
    table: "pos_receipt_deliveries",
    column: "destination_sealed",
    defaults: () => ({ channel: "email", status: "queued", attempts: 0 }),
    scope: "tenant",
    encoding: "text",
    extra: () => ({ receipt_id: randomUUID() }),
    aad: (c) => `pos_receipt_delivery:${c.tenant}:${c.extra.receipt_id}`,
  },
  {
    table: "pos_order_tenders",
    column: "payment_link_token_sealed",
    defaults: () => ({
      method: "qris",
      provider: "doit",
      status: "authorized",
      amount_idr: 1000,
      payment_link_id: randomUUID(),
    }),
    scope: "tenant",
    encoding: "text",
    aad: (c) => `pos-order-payment-link:${c.tenant}:${c.id}`,
  },
  {
    table: "order_issue_charges",
    column: "payment_link_token_sealed",
    defaults: () => ({
      route: "qr_link",
      status: "open",
      payment_link_id: randomUUID(),
      difference_idr: 1000,
      gross_sales_idr: 1000,
      service_charge_idr: 0,
      pbjt_idr: 0,
      amount_idr: 1000,
    }),
    scope: "tenant",
    encoding: "text",
    aad: (c) => `order-issue-charge-link:${c.tenant}:${c.id}`,
  },
  {
    // wfc-sale.service.ts wfcLinkSealAad(); a token-only update passes the
    // claim guard (not a frozen column, status unchanged).
    table: "wfc_seat_reservations",
    column: "payment_link_token_sealed",
    defaults: () => ({
      kind: "day_pass",
      access: "all_day",
      status: "pending_payment",
      business_date: "2098-01-01",
      slot: "[2098-01-01T01:00:00Z,2098-01-01T02:00:00Z)",
      seat_fee_idr: 50_000,
      credit_idr: 20_000,
      price_idr: 70_000,
      paid_idr: 0,
      refunded_idr: 0,
      floor_per_hour_idr: 1,
      hold_expires_at: new Date(Date.now() + 45 * 60_000),
    }),
    scope: "tenant",
    encoding: "text",
    aad: (c) => `wfc-payment-link:${c.tenant}:${c.id}`,
  },
  {
    // lib/push-subscription.ts associatedData(); key_version is kept in step by the job.
    table: "push_subscriptions",
    column: "subscription_ciphertext",
    scope: "tenant",
    encoding: "text",
    extra: () => ({ user_id: randomUUID() }),
    defaults: () => ({
      endpoint_hash: randomBytes(32).toString("hex"),
      key_version: "v1",
    }),
    aad: (c) => `push-subscription:${c.tenant}:${c.extra.user_id}`,
  },
];

const specOf = (table: string, column: string): Spec => {
  const spec = SPECS.find((s) => s.table === table && s.column === column);
  if (!spec) throw new Error(`no spec for ${table}.${column}`);
  return spec;
};
const keyOf = (spec: { table: string; column: string }) =>
  `${spec.table}.${spec.column}`;

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
  spec: Spec;
  tenant: string;
  id: string;
  plain: string;
  aad: string;
  /** What was written, base64 of the envelope. */
  sealed: string;
};

type SeedOptions = {
  tenant?: string;
  /** Seal under the active version instead of the old one. */
  current?: boolean;
  /** Seal under this AAD instead of the writer's (a row that cannot open). */
  aadOverride?: string;
  /** Extra column overrides (e.g. status). */
  set?: Record<string, unknown>;
  id?: string;
};

async function seed(spec: Spec, options: SeedOptions = {}): Promise<Seeded> {
  const tenant = options.tenant ?? tenantA;
  const id = options.id ?? randomUUID();
  const extra = { ...(spec.extra?.() ?? {}) };
  const ctx: Ctx = {
    tenant,
    id,
    ulid: spec.idIsUlid ? uuidToUlid(id) : id,
    extra,
  };
  const aad = options.aadOverride ?? spec.aad(ctx);
  const plain = `plain-${randomBytes(9).toString("hex")}`;
  const sealed = options.current
    ? sealSecret(plain, aad)
    : sealSecretBaseKey(plain, aad);
  const values: Record<string, unknown> = {
    id,
    ...(spec.scope === "tenant" ? { tenant_id: tenant } : {}),
    ...(spec.defaults?.() ?? {}),
    ...extra,
    [spec.column]:
      spec.encoding === "bytea" ? Buffer.from(sealed, "base64") : sealed,
    ...(options.set ?? {}),
  };
  await asOwner(tenant, async (client) => {
    for (const f of await requiredColumns(client, spec.table))
      if (!(f.name in values)) values[f.name] = await fillValue(client, f);
    const names = Object.keys(values);
    await client.query(
      `INSERT INTO public."${spec.table}" (${names.map((n) => `"${n}"`).join(", ")})
       VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      names.map((n) => values[n]),
    );
  });
  touched.push({ table: spec.table, id, tenant });
  return { spec, tenant, id, plain, aad, sealed };
}

async function storedSealed(row: Seeded): Promise<string> {
  const { spec } = row;
  const expr =
    spec.encoding === "bytea"
      ? `replace(encode("${spec.column}", 'base64'), E'\\n', '')`
      : `"${spec.column}"`;
  return asOwner(row.tenant, async (client) => {
    const { rows } = await client.query(
      `SELECT ${expr} AS sealed FROM public."${spec.table}" WHERE id = $1`,
      [row.id],
    );
    return String(rows[0]?.sealed);
  });
}

/** Rows of the registry the run is allowed to see; global ones narrowed to ids. */
function columnsFor(
  keys: string[],
  globalIds: string[] = [],
): SealedSecretColumn[] {
  return keys.map((key) => {
    const c = SEALED_SECRET_COLUMNS.find((x) => keyOf(x) === key);
    if (!c) throw new Error(`registry has no ${key}`);
    if (c.scope === "tenant") return c;
    const ids = globalIds.map((id) => `'${id}'`).join(", ") || "''";
    const narrowed = `t.id::text IN (${ids})`;
    return { ...c, where: c.where ? `(${c.where}) AND ${narrowed}` : narrowed };
  });
}

type Captured = { lines: string[]; log: { error: (m: string) => void } };
const capture = (): Captured => {
  const lines: string[] = [];
  return { lines, log: { error: (m: string) => void lines.push(String(m)) } };
};

async function run(
  keys: string[],
  options: {
    tenantIds?: string[];
    globalIds?: string[];
    batchSize?: number;
    signal?: AbortSignal;
    afterBatch?: () => void | Promise<void>;
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
    columns: columnsFor(keys, options.globalIds),
    listTenantIds: async () => options.tenantIds ?? [tenantA],
    batchSize: options.batchSize ?? 2,
    log: options.log ?? { error: () => {} },
    ...(options.resealDatabase === false
      ? {}
      : { resealDatabase: drizzle(resealPool) }),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.afterBatch ? { afterBatch: options.afterBatch } : {}),
    ...(options.reportOnly ? { reportOnly: true } : {}),
  } as Parameters<typeof runSealedSecretReseal>[0]);
}

async function clearState() {
  await owner.query(
    "DELETE FROM sealed_secret_reseal_state WHERE scope_key = ANY($1) OR scope_key = 'global'",
    [tenants],
  );
}

// Privileges the app role has on the progress table, read BEFORE this file
// touches any grant. The job runs as the app role and reads/writes the table in
// every batch, so without these it fails every scope.
let progressTable = { role: "", select: false, insert: false, update: false };

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await createResealLogin();
  expect(currentSealVersion()).toBe(2);
  const probe = await db.execute(sql`
    SELECT current_user::text AS role,
      has_table_privilege(current_user, 'public.sealed_secret_reseal_state', 'SELECT') AS sel,
      has_table_privilege(current_user, 'public.sealed_secret_reseal_state', 'INSERT') AS ins,
      has_table_privilege(current_user, 'public.sealed_secret_reseal_state', 'UPDATE') AS upd`);
  const probed = probe.rows[0] as Record<string, unknown>;
  progressTable = {
    role: String(probed.role),
    select: probed.sel === true,
    insert: probed.ins === true,
    update: probed.upd === true,
  };
  for (const tenant of tenants)
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Sealed reseal tenant', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [tenant, `sealed-reseal-${tenant.slice(0, 8)}`, fixtureTenant],
    );
});

beforeEach(clearState);

// Rows a case seeded must not leak into the next one (a stale row left by a
// reportOnly case would be resealed and counted by the following case).
afterEach(async () => {
  for (const row of touched.splice(0))
    await asOwner(row.tenant, (client) =>
      client.query(`DELETE FROM public."${row.table}" WHERE id = $1`, [row.id]),
    ).catch(() => undefined);
});

afterAll(async () => {
  for (const row of touched)
    await asOwner(row.tenant, (client) =>
      client.query(`DELETE FROM public."${row.table}" WHERE id = $1`, [row.id]),
    );
  await clearState();
  for (const tenant of tenants)
    await asOwner(tenant, (client) =>
      client.query("DELETE FROM tenants WHERE id = $1", [tenant]),
    );
  await dropResealLogin();
  await owner.end();
});

// --- registry ---------------------------------------------------------------

describe("[legend-tetyr] registry", () => {
  it("the app role can read and write the progress table (the migration grants it)", () => {
    expect(progressTable).toMatchObject({
      select: true,
      insert: true,
      update: true,
    });
  });

  it("covers the 19 sealed columns, each once", () => {
    const keys = SEALED_SECRET_COLUMNS.map(keyOf).sort();
    expect(keys).toEqual(SPECS.map(keyOf).sort());
    expect(new Set(keys).size).toBe(19);
  });

  it("every registry column exists with the declared type, and tenant tables have tenant_id", async () => {
    for (const c of SEALED_SECRET_COLUMNS) {
      const { rows } = await owner.query(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [c.table],
      );
      const types = new Map(
        rows.map((r) => [String(r.column_name), String(r.data_type)]),
      );
      expect(types.get(c.column), keyOf(c)).toBe(
        c.encoding === "bytea" ? "bytea" : "text",
      );
      expect(types.get("id"), `${c.table}.id`).toBe("uuid");
      if (c.scope === "tenant")
        expect(types.has("tenant_id"), `${c.table}.tenant_id`).toBe(true);
      for (const extra of c.extra ?? [])
        expect(types.has(extra), `${c.table}.${extra}`).toBe(true);
    }
  });

  it("only order rows, their tenders and the append-only apology codes are marked frozen", () => {
    const frozen = SEALED_SECRET_COLUMNS.filter((c) => c.frozenWhere).map(
      keyOf,
    );
    expect(frozen.sort()).toEqual([
      "apology_vouchers.code_sealed",
      "orders.claim_token_sealed",
      "orders.payment_link_token_sealed",
      "pos_order_tenders.payment_link_token_sealed",
    ]);
  });
});

// --- reseal of every column -------------------------------------------------

describe("[legend-tetyr] stale rows move to the active key", () => {
  for (const spec of SPECS.filter(
    (s) => keyOf(s) !== "apology_vouchers.code_sealed",
  ))
    it(`${keyOf(spec)}: stale row opens to the same plaintext with the same AAD under the active key`, async () => {
      const row = await seed(spec);
      expect(sealedVersion(row.sealed)).toBe(1);
      const globalIds = [row.id];
      const result = await run([keyOf(spec)], { globalIds });

      expect(result).toMatchObject({
        activeVersion: 2,
        failedTenants: 0,
        aborted: false,
      });
      expect(result.tables[keyOf(spec)]).toEqual({
        resealed: 1,
        failed: 0,
        remaining: 0,
        frozen: 0,
      });
      expect(sealedSecretUnresolved(result)).toBe(0);

      const after = await storedSealed(row);
      expect(sealedVersion(after)).toBe(2);
      expect(after).not.toBe(row.sealed);
      expect(openSecret(after, row.aad)).toBe(row.plain);
      // The AAD is still the binding: another one does not open it.
      expect(() => openSecret(after, `${row.aad}:other`)).toThrow();
    });

  it("apology_vouchers.code_sealed: append-only for the app role, yet resealed through the frozen-column door (legend-4vfmn)", async () => {
    const spec = specOf("apology_vouchers", "code_sealed");
    const row = await seed(spec);
    const result = await run([keyOf(spec)]);
    expect(result).toMatchObject({ failedTenants: 0, aborted: false });
    // `frozen` after success is not asserted: the brief does not say whether it
    // counts stale frozen rows or every frozen row.
    expect(result.tables[keyOf(spec)]).toMatchObject({
      resealed: 1,
      failed: 0,
      remaining: 0,
    });
    expect(sealedSecretUnresolved(result)).toBe(0);
    const after = await storedSealed(row);
    expect(sealedVersion(after)).toBe(2);
    expect(openSecret(after, row.aad)).toBe(row.plain);
  });

  it("bank_accounts: the key-version label inside the AAD stays as it was", async () => {
    const spec = specOf("bank_accounts", "account_number_encrypted");
    const row = await seed(spec);
    await run([keyOf(spec)]);
    const { rows } = await asOwner(row.tenant, (client) =>
      client.query(
        "SELECT account_number_key_version AS v FROM bank_accounts WHERE id = $1",
        [row.id],
      ),
    );
    expect(Number(rows[0].v)).toBe(1);
    const after = await storedSealed(row);
    expect(sealedVersion(after)).toBe(2);
    expect(openSecret(after, row.aad)).toBe(row.plain);
  });

  it("orders.payment_link_token_sealed: a link sealed by the facility-breakfast writer also moves", async () => {
    const spec = specOf("orders", "payment_link_token_sealed");
    const id = randomUUID();
    const aad = `facility-breakfast-payment-link:${tenantA}:${uuidToUlid(id)}`;
    const row = await seed(spec, { id, aadOverride: aad });
    const result = await run([keyOf(spec)]);
    expect(result.tables[keyOf(spec)]).toMatchObject({
      resealed: 1,
      failed: 0,
      remaining: 0,
    });
    const after = await storedSealed(row);
    expect(sealedVersion(after)).toBe(2);
    expect(openSecret(after, aad)).toBe(row.plain);
  });

  it("a user_identities row of another type is out of scope and not touched", async () => {
    const spec = specOf("user_identities", "value_encrypted");
    const row = await seed(spec);
    // Same table, a type the job does not move: it must stay as written.
    const other = await seed(spec, { set: { type: "google" } });
    const result = await run([keyOf(spec)], { globalIds: [row.id, other.id] });
    expect(result.tables[keyOf(spec)]).toMatchObject({
      resealed: 1,
      failed: 0,
      remaining: 0,
    });
    expect(sealedVersion(await storedSealed(row))).toBe(2);
    expect(await storedSealed(other)).toBe(other.sealed);
  });
});

// --- untouched / idempotent -------------------------------------------------

describe("[legend-tetyr] already-current rows", () => {
  it("are not rewritten, and a second run changes nothing", async () => {
    const spec = specOf("tables", "qr_token_sealed");
    const current = await seed(spec, { current: true });
    const stale = await seed(spec);

    const first = await run([keyOf(spec)]);
    expect(first.tables[keyOf(spec)]).toMatchObject({
      resealed: 1,
      failed: 0,
      remaining: 0,
    });
    expect(await storedSealed(current)).toBe(current.sealed);
    const afterFirst = await storedSealed(stale);
    expect(sealedVersion(afterFirst)).toBe(2);

    const second = await run([keyOf(spec)]);
    expect(second.tables[keyOf(spec)]).toEqual({
      resealed: 0,
      failed: 0,
      remaining: 0,
      frozen: 0,
    });
    expect(await storedSealed(current)).toBe(current.sealed);
    expect(await storedSealed(stale)).toBe(afterFirst);
  });

  it("reportOnly counts stale rows and changes nothing", async () => {
    const spec = specOf("tables", "qr_token_sealed");
    const rows = [await seed(spec), await seed(spec)];
    const result = await run([keyOf(spec)], { reportOnly: true });
    expect(result.tables[keyOf(spec)]).toEqual({
      resealed: 0,
      failed: 0,
      remaining: 2,
      frozen: 0,
    });
    expect(sealedSecretUnresolved(result)).toBe(2);
    for (const row of rows) expect(await storedSealed(row)).toBe(row.sealed);
  });
});

// --- resume -----------------------------------------------------------------

describe("[legend-tetyr] resume", () => {
  const spec = specOf("shareholders", "npwp_sealed");

  it("after an abort, the next run reseals only the rows that are left", async () => {
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push(await seed(spec));
    const controller = new AbortController();
    const first = await run([keyOf(spec)], {
      batchSize: 2,
      signal: controller.signal,
      afterBatch: () => controller.abort(),
    });
    expect(first.aborted).toBe(true);
    expect(first.tables[keyOf(spec)]?.resealed).toBe(2);
    expect(first.tables[keyOf(spec)]?.remaining).toBe(3);

    const afterFirst = await Promise.all(rows.map(storedSealed));
    const done = afterFirst.filter((s) => sealedVersion(s) === 2);
    expect(done).toHaveLength(2);

    const second = await run([keyOf(spec)], { batchSize: 2 });
    expect(second.aborted).toBe(false);
    expect(second.tables[keyOf(spec)]).toEqual({
      resealed: 3,
      failed: 0,
      remaining: 0,
      frozen: 0,
    });
    // The two rows finished before the abort were not written again.
    const afterSecond = await Promise.all(rows.map(storedSealed));
    rows.forEach((row, i) => {
      if (sealedVersion(afterFirst[i]!) === 2)
        expect(afterSecond[i]).toBe(afterFirst[i]);
      expect(sealedVersion(afterSecond[i]!)).toBe(2);
      expect(openSecret(afterSecond[i]!, row.aad)).toBe(row.plain);
    });

    const third = await run([keyOf(spec)]);
    expect(third.tables[keyOf(spec)]?.resealed).toBe(0);
  });

  it("after a crash between batches, the committed batch stays and the rerun does the rest", async () => {
    const rows = [];
    for (let i = 0; i < 4; i++) rows.push(await seed(spec));
    const errors = capture();
    let batches = 0;
    const crashed = await run([keyOf(spec)], {
      batchSize: 1,
      log: errors.log,
      afterBatch: () => {
        batches += 1;
        if (batches === 2) throw new Error("simulated crash");
      },
    });
    expect(crashed.failedTenants).toBe(1);
    expect(errors.lines.length).toBeGreaterThan(0);
    const mid = await Promise.all(rows.map(storedSealed));
    expect(mid.filter((s) => sealedVersion(s) === 2)).toHaveLength(2);

    const resumed = await run([keyOf(spec)], { batchSize: 1 });
    expect(resumed.failedTenants).toBe(0);
    expect(resumed.tables[keyOf(spec)]).toMatchObject({
      resealed: 2,
      failed: 0,
      remaining: 0,
    });
    for (const row of rows)
      expect(openSecret(await storedSealed(row), row.aad)).toBe(row.plain);
  });
});

// --- one bad row ------------------------------------------------------------

describe("[legend-tetyr] a row that cannot be resealed", () => {
  it("is counted failed, left as it was, and does not stop the other rows", async () => {
    const spec = specOf("tables", "qr_token_sealed");
    const good = [await seed(spec), await seed(spec), await seed(spec)];
    // Sealed under an AAD the writer would never use: it will not open.
    const bad = await seed(spec, { aadOverride: "table-qr:wrong:binding" });

    const result = await run([keyOf(spec)], { batchSize: 2 });
    expect(result).toMatchObject({ failedTenants: 0, aborted: false });
    expect(result.tables[keyOf(spec)]).toEqual({
      resealed: 3,
      failed: 1,
      remaining: 1,
      frozen: 0,
    });
    expect(sealedSecretUnresolved(result)).toBeGreaterThan(0);

    for (const row of good) {
      const after = await storedSealed(row);
      expect(sealedVersion(after)).toBe(2);
      expect(openSecret(after, row.aad)).toBe(row.plain);
    }
    expect(await storedSealed(bad)).toBe(bad.sealed);

    // The next pass retries it and still reports it; nothing else changes.
    const again = await run([keyOf(spec)]);
    expect(again.tables[keyOf(spec)]).toMatchObject({
      resealed: 0,
      failed: 1,
      remaining: 1,
    });
  });
});

// --- tenants ----------------------------------------------------------------

describe("[legend-tetyr] tenant isolation", () => {
  const spec = specOf("shareholders", "npwp_sealed");

  it("each tenant's rows are resealed under that tenant's own AAD; a run for one tenant leaves the other alone", async () => {
    const a = await seed(spec, { tenant: tenantA });
    const b = await seed(spec, { tenant: tenantB });

    const onlyA = await run([keyOf(spec)], { tenantIds: [tenantA] });
    expect(onlyA.tables[keyOf(spec)]).toMatchObject({
      resealed: 1,
      failed: 0,
      remaining: 0,
    });
    expect(sealedVersion(await storedSealed(a))).toBe(2);
    expect(await storedSealed(b)).toBe(b.sealed);

    const both = await run([keyOf(spec)], { tenantIds: [tenantA, tenantB] });
    expect(both.tables[keyOf(spec)]).toMatchObject({
      resealed: 1,
      failed: 0,
      remaining: 0,
    });
    for (const row of [a, b]) {
      const after = await storedSealed(row);
      expect(sealedVersion(after)).toBe(2);
      expect(openSecret(after, row.aad)).toBe(row.plain);
    }
    // No tenant crosses: tenant B's value does not open under tenant A's AAD.
    const storedA = await storedSealed(a);
    const storedB = await storedSealed(b);
    expect(() => openSecret(storedB, a.aad)).toThrow();
    expect(() => openSecret(storedA, b.aad)).toThrow();
  });

  it("a row of tenant B that is bound to tenant A's AAD is not resealed under B: counted failed, untouched", async () => {
    const id = randomUUID();
    const crossBound = await seed(spec, {
      tenant: tenantB,
      id,
      aadOverride: `shareholder:${tenantA}:${id}:npwp`,
    });
    const mine = await seed(spec, { tenant: tenantA });

    const result = await run([keyOf(spec)], { tenantIds: [tenantA, tenantB] });
    expect(result.tables[keyOf(spec)]).toMatchObject({
      resealed: 1,
      failed: 1,
      remaining: 1,
    });
    expect(await storedSealed(crossBound)).toBe(crossBound.sealed);
    expect(sealedVersion(await storedSealed(mine))).toBe(2);
  });

  it("a tenant row never shows up in another tenant's counts", async () => {
    const b = await seed(spec, { tenant: tenantB });
    const report = await run([keyOf(spec)], {
      tenantIds: [tenantA],
      reportOnly: true,
    });
    expect(report.tables[keyOf(spec)]).toEqual({
      resealed: 0,
      failed: 0,
      remaining: 0,
      frozen: 0,
    });
    expect(await storedSealed(b)).toBe(b.sealed);
  });
});

// --- frozen order rows ------------------------------------------------------

describe("[legend-tetyr][legend-4vfmn] completed and voided orders are frozen, and still resealed", () => {
  const claim = specOf("orders", "claim_token_sealed");
  const link = specOf("orders", "payment_link_token_sealed");
  const tender = specOf("pos_order_tenders", "payment_link_token_sealed");

  it("open, completed and voided orders all move to the active key; remaining ends at 0", async () => {
    const open = await seed(claim);
    const completed = await seed(claim, { set: { status: "completed" } });
    const voided = await seed(claim, { set: { status: "voided" } });
    const completedLink = await seed(link, { set: { status: "completed" } });

    const result = await run([keyOf(claim), keyOf(link)]);
    expect(result).toMatchObject({ failedTenants: 0, aborted: false });
    expect(result.tables[keyOf(claim)]).toMatchObject({
      resealed: 3,
      failed: 0,
      remaining: 0,
    });
    expect(result.tables[keyOf(link)]).toMatchObject({
      resealed: 1,
      failed: 0,
      remaining: 0,
    });
    // No frozen leftover: the old key may retire.
    expect(sealedSecretUnresolved(result)).toBe(0);

    for (const row of [open, completed, voided, completedLink]) {
      const after = await storedSealed(row);
      expect(sealedVersion(after)).toBe(2);
      expect(openSecret(after, row.aad)).toBe(row.plain);
    }
  });

  it("tenders of open, completed and voided orders all move to the active key", async () => {
    const orderOpen = await seed(claim);
    const orderDone = await seed(claim, { set: { status: "completed" } });
    const orderVoid = await seed(claim, { set: { status: "voided" } });
    const onOpen = await seed(tender, { set: { order_id: orderOpen.id } });
    const onDone = await seed(tender, { set: { order_id: orderDone.id } });
    const onVoid = await seed(tender, { set: { order_id: orderVoid.id } });

    const result = await run([keyOf(tender)]);
    expect(result.tables[keyOf(tender)]).toMatchObject({
      resealed: 3,
      failed: 0,
      remaining: 0,
    });
    expect(sealedSecretUnresolved(result)).toBe(0);
    for (const row of [onOpen, onDone, onVoid]) {
      const after = await storedSealed(row);
      expect(sealedVersion(after)).toBe(2);
      expect(openSecret(after, row.aad)).toBe(row.plain);
    }
  });
});

// --- 1198: frozen pass needs resealDatabase; locked rows are skipped ----------

describe("[legend-qwm9r] P1 the frozen pass runs through resealDatabase only", () => {
  const claim = specOf("orders", "claim_token_sealed");
  const link = specOf("orders", "payment_link_token_sealed");
  const tender = specOf("pos_order_tenders", "payment_link_token_sealed");
  const voucher = specOf("apology_vouchers", "code_sealed");

  it("without resealDatabase: the frozen rows stay as written, nothing fails, remaining counts them, and one warn line is logged; normal rows still move", async () => {
    const open = await seed(claim, { set: { status: "sent" } });
    const frozenClaim = await seed(claim, { set: { status: "completed" } });
    const frozenLink = await seed(link, { set: { status: "voided" } });
    const parent = await seed(claim, { set: { status: "completed" } });
    const frozenTender = await seed(tender, { set: { order_id: parent.id } });
    const frozenVoucher = await seed(voucher);
    const frozen = [frozenClaim, frozenLink, frozenTender, frozenVoucher];

    const warnings: string[] = [];
    const result = await run(
      [keyOf(claim), keyOf(link), keyOf(tender), keyOf(voucher)],
      {
        tenantIds: [tenantA, tenantB],
        resealDatabase: false,
        log: { error: () => {}, warn: (m) => void warnings.push(String(m)) },
      },
    );

    expect(result).toMatchObject({ failedTenants: 0, aborted: false });
    for (const key of [
      keyOf(claim),
      keyOf(link),
      keyOf(tender),
      keyOf(voucher),
    ])
      expect(result.tables[key]?.failed, key).toBe(0);
    // The open order (and the parent, which is frozen too) -> claim column.
    expect(result.tables[keyOf(claim)]).toMatchObject({
      resealed: 1,
      failed: 0,
      remaining: 2,
    });
    expect(result.tables[keyOf(link)]).toMatchObject({
      resealed: 0,
      remaining: 1,
    });
    expect(result.tables[keyOf(tender)]).toMatchObject({
      resealed: 0,
      remaining: 1,
    });
    expect(result.tables[keyOf(voucher)]).toMatchObject({
      resealed: 0,
      remaining: 1,
    });
    // Honest: the old key cannot retire while a frozen row is below the version.
    // parent order claim + frozenClaim + link + tender + voucher.
    expect(sealedSecretUnresolved(result)).toBe(5);

    expect(sealedVersion(await storedSealed(open))).toBe(2);
    expect(openSecret(await storedSealed(open), open.aad)).toBe(open.plain);
    for (const row of [...frozen, parent])
      expect(await storedSealed(row)).toBe(row.sealed);

    expect(warnings).toHaveLength(1);
    for (const row of [...frozen, open])
      for (const secret of [row.plain, row.sealed, row.aad])
        expect(warnings.join("\n")).not.toContain(secret);
  });

  it("with resealDatabase the same rows move and remaining is 0", async () => {
    const frozenClaim = await seed(claim, { set: { status: "completed" } });
    const frozenVoucher = await seed(voucher);
    const warnings: string[] = [];
    const result = await run([keyOf(claim), keyOf(voucher)], {
      log: { error: () => {}, warn: (m) => void warnings.push(String(m)) },
    });
    expect(result).toMatchObject({ failedTenants: 0, aborted: false });
    expect(sealedSecretUnresolved(result)).toBe(0);
    expect(warnings).toHaveLength(0);
    for (const row of [frozenClaim, frozenVoucher]) {
      const after = await storedSealed(row);
      expect(sealedVersion(after)).toBe(2);
      expect(openSecret(after, row.aad)).toBe(row.plain);
    }
  });
});

describe("[legend-qwm9r] P2 a locked frozen row does not stop the sweep", () => {
  const claim = specOf("orders", "claim_token_sealed");
  const voucher = specOf("apology_vouchers", "code_sealed");

  for (const [spec, set] of [
    [claim, { status: "completed" }],
    [voucher, undefined],
  ] as const)
    it(`${keyOf(spec)}: the free rows move, the locked row stays in remaining (not failed), and a rerun after the lock is gone finishes`, async () => {
      const options = set ? { set } : {};
      const before = await seed(spec, options);
      const locked = await seed(spec, options);
      const after = await seed(spec, options);

      const lock = await lockRow(locked);
      let job: Promise<SealedSecretResealResult> | undefined;
      let settled: Settled<SealedSecretResealResult> = { done: false };
      let stored: string[] = [];
      try {
        job = run([keyOf(spec)], { batchSize: 3 });
        settled = await settles(job);
        if (settled.done)
          stored = await Promise.all([before, locked, after].map(storedSealed));
      } finally {
        await lock.release();
        await job?.catch(() => undefined);
      }

      expect(settled.done, "the job must not wait for the locked row").toBe(
        true,
      );
      const result = settled.done ? settled.value : undefined;
      expect(result).toMatchObject({ failedTenants: 0, aborted: false });
      expect(result?.tables[keyOf(spec)]).toMatchObject({
        resealed: 2,
        failed: 0,
        remaining: 1,
      });
      expect(sealedSecretUnresolved(result!)).toBe(1);
      for (const [row, value] of [
        [before, stored[0]],
        [after, stored[2]],
      ] as const) {
        expect(sealedVersion(value!)).toBe(2);
        expect(openSecret(value!, row.aad)).toBe(row.plain);
      }
      expect(stored[1]).toBe(locked.sealed);

      // The lock is gone: a rerun (fresh progress, as the other rerun tests do)
      // takes the row that was skipped.
      await clearState();
      const rerun = await run([keyOf(spec)], { batchSize: 3 });
      expect(rerun.tables[keyOf(spec)]).toMatchObject({
        resealed: 1,
        failed: 0,
        remaining: 0,
      });
      expect(sealedSecretUnresolved(rerun)).toBe(0);
      const moved = await storedSealed(locked);
      expect(sealedVersion(moved)).toBe(2);
      expect(openSecret(moved, locked.aad)).toBe(locked.plain);
    }, 60_000);
});

// --- no secrets in output ---------------------------------------------------

describe("[legend-tetyr] nothing secret in the result, the logs or the progress table", () => {
  it("shows no plaintext, sealed value or AAD, even when rows fail or a batch crashes", async () => {
    const spec = specOf("tables", "qr_token_sealed");
    const rows = [await seed(spec), await seed(spec)];
    const bad = await seed(spec, { aadOverride: "table-qr:wrong:binding" });
    const everyone = [...rows, bad];

    const errors = capture();
    let batches = 0;
    const result = await run([keyOf(spec)], {
      batchSize: 1,
      log: errors.log,
      afterBatch: () => {
        batches += 1;
        if (batches === 1) throw new Error(`crash ${rows[0]!.plain}`);
      },
    });
    const afterwards = await run([keyOf(spec)], { batchSize: 1 });

    const state = await owner.query(
      "SELECT row_to_json(s)::text AS j FROM sealed_secret_reseal_state s",
    );
    const output = [
      JSON.stringify(result),
      JSON.stringify(afterwards),
      ...errors.lines,
      ...state.rows.map((r) => String(r.j)),
    ].join("\n");
    expect(errors.lines.length).toBeGreaterThan(0);

    const sealedNow = await Promise.all(rows.map(storedSealed));
    const secrets = [
      ...everyone.flatMap((r) => [r.plain, r.sealed, r.aad]),
      ...sealedNow,
    ];
    for (const secret of secrets) expect(output).not.toContain(secret);
  });
});

// --- queue handler abort ----------------------------------------------------

describe("[legend-h1da5] queue handler abort", () => {
  const spec = specOf("shareholders", "npwp_sealed");

  it("passes the job signal to the run: an aborted job fails and reseals nothing", async () => {
    const row = await seed(spec);
    const before = await storedSealed(row);
    let handler:
      | ((jobs: { data: unknown; signal?: AbortSignal }[]) => Promise<void>)
      | undefined;
    await registerSealedSecretResealJob({
      boss: {
        createQueue: async () => {},
        schedule: async () => {},
        work: async (_name, fn) => {
          handler = fn;
        },
      },
      database: db,
      log: { error: () => {}, info: () => {} },
      listTenantIds: async () => [tenantA],
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      handler!([{ data: null, signal: controller.signal }]),
    ).rejects.toThrow(/aborted/);
    expect(await storedSealed(row)).toBe(before);
  });
});
