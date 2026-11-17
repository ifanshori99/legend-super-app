// AI-11 / TL-21 get_review_summary against PostgreSQL (bead legend-39d.5;
// brief docs/briefs/981-reviews.md). Runs the real handler with the restricted
// app role (RLS enforced) and an AccessSnapshot built from the RBAC fixtures,
// exactly like ai-tools-read-b.test.ts. Reviews are seeded through the owner
// connection into `customer_reviews` (migration 0455, bead legend-vqicf).
//
// Rules under test (brief):
// - minimum role = holders of `review.respond`, scope assigned_outlets: only
//   outlets in the caller's resolved outlet scope are summarised;
// - only aggregates: review count per outlet, average rating, 1..5 spread and
//   theme counts (fixed lexicon: makanan, pelayanan, harga, kebersihan,
//   waktu tunggu) over reviews whose moderation_status != 'hidden';
// - no raw text, name, phone or customer id in the output.
//
// Assumptions (the brief fixes the data, not the exact output field names):
// - Input follows the TL-11 convention: { period?, outletIds? }. The helper
//   tries the input with a period first and without if the catalog schema has
//   none. All seeded reviews are dated 2026-10-20, inside the period used.
// - The output holds one row per outlet that carries an `outletId`. The row
//   names its count `reviewCount` (or `count`/`total`), its mean
//   `avgRating` (or `averageRating`), the 1..5 spread `distribution` (or
//   `ratingDistribution`/`spread`; object keyed 1..5, array of 5 numbers or
//   array of {rating,count}) and themes `themes` (object name -> count or an
//   array of {theme|name|label|code, count}). An outlet without reviews may
//   be omitted or report 0.
// - A caller asking for an outlet outside their scope (another tenant's or a
//   sibling outlet) is rejected with AI_TOOL_FORBIDDEN, as TL-11 does.
// - The tool is registered in `readToolsB` next to TL-11 (brief: pattern
//   read-b/tl-11-anomalies.ts).
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { AI_TOOL_IO, type AiToolCode } from "@starter/shared/ai";
import { establishTenantContext } from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { readToolsB } from "../services/ai-tools/read-b/index.ts";
import type { AiToolContext } from "../services/ai-tools/types.ts";
import { resolveAccessSnapshot } from "../services/permission-resolver.ts";

const CODE = "TL-21" as AiToolCode;
const fx = cafeLegendAccessFixtures;
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = fx.outletIds.bandung;
const outletB = fx.outletIds.bandung2;
const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherEntity = randomUUID();
const otherOutlet = randomUUID();
const outletEmpty = randomUUID();
const tenantObject = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
  replica = false,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
    );
    if (replica)
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

function ctxFor(userKey: keyof typeof fx.users): AiToolContext {
  return {
    access: resolveAccessSnapshot({
      tenant: tenantObject,
      userId: fx.users[userKey].id,
      assignments: [...fx.assignments],
      roles: fx.roles,
      org: fx.org,
      mfaVerified: false,
      now: fx.now,
    }),
    channel: "tanya_ai",
    mcpClientId: null,
    now: fx.now,
  };
}

const PERIOD = { from: "2026-10-01", to: "2026-10-31" };

/** Calls the registered handler and checks the result against the catalog schema. */
async function call(
  userKey: keyof typeof fx.users,
  input: Record<string, unknown> = {},
): Promise<unknown> {
  const handler = (readToolsB as Record<string, unknown>)[CODE] as
    ((ctx: AiToolContext, input: unknown) => Promise<unknown>) | undefined;
  if (!handler) throw new Error(`No handler registered for ${CODE}`);
  const io = AI_TOOL_IO[CODE];
  if (!io) throw new Error(`No input/output schema in AI_TOOL_IO for ${CODE}`);
  const withPeriod = io.input.safeParse({ period: PERIOD, ...input });
  const parsed = withPeriod.success ? withPeriod : io.input.safeParse(input);
  if (!parsed.success) throw parsed.error;
  const output = await handler(ctxFor(userKey), parsed.data);
  return io.output.parse(output);
}

const forbidden = { code: "AI_TOOL_FORBIDDEN", status: 403 };

// ---- Output readers (tolerant of field naming, strict on values) -----------

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every object in the output that carries an `outletId`. */
function outletRows(out: unknown): Row[] {
  const found: Row[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (isRow(value)) {
      if (typeof value.outletId === "string") found.push(value);
      Object.values(value).forEach(walk);
    }
  };
  walk(out);
  return found;
}

function rowFor(out: unknown, outletId: string): Row | undefined {
  return outletRows(out).find(
    (row) => String(row.outletId).toLowerCase() === outletId.toLowerCase(),
  );
}

function field(row: Row, names: string[]): unknown {
  for (const name of names) if (row[name] !== undefined) return row[name];
  throw new Error(
    `Row has none of ${names.join("/")}; keys: ${Object.keys(row).join(", ")}`,
  );
}

function countOf(out: unknown, outletId: string): number {
  const row = rowFor(out, outletId);
  if (!row) return 0;
  return Number(field(row, ["reviewCount", "count", "total", "reviews"]));
}

function avgOf(out: unknown, outletId: string): number {
  const row = rowFor(out, outletId);
  if (!row) throw new Error(`No row for outlet ${outletId}`);
  return Number(field(row, ["avgRating", "averageRating", "ratingAvg"]));
}

/** Normalised spread: index 0 = rating 1 ... index 4 = rating 5. */
function spreadOf(out: unknown, outletId: string): number[] {
  const row = rowFor(out, outletId);
  if (!row) throw new Error(`No row for outlet ${outletId}`);
  const raw = field(row, ["distribution", "ratingDistribution", "spread"]);
  const spread = [0, 0, 0, 0, 0];
  if (Array.isArray(raw)) {
    if (raw.every((item) => typeof item === "number")) {
      expect(raw).toHaveLength(5);
      return raw as number[];
    }
    for (const item of raw as Row[]) {
      const rating = Number(field(item, ["rating", "stars", "score"]));
      spread[rating - 1] = Number(field(item, ["count", "total"]));
    }
    return spread;
  }
  for (const [key, value] of Object.entries(raw as Row))
    spread[Number(key) - 1] = Number(value);
  return spread;
}

function themeCount(out: unknown, outletId: string, theme: string): number {
  const row = rowFor(out, outletId);
  if (!row) throw new Error(`No row for outlet ${outletId}`);
  const raw = field(row, ["themes", "themeCounts", "topics"]);
  const norm = (text: unknown) =>
    String(text)
      .toLowerCase()
      .replace(/[_\s-]+/g, "");
  if (Array.isArray(raw)) {
    const hit = (raw as Row[]).find((item) =>
      ["theme", "name", "label", "code"].some(
        (key) => item[key] !== undefined && norm(item[key]) === norm(theme),
      ),
    );
    return hit ? Number(field(hit, ["count", "total", "mentions"])) : 0;
  }
  const entry = Object.entries(raw as Row).find(
    ([key]) => norm(key) === norm(theme),
  );
  return entry ? Number(entry[1]) : 0;
}

function allKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => allKeys(item, keys));
  else if (isRow(value))
    for (const [key, inner] of Object.entries(value)) {
      keys.push(key);
      allKeys(inner, keys);
    }
  return keys;
}

// ---- Seeds ------------------------------------------------------------------

const PHONE = "081234567890";
const REVIEWER_NAME = "Budi Santoso";
const PROFILE_NAME = "Pelanggan Rahasia RV";
const HIDDEN_MARKER = "KEYWORD-HIDDEN-ZZ";
const FOREIGN_MARKER = "KEYWORD-FOREIGN-ZZ";
const CREATED_AT = "2026-10-20T03:00:00Z";
const profileId = randomUUID();
const foreignProfileId = randomUUID();
const reviewIds: { tenant: string; id: string }[] = [];

async function seedReview(options: {
  tenant: string;
  outlet: string;
  rating: number;
  body: string | null;
  status: "pending" | "published" | "hidden";
  customerProfileId?: string | null;
}) {
  const id = randomUUID();
  await asOwner(
    options.tenant,
    (client) =>
      client.query(
        `INSERT INTO customer_reviews
           (id, tenant_id, outlet_id, customer_profile_id, rating, body, source, moderation_status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7, $8)`,
        [
          id,
          options.tenant,
          options.outlet,
          options.customerProfileId ?? null,
          options.rating,
          options.body,
          options.status,
          CREATED_AT,
        ],
      ),
    // Replica role: FK parents (orders, profiles) need not be built for a read test.
    true,
  );
  reviewIds.push({ tenant: options.tenant, id });
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  expect(fx.tenantId).toBe(tenantId);
  expect(outletA).toBe(cafeLegendPlatformFixtures.outlets[0].id);
  expect(outletB).toBe(cafeLegendPlatformFixtures.outlets[1].id);

  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Review summary other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `rev-sum-${otherTenant.slice(0, 8)}`, tenantId],
  );
  await asOwner(otherTenant, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand RV')`,
      [otherBrand, otherTenant],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT RV', false)`,
      [otherEntity, otherTenant],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'RV-01', 'Outlet RV', 'Jl. RV', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [otherOutlet, otherTenant, otherBrand, otherEntity],
    );
  });
  // A second own-tenant outlet that never gets a review (empty state).
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $3, 'Outlet RV kosong', address, 'Asia/Jakarta', opening_hours
       FROM outlets WHERE id = $2`,
    [outletEmpty, outletA, `RVE-${randomUUID().slice(0, 6)}`.toUpperCase()],
  );

  // Customer rows behind the reviews: the tool must never surface them.
  await asOwner(
    tenantId,
    (client) =>
      client.query(
        `INSERT INTO customer_profiles
           (id, tenant_id, name, membership_status, whatsapp_verified_at, lifetime_spend_idr,
            visits_count, first_visit_at, last_visit_at)
         VALUES ($1, $2, $3, 'active', '2026-01-02T00:00:00Z', 100000, 2,
                 '2026-01-05T03:00:00Z', '2026-10-20T03:00:00Z')`,
        [profileId, tenantId, PROFILE_NAME],
      ),
    true,
  );

  // Outlet A (counted): 5 published, 4 published, 2 pending -> 3 reviews,
  // mean 11/3. One theme word each (hidden-review words must not count).
  await seedReview({
    tenant: tenantId,
    outlet: outletA,
    rating: 5,
    status: "published",
    customerProfileId: profileId,
    body: `Makanan enak, pelayanan ramah. Hubungi ${REVIEWER_NAME} di ${PHONE}`,
  });
  await seedReview({
    tenant: tenantId,
    outlet: outletA,
    rating: 4,
    status: "published",
    body: "Harga murah dan kebersihan terjaga",
  });
  await seedReview({
    tenant: tenantId,
    outlet: outletA,
    rating: 2,
    status: "pending",
    body: "Waktu tunggu lama sekali",
  });
  // Outlet A hidden: would change count, mean, spread and theme counts.
  await seedReview({
    tenant: tenantId,
    outlet: outletA,
    rating: 1,
    status: "hidden",
    body: `Makanan basi ${HIDDEN_MARKER}`,
  });
  // Outlet B: two 3-star published, one hidden 5-star.
  for (const body of ["Biasa saja", null])
    await seedReview({
      tenant: tenantId,
      outlet: outletB,
      rating: 3,
      status: "published",
      body,
    });
  await seedReview({
    tenant: tenantId,
    outlet: outletB,
    rating: 5,
    status: "hidden",
    body: "Disembunyikan moderator",
  });
  // Another tenant's outlet: four 5-star reviews that must never be counted.
  for (let index = 0; index < 4; index += 1)
    await seedReview({
      tenant: otherTenant,
      outlet: otherOutlet,
      rating: 5,
      status: "published",
      customerProfileId: foreignProfileId,
      body: `Makanan luar biasa ${FOREIGN_MARKER}`,
    });
});

afterAll(async () => {
  for (const tenant of [tenantId, otherTenant])
    await asOwner(
      tenant,
      async (client) => {
        await client.query(
          "DELETE FROM customer_reviews WHERE tenant_id = $1 AND id = ANY($2)",
          [
            tenant,
            reviewIds.filter((r) => r.tenant === tenant).map((r) => r.id),
          ],
        );
      },
      true,
    ).catch(() => undefined);
  await asOwner(
    tenantId,
    (client) =>
      client.query(
        "DELETE FROM customer_profiles WHERE tenant_id = $1 AND id = $2",
        [tenantId, profileId],
      ),
    true,
  );
  await owner.query("DELETE FROM outlets WHERE tenant_id = $1 AND id = $2", [
    tenantId,
    outletEmpty,
  ]);
  await asOwner(otherTenant, async (client) => {
    await client.query("DELETE FROM outlets WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM brands WHERE tenant_id = $1", [
      otherTenant,
    ]);
  });
  await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  await owner.end();
});

// ---- Tests ------------------------------------------------------------------

describe("TL-21 get_review_summary", () => {
  it("is registered in the read tool registry", () => {
    expect(Object.keys(readToolsB)).toContain(CODE);
  });

  it("returns per-outlet aggregates: count, average, 1..5 spread, themes", async () => {
    const out = await call("marketing", { outletIds: [outletA, outletB] });
    // A: ratings 5, 4, 2 (hidden 1-star excluded; pending included).
    expect(countOf(out, outletA)).toBe(3);
    expect(avgOf(out, outletA)).toBeCloseTo(11 / 3, 2);
    expect(spreadOf(out, outletA)).toEqual([0, 1, 0, 1, 1]);
    // B: 3, 3 (hidden 5-star excluded).
    expect(countOf(out, outletB)).toBe(2);
    expect(avgOf(out, outletB)).toBeCloseTo(3, 2);
    expect(spreadOf(out, outletB)).toEqual([0, 0, 2, 0, 0]);
  });

  it("counts lexicon themes over visible reviews only", async () => {
    const out = await call("marketing", { outletIds: [outletA] });
    // The hidden review also says "makanan": it must not be counted.
    expect(themeCount(out, outletA, "makanan")).toBe(1);
    expect(themeCount(out, outletA, "pelayanan")).toBe(1);
    expect(themeCount(out, outletA, "harga")).toBe(1);
    expect(themeCount(out, outletA, "kebersihan")).toBe(1);
    expect(themeCount(out, outletA, "waktu tunggu")).toBe(1);
  });

  it("excludes hidden reviews from every figure and leaks nothing of them", async () => {
    const out = await call("marketing", { outletIds: [outletA, outletB] });
    // With the hidden rows the counts would be 4 and 3.
    expect(countOf(out, outletA)).not.toBe(4);
    expect(countOf(out, outletB)).not.toBe(3);
    expect(JSON.stringify(out)).not.toContain(HIDDEN_MARKER);
  });

  it("never counts another tenant's or an unscoped outlet's reviews", async () => {
    const out = await call("marketing");
    expect(rowFor(out, otherOutlet)).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(otherOutlet);
    expect(JSON.stringify(out)).not.toContain(FOREIGN_MARKER);
    expect(countOf(out, outletA)).toBe(3);
    expect(countOf(out, outletB)).toBe(2);
    // Asking for the foreign outlet directly is rejected, never rewritten.
    await expect(
      call("marketing", { outletIds: [otherOutlet] }),
    ).rejects.toMatchObject(forbidden);
  });

  it("an outlet manager sees only their outlet and is denied a sibling outlet", async () => {
    const own = await call("outletManager");
    expect(rowFor(own, outletA)).toBeDefined();
    expect(countOf(own, outletA)).toBe(3);
    expect(rowFor(own, outletB)).toBeUndefined();
    await expect(
      call("outletManager", { outletIds: [outletB] }),
    ).rejects.toMatchObject(forbidden);
  });

  it("an outlet without reviews reports none, not an error", async () => {
    const out = await call("marketing", { outletIds: [outletEmpty] });
    expect(countOf(out, outletEmpty)).toBe(0);
  });

  it.each(["employee", "cashier", "waiter"] as const)(
    "a role without review.respond (%s) is forbidden",
    async (userKey) => {
      await expect(call(userKey)).rejects.toMatchObject(forbidden);
    },
  );

  it("output holds no review text, name, phone or customer id", async () => {
    const outputs = [
      await call("marketing"),
      await call("marketing", { outletIds: [outletA] }),
      await call("outletManager"),
    ];
    for (const out of outputs) {
      const text = JSON.stringify(out);
      // Phone number and name typed inside a review body.
      expect(text).not.toContain(PHONE);
      expect(text).not.toContain("Budi");
      expect(text).not.toContain(REVIEWER_NAME);
      expect(text).not.toMatch(/08\d{8,}/);
      // Raw body fragments (including words outside the lexicon).
      expect(text).not.toContain("Hubungi");
      expect(text).not.toContain("ramah");
      expect(text).not.toContain("murah");
      expect(text).not.toContain("basi");
      expect(text).not.toContain("Disembunyikan");
      // The customer profile behind the review: id and name.
      expect(text).not.toContain(profileId);
      expect(text).not.toContain(PROFILE_NAME);
      // No field that could carry any of it.
      const keys = allKeys(out).map((key) => key.toLowerCase());
      for (const banned of [
        "body",
        "text",
        "comment",
        "excerpt",
        "snippet",
        "name",
        "phone",
        "whatsapp",
        "email",
        "customerid",
        "customerprofileid",
        "reviewid",
      ])
        expect(keys).not.toContain(banned);
    }
  });
});
