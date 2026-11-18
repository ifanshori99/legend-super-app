// Sealed-secret re-seal of push subscriptions (bead legend-rj284, card K1,
// design docs/design/reseal-chatgpt-push.md sections 4.1, 4.2 and 7: P1-P6).
// Runs against PostgreSQL with the restricted app role (RLS enforced) and a key
// ring of versions 1 and 2 with version 2 active. Rows "written before the
// rotation" are sealed under version 1.
//
// Written from the design's contract, not from the job's implementation:
//   - push_subscriptions.subscription_ciphertext is a tenant-scope registry
//     column, sealed with AAD `push-subscription:<tenantId>:<userId>`
//     (the per-user part comes from the row's user_id column);
//   - the key-version label column `key_version` (`v<N>`) moves with the
//     ciphertext in the SAME compare-and-set UPDATE, so it is only written when
//     the ciphertext write hits;
//   - a row locked by another transaction is skipped (SKIP LOCKED): neither
//     resealed nor failed, still counted in `remaining`, picked up next run;
//   - a row that will not open is counted `failed`, left unchanged, still in
//     `remaining`;
//   - an UPDATE that touches 0 rows (row deleted or changed since it was read)
//     is counted neither resealed nor failed.
//
// Assumptions:
//   - The registry entry is found by table + column in SEALED_SECRET_COLUMNS
//     (`push_subscriptions` / `subscription_ciphertext`); the run is limited to
//     it through the `columns` option, so no other sweep runs.
//   - The `owner` connection may create triggers on push_subscriptions. P5/P6
//     use a per-row BEFORE UPDATE trigger (scoped to one row id, dropped in a
//     finally block) to make the job's UPDATE touch 0 rows, because the job's
//     own row lock leaves no other way to interleave a writer. The trigger
//     function is SECURITY DEFINER so it may delete the row it fires for.
//   - Required columns not named below are nullable or defaulted; foreign keys
//     are bypassed while seeding only (session_replication_role = replica).
//   - `remaining` counts every row still below the active version, locked or
//     not.
import { randomBytes, randomUUID } from "node:crypto";
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
const { KEY2 } = vi.hoisted(() => {
  const key = Buffer.alloc(32, 7).toString("base64");
  process.env.DATA_ENCRYPTION_KEYS = `2:${key}`;
  process.env.DATA_ENCRYPTION_ACTIVE_KEY_VERSION = "2";
  return { KEY2: key };
});

import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  openPushSubscription,
  pushEndpointHash,
  type StoredPushSubscription,
} from "../lib/push-subscription.ts";
import {
  currentSealVersion,
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
const KEY = "push_subscriptions.subscription_ciphertext";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const aadOf = (tenant: string, userId: string) =>
  `push-subscription:${tenant}:${userId}`;

// --- database helpers -------------------------------------------------------

async function inTenant<T>(
  client: PoolClient,
  tenant: string,
  run: () => Promise<T>,
): Promise<T> {
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
    [tenant],
  );
  return run();
}

async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
  options: { replica?: boolean } = { replica: true },
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await inTenant(client, tenant, async () => undefined);
    // Fixtures only: no foreign keys or triggers while seeding or cleaning.
    if (options.replica)
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

const touched: string[] = [];

type Seeded = {
  id: string;
  userId: string;
  endpointHash: string;
  subscription: StoredPushSubscription;
  /** What was written: envelope under version 1. */
  sealed: string;
};

const newSubscription = (): StoredPushSubscription => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(12).toString("hex")}`,
  keys: {
    p256dh: randomBytes(65).toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  },
});

/** Insert a push subscription row. Default: sealed under version 1 with the writer's AAD. */
async function seed(
  options: {
    userId?: string;
    ciphertext?: string;
    keyVersion?: string;
    subscription?: StoredPushSubscription;
  } = {},
): Promise<Seeded> {
  const id = randomUUID();
  const userId = options.userId ?? randomUUID();
  const subscription = options.subscription ?? newSubscription();
  const endpointHash = pushEndpointHash(subscription.endpoint);
  const sealed =
    options.ciphertext ??
    sealSecretBaseKey(JSON.stringify(subscription), aadOf(tenantA, userId));
  await asOwner(tenantA, (client) =>
    client.query(
      `INSERT INTO public.push_subscriptions
         (tenant_id, id, user_id, endpoint_hash, subscription_ciphertext, key_version)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        tenantA,
        id,
        userId,
        endpointHash,
        sealed,
        options.keyVersion ?? `v${sealedVersion(sealed)}`,
      ],
    ),
  );
  touched.push(id);
  return { id, userId, endpointHash, subscription, sealed };
}

async function stored(id: string): Promise<{
  ciphertext: string;
  keyVersion: string;
  userId: string;
  endpointHash: string;
} | null> {
  return asOwner(tenantA, async (client) => {
    const { rows } = await client.query(
      `SELECT subscription_ciphertext, key_version, user_id::text AS user_id, endpoint_hash
         FROM public.push_subscriptions WHERE tenant_id = $1 AND id = $2`,
      [tenantA, id],
    );
    const row = rows[0];
    return row
      ? {
          ciphertext: String(row.subscription_ciphertext),
          keyVersion: String(row.key_version),
          userId: String(row.user_id),
          endpointHash: String(row.endpoint_hash),
        }
      : null;
  });
}

function pushColumn() {
  const column = SEALED_SECRET_COLUMNS.find(
    (c) =>
      c.table === "push_subscriptions" &&
      c.column === "subscription_ciphertext",
  );
  expect(
    column,
    "registry must cover push_subscriptions.subscription_ciphertext",
  ).toBeDefined();
  return column!;
}

async function run(
  options: { reportOnly?: boolean } = {},
): Promise<SealedSecretResealResult> {
  return runSealedSecretReseal({
    columns: [pushColumn()],
    listTenantIds: async () => [tenantA],
    batchSize: 2,
    log: { error: () => {} },
    ...(options.reportOnly ? { reportOnly: true } : {}),
  });
}

/** Never let a blocked run hang the suite. */
async function bounded<T>(work: Promise<T>, ms = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`run did not finish within ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Seal through the real writer with version 1 active (a pre-rotation process). */
async function sealUnderV1(
  subscription: StoredPushSubscription,
  userId: string,
) {
  vi.resetModules();
  vi.stubEnv("DATA_ENCRYPTION_KEYS", `2:${KEY2}`);
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_VERSION", "1");
  try {
    const writer = await import("../lib/push-subscription.ts");
    return await writer
      .createPushSubscriptionProtector()
      .seal(subscription, tenantA, userId);
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  expect(currentSealVersion()).toBe(2);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Push reseal tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [tenantA, `push-reseal-${tenantA.slice(0, 8)}`, fixtureTenant],
  );
});

async function clearState() {
  await owner.query(
    "DELETE FROM sealed_secret_reseal_state WHERE scope_key = $1",
    [tenantA],
  );
}

beforeEach(clearState);

afterEach(async () => {
  for (const id of touched.splice(0))
    await asOwner(tenantA, (client) =>
      client.query(
        "DELETE FROM public.push_subscriptions WHERE tenant_id = $1 AND id = $2",
        [tenantA, id],
      ),
    ).catch(() => undefined);
});

afterAll(async () => {
  await clearState();
  await asOwner(tenantA, (client) =>
    client.query("DELETE FROM tenants WHERE id = $1", [tenantA]),
  );
  await owner.end();
});

// --- P1: round trip through the real protector ------------------------------

describe("[legend-rj284] push subscriptions move to the active key", () => {
  it("P1 round trip: sealed under v1 by the real protector, resealed under v2, key_version v2, still opens", async () => {
    const subscription = newSubscription();
    const userId = randomUUID();
    const sealed = await sealUnderV1(subscription, userId);
    expect(sealedVersion(sealed.ciphertext)).toBe(1);
    expect(sealed.keyVersion).toBe("v1");
    const row = await seed({
      userId,
      subscription,
      ciphertext: sealed.ciphertext,
      keyVersion: sealed.keyVersion,
    });

    const result = await bounded(run());

    expect(result).toMatchObject({
      activeVersion: 2,
      failedTenants: 0,
      aborted: false,
    });
    expect(result.tables[KEY]).toMatchObject({
      resealed: 1,
      failed: 0,
      remaining: 0,
      frozen: 0,
    });
    expect(sealedSecretUnresolved(result)).toBe(0);

    const after = await stored(row.id);
    expect(after).not.toBeNull();
    expect(after!.keyVersion).toBe("v2");
    expect(sealedVersion(after!.ciphertext)).toBe(2);
    expect(after!.ciphertext).not.toBe(row.sealed);
    // The reader the push worker uses, with the same AAD inputs and hash.
    expect(
      openPushSubscription(
        after!.ciphertext,
        tenantA,
        userId,
        after!.endpointHash,
      ),
    ).toEqual(subscription);
  });

  // --- P2: locked row -------------------------------------------------------

  it("P2 locked row: skipped (not failed) while another connection holds FOR UPDATE, counted remaining, resealed on the rerun", async () => {
    const row = await seed();
    const holder = await owner.connect();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await holder.query("COMMIT").catch(() => undefined);
      holder.release();
    };
    try {
      await holder.query("BEGIN");
      await inTenant(holder, tenantA, async () => undefined);
      await holder.query(
        "SELECT 1 FROM public.push_subscriptions WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [tenantA, row.id],
      );

      const whileLocked = await bounded(run());
      expect(whileLocked).toMatchObject({ failedTenants: 0, aborted: false });
      expect(whileLocked.tables[KEY]).toMatchObject({
        resealed: 0,
        failed: 0,
        remaining: 1,
      });
      expect(sealedSecretUnresolved(whileLocked)).toBe(1);
    } finally {
      await release();
    }
    const untouched = await stored(row.id);
    expect(untouched!.ciphertext).toBe(row.sealed);
    expect(untouched!.keyVersion).toBe("v1");

    const rerun = await bounded(run());
    expect(rerun.tables[KEY]).toMatchObject({
      resealed: 1,
      failed: 0,
      remaining: 0,
    });
    const after = await stored(row.id);
    expect(sealedVersion(after!.ciphertext)).toBe(2);
    expect(after!.keyVersion).toBe("v2");
  });

  // --- P3: idempotent -------------------------------------------------------

  it("P3 idempotent: a second run reseals 0 and leaves ciphertext and key_version as they were", async () => {
    const row = await seed();
    const first = await bounded(run());
    expect(first.tables[KEY]).toMatchObject({ resealed: 1, remaining: 0 });
    const afterFirst = await stored(row.id);
    expect(afterFirst!.keyVersion).toBe("v2");

    const second = await bounded(run());
    expect(second).toMatchObject({ failedTenants: 0, aborted: false });
    expect(second.tables[KEY]).toMatchObject({
      resealed: 0,
      failed: 0,
      remaining: 0,
      frozen: 0,
    });
    expect(await stored(row.id)).toEqual(afterFirst);
  });

  it("P3 a row already under the active key is not rewritten", async () => {
    // Sealed under v2 with a v2 label: nothing to do.
    const subscription = newSubscription();
    const userId = randomUUID();
    const current = sealSecret(
      JSON.stringify(subscription),
      aadOf(tenantA, userId),
    );
    const row = await seed({ userId, subscription, ciphertext: current });
    expect(row.sealed).toBe(current);

    const result = await bounded(run());
    expect(result.tables[KEY]).toMatchObject({
      resealed: 0,
      failed: 0,
      remaining: 0,
    });
    const after = await stored(row.id);
    expect(after!.ciphertext).toBe(current);
    expect(after!.keyVersion).toBe("v2");
  });

  // --- P4: per-user AAD -----------------------------------------------------

  it("P4 per-user AAD: a row whose user_id no longer matches the AAD is counted failed and left unchanged", async () => {
    const row = await seed();
    const other = randomUUID();
    await asOwner(tenantA, (client) =>
      client.query(
        "UPDATE public.push_subscriptions SET user_id = $3 WHERE tenant_id = $1 AND id = $2",
        [tenantA, row.id, other],
      ),
    );
    const before = await stored(row.id);

    const result = await bounded(run());

    expect(result).toMatchObject({ failedTenants: 0, aborted: false });
    expect(result.tables[KEY]).toMatchObject({
      resealed: 0,
      failed: 1,
      remaining: 1,
    });
    expect(sealedSecretUnresolved(result)).toBeGreaterThan(0);
    const after = await stored(row.id);
    expect(after).toEqual(before);
    expect(after!.ciphertext).toBe(row.sealed);
    expect(after!.keyVersion).toBe("v1");
  });

  // --- P5 / P6: the UPDATE touches 0 rows -----------------------------------

  /**
   * Runs `body` with a BEFORE UPDATE OF subscription_ciphertext trigger on one
   * row that cancels the job's UPDATE (RETURN NULL), optionally deleting the row
   * first. The job has already read and locked the row, so this is the same
   * outcome as "the row changed or vanished between select and update": 0 rows.
   */
  async function withCancelledUpdate<T>(
    id: string,
    mode: "delete" | "keep",
    body: () => Promise<T>,
  ): Promise<T> {
    const suffix = randomBytes(5).toString("hex");
    const fn = `p56_fn_${suffix}`;
    const trg = `p56_trg_${suffix}`;
    await owner.query(`
      CREATE FUNCTION public.${fn}() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        ${
          mode === "delete"
            ? "DELETE FROM public.push_subscriptions WHERE tenant_id = OLD.tenant_id AND id = OLD.id;"
            : ""
        }
        RETURN NULL;
      END $$`);
    try {
      await owner.query(`
        CREATE TRIGGER ${trg} BEFORE UPDATE OF subscription_ciphertext
        ON public.push_subscriptions FOR EACH ROW
        WHEN (OLD.id = '${id}'::uuid)
        EXECUTE FUNCTION public.${fn}()`);
      return await body();
    } finally {
      await owner.query(
        `DROP TRIGGER IF EXISTS ${trg} ON public.push_subscriptions`,
      );
      await owner.query(`DROP FUNCTION IF EXISTS public.${fn}()`);
    }
  }

  it("P5 row deleted between select and update: 0 rows touched, not failed, nothing left to count", async () => {
    const row = await seed();
    const result = await withCancelledUpdate(row.id, "delete", () =>
      bounded(run()),
    );

    expect(result).toMatchObject({ failedTenants: 0, aborted: false });
    expect(result.tables[KEY]).toMatchObject({
      resealed: 0,
      failed: 0,
      remaining: 0,
    });
    expect(await stored(row.id)).toBeNull();
  });

  it("P6 key_version is only set when the CAS hits: a missed ciphertext write leaves key_version (and the ciphertext) as written", async () => {
    const row = await seed();
    const missed = await withCancelledUpdate(row.id, "keep", () =>
      bounded(run()),
    );

    expect(missed).toMatchObject({ failedTenants: 0, aborted: false });
    expect(missed.tables[KEY]).toMatchObject({
      resealed: 0,
      failed: 0,
      remaining: 1,
    });
    const afterMiss = await stored(row.id);
    expect(afterMiss!.ciphertext).toBe(row.sealed);
    expect(afterMiss!.keyVersion).toBe("v1");

    // Without the interference the next run finishes the job: label and
    // ciphertext move together.
    const rerun = await bounded(run());
    expect(rerun.tables[KEY]).toMatchObject({
      resealed: 1,
      failed: 0,
      remaining: 0,
    });
    const after = await stored(row.id);
    expect(sealedVersion(after!.ciphertext)).toBe(2);
    expect(after!.keyVersion).toBe("v2");
  });

  // --- extras tied to 4.1 ---------------------------------------------------

  it("reportOnly counts the stale subscription and changes nothing (ciphertext and key_version)", async () => {
    const row = await seed();
    const result = await bounded(run({ reportOnly: true }));
    expect(result.tables[KEY]).toMatchObject({
      resealed: 0,
      failed: 0,
      remaining: 1,
    });
    expect(await stored(row.id)).toMatchObject({
      ciphertext: row.sealed,
      keyVersion: "v1",
    });
  });
});
