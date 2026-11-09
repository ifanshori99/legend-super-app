// Public brand website home: GET /api/public/site and the staff content
// endpoints (PRD v1.7 §3 item 24 "Website Publik per Brand"; WS-08 slice S1,
// design in docs/briefs/sub-ws08.md). Written from the spec, not from the
// implementation, so it may fail until S1 lands.
//
// Every scenario runs on its own isolated tenant, so the seeded Cafe Legend
// rows and the exact-match menu assertions of guest-menu-api.test.ts stay
// untouched.
//
// Assumptions (spec is silent):
//  - Staff PUT body is `{ content, publish }`: `content` is
//    brandWebsiteContentSchema, `publish` a boolean.
//  - Validation failure on PUT answers 400; a missing permission answers 403,
//    no session answers 401; a brand of another tenant answers 403 or 404.
//  - Errors use the app envelope `body.error.code`.
//  - A seeded active item with a photo shows up in `featuredMenuItems`.
//  - `memberLoginUrl` must satisfy publicSiteSchema (https URL). The S1 brief
//    says "relative /member", which that schema rejects: this test asserts the
//    schema AND that the URL points at /member, so the conflict surfaces.
//  - Opening hours live in `outlets.opening_hours` as `{ mon: {opens, closes} }`
//    and are exposed as publicOpeningHoursSchema entries (0 = Sunday); entries
//    may be grouped by days, so the test flattens them per day.

import { randomUUID } from "node:crypto";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publicSiteSchema } from "@starter/shared/website";
import { createApp } from "../app";
import { agent, originHeader, signUp } from "./helpers";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  staffOfIsolatedTenant,
  type IsolatedTenant,
} from "./floor-test-helpers";

const app = createApp();
const pool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const PLATFORM_NAMES = [
  "express tanstack postgres",
  "legend super app",
  "starter",
];

/** Tenant-scoped transaction: RLS is FORCED on tenant tables. */
async function asTenant<T>(
  tenantId: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

const suffix = () => `s${randomUUID().slice(0, 5)}`;

function siteContent(marker: string, hostname: string) {
  return {
    tagline: `Tagline ${marker}`,
    description: `Deskripsi ${marker}: kopi dan makanan ringan di Bandung.`,
    heroImages: [
      { url: `https://img.example/hero-${marker}.jpg`, alt: `Ruang ${marker}` },
    ],
    gallery: [],
    highlights: [
      { title: `Sorotan ${marker}`, description: "Biji kopi lokal sangrai." },
    ],
    address: {
      streetLine: "Jl. Braga 10",
      district: "Sumur Bandung",
      city: "Bandung",
      province: "Jawa Barat",
      postalCode: "40111",
      country: "ID",
    },
    geo: { latitude: -6.9175, longitude: 107.6191 },
    contact: {
      whatsapp: "6281234567890",
      email: null,
      instagramUrl: null,
      googleBusinessProfileUrl: null,
    },
    seo: {
      title: `Kafe ${marker}`,
      description: `Kafe ${marker} di Bandung.`,
      canonicalUrl: `https://${hostname}/`,
      ogImageUrl: null,
      robots: "index,follow",
      language: "id",
    },
    googleBusinessUrl: null,
  };
}

async function setBrandName(tenant: IsolatedTenant, name: string) {
  await asTenant(tenant.tenantId, (db) =>
    db.query("UPDATE brands SET name = $3 WHERE tenant_id = $1 AND id = $2", [
      tenant.tenantId,
      tenant.brandId,
      name,
    ]),
  );
}

async function seedWebsite(
  tenant: IsolatedTenant,
  marker: string,
  published: boolean,
) {
  await asTenant(tenant.tenantId, (db) =>
    db.query(
      `INSERT INTO brand_websites (tenant_id, brand_id, outlet_id, content, published_at, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'seed', now())`,
      [
        tenant.tenantId,
        tenant.brandId,
        tenant.outletId,
        JSON.stringify(siteContent(marker, tenant.hostname)),
        published ? new Date() : null,
      ],
    ),
  );
}

async function seedReservationPolicy(tenant: IsolatedTenant, active: boolean) {
  await asTenant(tenant.tenantId, (db) =>
    db.query(
      `INSERT INTO reservation_policies
         (tenant_id, outlet_id, version, deposit_requirement, deposit_amount_idr, payment_window_minutes,
          free_cancellation_hours, late_cancellation_refund_bp, no_show_refund_bp, minimum_spend_idr,
          default_duration_minutes, slot_interval_minutes, is_active)
       VALUES ($1, $2, 'site-1', 'none', 0, 60, 24, 0, 0, 0, 90, 30, $3)`,
      [tenant.tenantId, tenant.outletId, active],
    ),
  );
}

async function purgeTenantWebsiteRows(tenant: IsolatedTenant) {
  await asTenant(tenant.tenantId, async (db) => {
    for (const table of [
      "brand_websites",
      "price_list_items",
      "price_lists",
      "menu_items",
      "menu_categories",
      "reservation_policies",
    ]) {
      await db.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        tenant.tenantId,
      ]);
    }
  });
}

const getSite = (hostname: string) =>
  agent(app).get("/api/public/site").set("Host", hostname);

// Tenant fixtures --------------------------------------------------------
let alpha: IsolatedTenant; // published, menu, hours, active reservation policy
let bravo: IsolatedTenant; // published, other content, inactive policy
let unpublished: IsolatedTenant; // content row with published_at NULL
let empty: IsolatedTenant; // brand without any content row
let admin: IsolatedTenant; // staff edit flow
const tenants: IsolatedTenant[] = [];

const ALPHA_BRAND = "Kopi Nusantara";
const BRAVO_BRAND = "Teh Priangan";
let photoItemId = "";
let adminStaff: Awaited<ReturnType<typeof staffOfIsolatedTenant>>;
let limitedStaff: { client: ReturnType<typeof agent> };
let outletScopedStaff: { client: ReturnType<typeof agent> };

beforeAll(async () => {
  const make = async (label: string) => {
    const tenant = await createIsolatedTenant(`${label}${suffix()}`);
    tenants.push(tenant);
    return tenant;
  };
  [alpha, bravo, unpublished, empty, admin] = await Promise.all([
    make("pa"),
    make("pb"),
    make("pu"),
    make("pe"),
    make("pd"),
  ]);

  await setBrandName(alpha, ALPHA_BRAND);
  await setBrandName(bravo, BRAVO_BRAND);
  await seedWebsite(alpha, "alpha", true);
  await seedWebsite(bravo, "bravo", true);
  await seedWebsite(unpublished, "hidden", false);
  await seedReservationPolicy(alpha, true);
  await seedReservationPolicy(bravo, false);

  // Outlet opening hours that differ from the fixture default (08:00-22:00).
  const weekday = { opens: "09:30", closes: "21:15" };
  const weekend = { opens: "10:00", closes: "23:30" };
  await asTenant(alpha.tenantId, (db) =>
    db.query(
      "UPDATE outlets SET opening_hours = $3 WHERE tenant_id = $1 AND id = $2",
      [
        alpha.tenantId,
        alpha.outletId,
        JSON.stringify({
          mon: weekday,
          tue: weekday,
          wed: weekday,
          thu: weekday,
          fri: weekday,
          sat: weekend,
          sun: weekend,
        }),
      ],
    ),
  );

  // Menu: one active item with a photo, one active item without (owner Q23).
  const ids = {
    category: randomUUID(),
    priceList: randomUUID(),
    withoutPhoto: randomUUID(),
  };
  photoItemId = randomUUID();
  await asTenant(alpha.tenantId, async (db) => {
    await db.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Kopi Uji', 0)`,
      [ids.category, alpha.tenantId, alpha.brandId],
    );
    await db.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Berfoto', true, $5)`,
      [photoItemId, alpha.tenantId, alpha.brandId, ids.category, randomUUID()],
    );
    await db.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Tanpa Foto', true, NULL)`,
      [ids.withoutPhoto, alpha.tenantId, alpha.brandId, ids.category],
    );
    await db.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [ids.priceList, alpha.tenantId, alpha.outletId],
    );
    for (const [itemId, price] of [
      [photoItemId, 24000],
      [ids.withoutPhoto, 18000],
    ] as const) {
      await db.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), alpha.tenantId, ids.priceList, itemId, price],
      );
    }
  });

  // Staff of the admin tenant: one with brand/theme management, one without.
  await asTenant(admin.tenantId, (db) =>
    db.query(
      "UPDATE roles SET permissions = $3 WHERE tenant_id = $1 AND id = $2",
      [
        admin.tenantId,
        admin.roleId,
        JSON.stringify(["org.theme.manage", "floor.table.view"]),
      ],
    ),
  );
  adminStaff = await staffOfIsolatedTenant(app, admin);

  const limitedRoleId = randomUUID();
  await asTenant(admin.tenantId, (db) =>
    db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Floor Viewer', false, NULL, $3, false, '["tenant"]')`,
      [limitedRoleId, admin.tenantId, JSON.stringify(["floor.table.view"])],
    ),
  );
  const limitedClient = agent(app);
  const email = await signUp(limitedClient, "Limited Staff");
  const session = await limitedClient.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await asTenant(admin.tenantId, (db) =>
    db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [admin.tenantId, userId, limitedRoleId],
    ),
  );
  expect(email).toContain("@");
  limitedStaff = { client: limitedClient };

  // org.theme.manage granted at OUTLET scope only, never tenant-wide.
  const outletRoleId = randomUUID();
  await asTenant(admin.tenantId, (db) =>
    db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Outlet Theme Manager', false, NULL, $3, false, '["tenant","outlet"]')`,
      [outletRoleId, admin.tenantId, JSON.stringify(["org.theme.manage"])],
    ),
  );
  const outletClient = agent(app);
  await signUp(outletClient, "Outlet Theme Staff");
  const outletSession = await outletClient.get("/api/auth/get-session");
  const outletUserId = outletSession.body.user.id as string;
  await asTenant(admin.tenantId, (db) =>
    db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
      [admin.tenantId, outletUserId, outletRoleId, admin.outletId],
    ),
  );
  outletScopedStaff = { client: outletClient };
});

afterAll(async () => {
  for (const tenant of tenants) {
    await purgeTenantWebsiteRows(tenant);
    await dropIsolatedTenant(tenant);
  }
  await pool.end();
});

describe("GET /api/public/site (published website)", () => {
  it("WS08-S1: a published site answers 200 and parses publicSiteSchema", async () => {
    const response = await getSite(alpha.hostname).expect(200);
    const parsed = publicSiteSchema.safeParse(response.body.data);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
    expect(response.body.data.brand.tagline).toBe("Tagline alpha");
    expect(response.body.data.outlet.id).toBe(alpha.outletId);
    expect(response.body.data.heroImages[0].url).toBe(
      "https://img.example/hero-alpha.jpg",
    );
    expect(response.body.data.pricesExcludeTaxAndService).toBe(true);
  });

  it("WS08-S1: the body leaks no internal fields", async () => {
    const response = await getSite(alpha.hostname).expect(200);
    const data = response.body.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(
      Object.keys(publicSiteSchema.shape).sort(),
    );

    const forbiddenKeys = new Set([
      "tenantid",
      "tenant_id",
      "updatedby",
      "updated_by",
      "publishedat",
      "published_at",
      "brandid",
      "brand_id",
      "outletid",
      "outlet_id",
    ]);
    const uuidPaths: string[] = [];
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const walk = (value: unknown, at: string) => {
      if (typeof value === "string") {
        if (uuid.test(value)) uuidPaths.push(at);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((entry, i) => walk(entry, `${at}.${i}`));
        return;
      }
      if (value && typeof value === "object") {
        for (const [key, entry] of Object.entries(value)) {
          expect(forbiddenKeys.has(key.toLowerCase()), `${at}.${key}`).toBe(
            false,
          );
          walk(entry, `${at}.${key}`);
        }
      }
    };
    walk(data, "$");

    // publicSiteSchema itself exposes brand.id, outlet.id and menu/promotion
    // ids; no other uuid-shaped value may appear.
    for (const at of uuidPaths) {
      expect(at).toMatch(
        /^\$\.(brand\.id|outlet\.id|featuredMenuItems\.\d+\.id|promotions\.\d+\.id)$/,
      );
    }
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain(alpha.tenantId);
    expect(raw).not.toContain('"seed"');
  });

  it("WS08-S1: the member login link points at /member", async () => {
    const response = await getSite(alpha.hostname).expect(200);
    expect(new URL(response.body.data.memberLoginUrl).pathname).toBe("/member");
  });

  it("TEN-08 WS08-S1: the brand name comes from the tenant's brand row", async () => {
    const response = await getSite(alpha.hostname).expect(200);
    expect(response.body.data.brand.name).toBe(ALPHA_BRAND);
    expect(response.body.data.brand.id).toBe(alpha.brandId);
    const other = await getSite(bravo.hostname).expect(200);
    expect(other.body.data.brand.name).toBe(BRAVO_BRAND);
  });

  it("TEN-08 WS08-S1: no platform or starter name appears in the page", async () => {
    for (const hostname of [alpha.hostname, bravo.hostname]) {
      const response = await getSite(hostname).expect(200);
      const text = JSON.stringify(response.body).toLowerCase();
      for (const name of PLATFORM_NAMES) expect(text).not.toContain(name);
    }
    // The error page is a tenant page too.
    const missing = await getSite(empty.hostname).expect(404);
    const errorText = JSON.stringify(missing.body).toLowerCase();
    for (const name of PLATFORM_NAMES) expect(errorText).not.toContain(name);
  });

  it("WS08-S1: opening hours come from the outlet row", async () => {
    const response = await getSite(alpha.hostname).expect(200);
    const perDay = new Map<number, { opens: string; closes: string }>();
    for (const entry of response.body.data.outlet.openingHours as {
      daysOfWeek: number[];
      opens: string;
      closes: string;
    }[]) {
      for (const day of entry.daysOfWeek)
        perDay.set(day, { opens: entry.opens, closes: entry.closes });
    }
    // 0 = Sunday, 1 = Monday, 6 = Saturday.
    expect(perDay.get(1)).toEqual({ opens: "09:30", closes: "21:15" });
    expect(perDay.get(5)).toEqual({ opens: "09:30", closes: "21:15" });
    expect(perDay.get(6)).toEqual({ opens: "10:00", closes: "23:30" });
    expect(perDay.get(0)).toEqual({ opens: "10:00", closes: "23:30" });
  });

  it("Q23 WS08-S1: featured items include a photo item and exclude an item without a photo", async () => {
    const response = await getSite(alpha.hostname).expect(200);
    const featured = response.body.data.featuredMenuItems as {
      id: string;
      name: string;
      priceIdr: number;
    }[];
    const names = featured.map((item) => item.name);
    expect(names).toContain("Kopi Berfoto");
    expect(names).not.toContain("Kopi Tanpa Foto");
    expect(featured.find((item) => item.id === photoItemId)?.priceIdr).toBe(
      24000,
    );
  });

  it("WS08-S1: acceptsReservations follows an active reservation policy", async () => {
    const withPolicy = await getSite(alpha.hostname).expect(200);
    expect(withPolicy.body.data.acceptsReservations).toBe(true);
    const inactive = await getSite(bravo.hostname).expect(200);
    expect(inactive.body.data.acceptsReservations).toBe(false);
  });

  it("WS08-S1: a published site is cacheable for 60 seconds, an error is not", async () => {
    const published = await getSite(alpha.hostname).expect(200);
    expect(published.headers["cache-control"]).toMatch(/public/);
    expect(published.headers["cache-control"]).toMatch(/max-age=60/);
    const missing = await getSite(empty.hostname).expect(404);
    expect(missing.headers["cache-control"] ?? "").not.toMatch(/public/);
  });
});

describe("GET /api/public/site (not published)", () => {
  it("WS08-S1: a brand without a content row answers 404 PUBLIC_SITE_NOT_PUBLISHED", async () => {
    const response = await getSite(empty.hostname).expect(404);
    expect(response.body.error.code).toBe("PUBLIC_SITE_NOT_PUBLISHED");
  });

  it("WS08-S1: a content row with published_at NULL answers 404 PUBLIC_SITE_NOT_PUBLISHED", async () => {
    const response = await getSite(unpublished.hostname).expect(404);
    expect(response.body.error.code).toBe("PUBLIC_SITE_NOT_PUBLISHED");
    expect(JSON.stringify(response.body)).not.toContain("Tagline hidden");
  });

  it("TEN-02 WS08-S1: an unknown host has no public site", async () => {
    await getSite("unknown-brand.example").expect(404);
  });
});

describe("tenant isolation (TEN-01, TEN-02)", () => {
  it("TEN-02 WS08-S1: each tenant host returns only its own content", async () => {
    const a = await getSite(alpha.hostname).expect(200);
    const b = await getSite(bravo.hostname).expect(200);
    expect(a.body.data.brand.tagline).toBe("Tagline alpha");
    expect(b.body.data.brand.tagline).toBe("Tagline bravo");
    const aText = JSON.stringify(a.body);
    const bText = JSON.stringify(b.body);
    expect(aText).not.toContain("bravo");
    expect(aText).not.toContain(BRAVO_BRAND);
    expect(aText).not.toContain(bravo.outletId);
    expect(bText).not.toContain("alpha");
    expect(bText).not.toContain(ALPHA_BRAND);
    expect(bText).not.toContain(alpha.outletId);
    // Tenant B has no menu items of its own; A's items must not leak in.
    expect(JSON.stringify(b.body.data.featuredMenuItems)).not.toContain(
      "Kopi Berfoto",
    );
  });

  it("TEN-02 WS08-S1: a tenant without a published site never falls back to another tenant's", async () => {
    // Other tenants are published at this moment; this one must still be 404.
    await getSite(alpha.hostname).expect(200);
    const response = await getSite(empty.hostname).expect(404);
    expect(response.body.error.code).toBe("PUBLIC_SITE_NOT_PUBLISHED");
    expect(JSON.stringify(response.body)).not.toContain("alpha");
  });
});

describe("staff content endpoints /api/website/brands/:brandId/content", () => {
  const path = (tenant: IsolatedTenant) =>
    `/api/website/brands/${tenant.brandId}/content`;

  it("WS08-S1: without a session PUT is 401 and GET is 401", async () => {
    const put = await agent(app)
      .put(path(admin))
      .set({ ...originHeader, Host: admin.hostname })
      .send({ content: siteContent("anon", admin.hostname), publish: true });
    expect(put.status).toBe(401);
    const get = await agent(app)
      .get(path(admin))
      .set({ Host: admin.hostname });
    expect(get.status).toBe(401);
  });

  it("WS08-S1: staff without brand/theme permission get 403 on PUT and GET", async () => {
    const headers = { ...originHeader, Host: admin.hostname };
    const put = await limitedStaff.client
      .put(path(admin))
      .set(headers)
      .send({ content: siteContent("nope", admin.hostname), publish: true });
    expect(put.status).toBe(403);
    const get = await limitedStaff.client.get(path(admin)).set(headers);
    expect(get.status).toBe(403);
  });

  it("WS08-S1: org.theme.manage granted only at outlet scope gets 403 on every staff path", async () => {
    const headers = { ...originHeader, Host: admin.hostname };
    const content = siteContent("outlet-scope", admin.hostname);
    const draft = await outletScopedStaff.client
      .put(path(admin))
      .set(headers)
      .send({ content, publish: false });
    expect(draft.status).toBe(403);
    const publish = await outletScopedStaff.client
      .put(path(admin))
      .set(headers)
      .send({ content, publish: true });
    expect(publish.status).toBe(403);
    const get = await outletScopedStaff.client.get(path(admin)).set(headers);
    expect(get.status).toBe(403);
  });

  it("TEN-02 WS08-S1: staff of tenant B cannot edit tenant A's brand", async () => {
    const response = await adminStaff.client
      .put(path(alpha))
      .set({ ...originHeader, Host: admin.hostname })
      .send({ content: siteContent("intruder", alpha.hostname), publish: true });
    expect([403, 404]).toContain(response.status);
    const site = await getSite(alpha.hostname).expect(200);
    expect(site.body.data.brand.tagline).toBe("Tagline alpha");
  });

  it("WS08-S1: PUT validates content, a draft stays hidden, publish makes GET return 200", async () => {
    const headers = { ...originHeader, Host: admin.hostname };
    const valid = siteContent("edited", admin.hostname);

    // Invalid content: no hero image and a non-https URL.
    const invalid = await adminStaff.client
      .put(path(admin))
      .set(headers)
      .send({
        content: {
          ...valid,
          heroImages: [],
          seo: { ...valid.seo, canonicalUrl: "http://insecure.example/" },
        },
        publish: true,
      });
    expect(invalid.status).toBe(422);
    await getSite(admin.hostname).expect(404);

    // Missing publish flag is a validation error too.
    const noFlag = await adminStaff.client
      .put(path(admin))
      .set(headers)
      .send({ content: valid });
    expect(noFlag.status).toBe(422);

    // Draft save: stored but not public.
    const draft = await adminStaff.client
      .put(path(admin))
      .set(headers)
      .send({ content: valid, publish: false });
    expect(draft.status).toBe(200);
    const hidden = await getSite(admin.hostname).expect(404);
    expect(hidden.body.error.code).toBe("PUBLIC_SITE_NOT_PUBLISHED");

    // Staff can read the stored draft back.
    const read = await adminStaff.client.get(path(admin)).set(headers);
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).toContain("Tagline edited");

    // Publish: the public site now answers 200 with the saved content.
    const publish = await adminStaff.client
      .put(path(admin))
      .set(headers)
      .send({ content: valid, publish: true });
    expect(publish.status).toBe(200);
    const live = await getSite(admin.hostname).expect(200);
    expect(publicSiteSchema.safeParse(live.body.data).success).toBe(true);
    expect(live.body.data.brand.tagline).toBe("Tagline edited");
  });
});

describe("featured outlet and publishability (WS08-S1 review)", () => {
  let multi: IsolatedTenant; // brand with two outlets, site featured on B
  const outletB = randomUUID();
  const photoItem = randomUUID();
  const PRICE_A = 10000;
  const PRICE_B = 20000;
  const path = (tenant: IsolatedTenant) =>
    `/api/website/brands/${tenant.brandId}/content`;

  beforeAll(async () => {
    multi = await createIsolatedTenant(`pm${suffix()}`);
    tenants.push(multi);
    const category = randomUUID();
    const listA = randomUUID();
    const listB = randomUUID();
    await asTenant(multi.tenantId, async (db) => {
      await db.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
         SELECT $1, tenant_id, brand_id, legal_entity_id, $3, 'Outlet B', 'Jl. B 2', timezone, opening_hours, 'active'
           FROM outlets WHERE tenant_id = $2 AND id = $4`,
        [
          outletB,
          multi.tenantId,
          `OB-${randomUUID().slice(0, 6).toUpperCase()}`,
          multi.outletId,
        ],
      );
      await db.query(
        `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
         VALUES ($1, $2, $3, 'Kopi', 0)`,
        [category, multi.tenantId, multi.brandId],
      );
      await db.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
         VALUES ($1, $2, $3, $4, 'Kopi Dua Outlet', true, $5)`,
        [photoItem, multi.tenantId, multi.brandId, category, randomUUID()],
      );
      for (const [list, outlet, price] of [
        [listA, multi.outletId, PRICE_A],
        [listB, outletB, PRICE_B],
      ] as const) {
        await db.query(
          `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
           VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
          [list, multi.tenantId, outlet],
        );
        await db.query(
          `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), multi.tenantId, list, photoItem, price],
        );
      }
      await db.query(
        `INSERT INTO brand_websites (tenant_id, brand_id, outlet_id, content, published_at, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, now(), 'seed', now())`,
        [
          multi.tenantId,
          multi.brandId,
          outletB,
          JSON.stringify(siteContent("multi", multi.hostname)),
        ],
      );
    });
  });

  it("WS08-S1: featured items and outlet come from the site's outlet, not the brand's first one", async () => {
    const response = await getSite(multi.hostname).expect(200);
    expect(response.body.data.outlet.id).toBe(outletB);
    const featured = response.body.data.featuredMenuItems as {
      id: string;
      priceIdr: number;
    }[];
    expect(featured.map((item) => item.id)).toEqual([photoItem]);
    expect(featured[0]?.priceIdr).toBe(PRICE_B);
  });

  it("WS08-S1: a site whose outlet is not active answers 404 PUBLIC_SITE_NOT_PUBLISHED", async () => {
    await asTenant(multi.tenantId, (db) =>
      db.query("UPDATE outlets SET status = 'preopening' WHERE id = $1", [
        outletB,
      ]),
    );
    const response = await getSite(multi.hostname).expect(404);
    expect(response.body.error.code).toBe("PUBLIC_SITE_NOT_PUBLISHED");
  });

  it("WS08-S1: the member link uses the resolved tenant domain", async () => {
    const response = await getSite(alpha.hostname).expect(200);
    expect(new URL(response.body.data.memberLoginUrl).host).toBe(
      alpha.hostname,
    );
  });

  it("WS08-S1: publishing with an outlet that is not active is refused with 422", async () => {
    const headers = { ...originHeader, Host: admin.hostname };
    await asTenant(admin.tenantId, (db) =>
      db.query("UPDATE outlets SET status = 'preopening' WHERE id = $1", [
        admin.outletId,
      ]),
    );
    const body = siteContent("closed", admin.hostname);
    const publish = await adminStaff.client
      .put(path(admin))
      .set(headers)
      .send({ content: body, publish: true });
    expect(publish.status).toBe(422);
    expect(publish.body.error.code).toBe("BRAND_WEBSITE_OUTLET_NOT_PUBLISHABLE");
    // A draft can still be saved.
    const draft = await adminStaff.client
      .put(path(admin))
      .set(headers)
      .send({ content: body, publish: false });
    expect(draft.status).toBe(200);
  });
});
