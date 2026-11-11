// Alur R (WS-01) + TEN-08 whitelabel, as one story (brief 91, slice 7).
//
// Story, from PRD §4 Alur R and "Whitelabel [P0]" / TEN-08:
//   1. The Super Admin signs in to the Panel Platform and creates tenant B
//      (the only place the platform may be named).
//   2. Tenant B gets its brand ("Kopi Senja") and a verified domain.
//   3. B's customers and staff, on B's host, see only B's brand: tenant
//      context, public website menu, error answers, e-mail, text catalog.
//   4. The seeded Cafe Legend tenant is held to the same rule.
//   5. Not yet in m1: the receipt and its PDF (ws/pos-receipt) and the
//      exported tenant configuration (ws/tenant-config-export).
//
// Assumptions (PRD does not give exact payloads):
//   - "Platform name" = every identity in starter.config.json / site.ts plus
//     the PRD name "Legend Super App" (D43). "Cafe Legend" is a tenant brand,
//     not the platform, so it is only forbidden inside tenant B's answers.
//   - Brand rows and the DNS-verified domain of tenant B are seeded with the
//     owner connection: tenant-admin onboarding of brand/domain is covered by
//     platform-org-api.test.ts and DNS verification is out of scope here.
//   - Tenant B is left in the disposable database (tenants are append-only
//     for audit); only the rows this file added are removed, best effort.
//   - Per-tenant sender e-mail is not testable yet (sender comes from the
//     deployment env in m1); the e-mail test checks that the delivery adds no
//     platform text to what the tenant wrote.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { MESSAGE_KEYS, messagesId } from "@starter/shared/i18n";
import { siteConfig } from "@starter/shared/site";
import { emailRequestSchema } from "@starter/shared/adapters";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../../app";
import { signDeviceToken } from "../../lib/device-token";
import { registerTestDevice } from "../device-seed";
import { setDeviceOutletResolver } from "../../services/device-pin.service";
import { createBrevoEmailProvider } from "../../worker/notification-adapters";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "../helpers";
import {
  describeUntilMerged,
  itUntilBuilt,
  itUntilMerged,
} from "./pending-branch.ts";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const app = createApp();
const fixtures = cafeLegendPlatformFixtures;
const legendHost = "pesan.cafelegend.example"; // seeded, DNS-verified domain
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

/** Identity of the platform. None of these may reach a tenant's audience. */
const PLATFORM_NAMES = [
  "legend super app",
  siteConfig.name.toLowerCase(),
  siteConfig.id.toLowerCase(),
  "ngodingpakeai",
  "powered by",
];
/** Labels of the Platform Panel itself ("Panel platform") are allowed in the catalog. */
const PANEL_LABEL = "panel platform";
function platformLeaks(value: unknown, names = PLATFORM_NAMES): string[] {
  const text = (
    typeof value === "string" ? value : JSON.stringify(value)
  ).toLowerCase();
  return names.filter((name) => text.includes(name));
}

const suffix = randomBytes(4).toString("hex");
const BRAND_B = "Kopi Senja";
const hostB = `senja-${suffix}.kopisenja.example`;
const adminUserIds: string[] = [];
const created: {
  tenantId?: string;
  brandId?: string;
  domainId?: string;
} = {};

async function asTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
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

async function platformAdmin() {
  const client = agent(app);
  const email = await signUp(client, "Super Admin Alur R");
  await setRole(email, "admin");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [userId],
  );
  adminUserIds.push(userId);
  await verifySessionMfa(email);
  return client;
}

let admin: ReturnType<typeof agent>;

beforeAll(async () => {
  admin = await platformAdmin();
});

afterAll(async () => {
  try {
    if (adminUserIds.length > 0)
      await owner.query(
        "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
        [adminUserIds],
      );
    if (created.domainId)
      await owner.query("DELETE FROM tenant_domains WHERE id = $1", [
        created.domainId,
      ]);
    if (created.tenantId && created.brandId)
      await asTenant(created.tenantId, async (client) => {
        await client.query("DELETE FROM outlets WHERE tenant_id = $1", [
          created.tenantId,
        ]);
        await client.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
          created.tenantId,
        ]);
        await client.query("DELETE FROM brands WHERE id = $1", [
          created.brandId,
        ]);
      });
  } catch {
    // Audit rows may pin the tenant; the unique suffix keeps reruns isolated.
  }
  await owner.end();
});

describe("Alur R: Super Admin menambah tenant baru, pelanggan hanya melihat brand tenant", () => {
  it("Alur R langkah 1-3, TEN-06: Super Admin membuat tenant B lewat Panel Platform", async () => {
    const response = await admin
      .post("/api/platform/tenants")
      .set(originHeader)
      .send({
        slug: `senja-${suffix}`,
        name: "PT Kopi Senja Uji",
        plan: "lengkap",
        deploymentMode: "shared",
        featureFlags: {
          modules: ["pos", "qr_order"],
          integrationProviders: [],
        },
        limits: fixtures.tenant.limits,
        firstAdmin: {
          name: "Admin Senja",
          whatsapp: "6281234567890",
          email: null,
        },
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    created.tenantId = response.body.data.id as string;
    expect(created.tenantId).toMatch(/^[0-9a-f-]{36}$/);

    // Alur R langkah 4 (assumption above): brand and verified domain.
    created.brandId = randomUUID();
    created.domainId = randomUUID();
    await owner.query(
      "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      [created.brandId, created.tenantId, `senja-${suffix}`, BRAND_B],
    );
    await owner.query(
      `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
       VALUES ($1, $2, $3, $4, 'custom', 'active', now())`,
      [created.domainId, created.tenantId, created.brandId, hostB],
    );
    // One outlet, so the public menu has an (empty) outlet to answer for.
    await asTenant(created.tenantId, async (client) => {
      const entityId = randomUUID();
      await client.query(
        "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Kopi Senja Uji', false)",
        [entityId, created.tenantId],
      );
      await client.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
         VALUES ($1, $2, $3, $4, 'SNJ-01', 'Kopi Senja Dago', 'Jl. Dago 9, Bandung', 'Asia/Jakarta', $5, 'active')`,
        [
          randomUUID(),
          created.tenantId,
          created.brandId,
          entityId,
          JSON.stringify(fixtures.outlets[0].openingHours),
        ],
      );
    });
    // A new tenant is only reachable on its own host once it is active.
    const status = await admin
      .get(`/api/platform/tenants/${created.tenantId}`)
      .set(originHeader);
    expect(status.status).toBe(200);
  });

  it("TEN-08, TEN-02: pelanggan tenant B melihat brand B saja, tanpa nama platform atau brand tenant lain", async () => {
    const response = await request(app)
      .get("/api/tenant/context")
      .set("Host", hostB);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.brand.name).toBe(BRAND_B);
    expect(
      platformLeaks(response.body, [...PLATFORM_NAMES, PANEL_LABEL]),
    ).toEqual([]);
    expect(JSON.stringify(response.body).toLowerCase()).not.toContain(
      "cafe legend",
    );
  });

  it("TEN-08: tenant Cafe Legend dipegang aturan yang sama", async () => {
    const response = await request(app)
      .get("/api/tenant/context")
      .set("Host", legendHost);
    expect(response.status).toBe(200);
    expect(response.body.data.brand.name).toBe(fixtures.brand.name);
    expect(
      platformLeaks(response.body, [...PLATFORM_NAMES, PANEL_LABEL]),
    ).toEqual([]);
  });

  it("TEN-08: website publik tenant B (menu masih kosong) tidak memuat nama platform", async () => {
    const response = await request(app)
      .get("/api/public/site/menu")
      .set("Host", hostB);
    // getPublicMenuPage: a brand with an active outlet but no publishable item
    // has no online menu and answers NOT_FOUND, not an empty page.
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(
      platformLeaks(response.body, [...PLATFORM_NAMES, PANEL_LABEL]),
    ).toEqual([]);
    expect(JSON.stringify(response.body).toLowerCase()).not.toContain(
      "cafe legend",
    );
  });

  it("TEN-08: jawaban galat di ruang pelanggan (host tak dikenal) tidak menyebut platform", async () => {
    for (const path of ["/api/tenant/context", "/api/public/site/menu"]) {
      const response = await request(app)
        .get(path)
        .set("Host", "tidak-ada.kopisenja.example");
      expect(response.status, path).toBe(404);
      expect(platformLeaks(response.body), path).toEqual([]);
    }
  });

  it("TEN-08: e-mail ke pelanggan/karyawan tenant B hanya berisi teks tenant", async () => {
    const sent: { url: string; body: string }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), body: String(init?.body) });
      return new Response(JSON.stringify({ messageId: "<senja@brevo>" }), {
        status: 201,
      });
    }) as typeof globalThis.fetch;
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: created.tenantId as never,
        brandId: null,
        source: "job",
      }),
      { kind: "tenant" },
    );
    const provider = createBrevoEmailProvider({
      apiKey: "xkeysib-test-secret-value",
      from: "halo@kopisenja.example",
      fromName: BRAND_B,
      fetch,
    });
    const result = await provider.send(
      context,
      emailRequestSchema.parse({
        tenantId: created.tenantId,
        outletId: null,
        reference: `senja-${suffix}`,
        to: "pelanggan@example.test",
        subject: "Pesanan Kopi Senja siap",
        body: "Terima kasih sudah memesan di Kopi Senja.",
      }),
    );
    expect(result).toMatchObject({ accepted: true });
    expect(sent).toHaveLength(1);
    const payload = JSON.parse(sent[0].body);
    expect(payload.sender.name).toBe(BRAND_B);
    expect(platformLeaks(payload)).toEqual([]);
  });

  itUntilBuilt(
    "legend-ww29",
    "TEN-08: katalog teks antarmuka tidak memuat nama platform di layar mana pun",
    async () => {
      const leaks: string[] = [];
      (function walk(node: unknown, path: string) {
        if (typeof node === "string") {
          if (platformLeaks(node).length > 0) leaks.push(path);
          return;
        }
        if (typeof node === "object" && node !== null)
          for (const [key, value] of Object.entries(node))
            walk(value, path ? `${path}.${key}` : key);
      })(messagesId, "");
      expect(MESSAGE_KEYS.length).toBeGreaterThan(0);
      expect(leaks).toEqual([]);
    },
  );
});

// ---- Not yet in m1 ---------------------------------------------------------

describe("Alur R struk dan PDF tenant B (TEN-08, POS-07)", () => {
  it("TEN-08 POS-07: struk, e-receipt publik, dan PDF memuat brand/outlet tenant, bukan nama platform", async () => {
    // Dynamic imports: these modules only exist on ws/pos-receipt.
    const { createIsolatedTenant } = await import("../floor-test-helpers");
    // Variable specifier keeps the m1 typecheck from resolving the module.
    const receiptModule = "../../services/pos-receipt.service.ts";
    const { createPosReceiptPort } = await import(
      /* @vite-ignore */ receiptModule
    );
    const { setPosReceiptPort } =
      await import("../../services/pos-order-ports");
    setPosReceiptPort(createPosReceiptPort());
    try {
      const t = await createIsolatedTenant(`wl-${suffix}`);
      await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
        t.tenantId,
        randomUUID(),
      ]);
      await owner.query("UPDATE brands SET name = $2 WHERE id = $1", [
        t.brandId,
        BRAND_B,
      ]);
      await owner.query(
        "UPDATE outlets SET name = 'Kopi Senja Dago', address = 'Jl. Dago 9, Bandung' WHERE id = $1",
        [t.outletId],
      );
      // Cashier role with POS rights; the same setup as pos-receipt.test.ts:
      // menu item with photo, price list, published PBJT 10% rule.
      const roleId = randomUUID();
      await owner.query(
        `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
             VALUES ($1, $2, 'Kasir WL', false, NULL, $3, false, '["tenant","outlet"]')`,
        [
          roleId,
          t.tenantId,
          JSON.stringify([
            "order.view",
            "pos.sale.create",
            "pos.payment.accept",
            "shift.cash.operate",
          ]),
        ],
      );
      const cashier = agent(app);
      await signUp(cashier, "Kasir Senja");
      const userId = (await cashier.get("/api/auth/get-session")).body.user
        .id as string;
      await owner.query(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
             VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
        [t.tenantId, userId, roleId],
      );
      const item = randomUUID();
      const priceList = randomUUID();
      await asTenant(t.tenantId, async (client) => {
        const category = randomUUID();
        await client.query(
          "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1,$2,$3,'Kopi',0)",
          [category, t.tenantId, t.brandId],
        );
        await client.query(
          "INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id) VALUES ($1,$2,$3,$4,'Kopi Susu',true,$5)",
          [item, t.tenantId, t.brandId, category, randomUUID()],
        );
        await client.query(
          "INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from) VALUES ($1,$2,$3,'takeaway','2026-01-01')",
          [priceList, t.tenantId, t.outletId],
        );
        await client.query(
          "INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr) VALUES ($1,$2,$3,$4,25000)",
          [randomUUID(), t.tenantId, priceList, item],
        );
        // Published tax settings and PBJT 10% rule (pos-receipt.test.ts):
        // the receipt prints its tax lines from them.
        await client.query(
          `INSERT INTO tax_settings
             (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
              tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
              version, effective_from, status, published_at, published_by)
           VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
                   'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
          [randomUUID(), t.tenantId, userId],
        );
        await client.query(
          `INSERT INTO tax_rules
             (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
              price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
              published_at, published_by)
           VALUES ($1, $2, NULL, 'PBJT-WL', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
                   '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
                   false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
          [randomUUID(), t.tenantId, userId],
        );
      });
      // Cash goes into the drawer of an open shift on a verified terminal
      // (ws/pos-shift), so the cashier signs in on a device and opens a shift.
      const deviceId = randomUUID();
      setDeviceOutletResolver(async ({ tenantId, deviceId: id }) =>
        tenantId === t.tenantId && id === deviceId ? t.outletId : null,
      );
      await registerTestDevice(owner, {
        tenantId: t.tenantId,
        outletId: t.outletId,
        deviceId,
      });
      const deviceToken = signDeviceToken({
        version: 1,
        tenantId: t.tenantId,
        brandId: null,
        deviceId,
        issuedAt: Math.floor(Date.now() / 1000) - 5,
      });
      const base = `/api/outlets/${t.outletId}/pos`;
      const post = (path: string, body: Record<string, unknown>) =>
        cashier
          .post(`${base}${path}`)
          .set("Host", t.hostname)
          .set(originHeader)
          .set(DEVICE_TOKEN_HEADER, deviceToken)
          .send({ idempotencyKey: randomUUID(), ...body });
      const shift = await post("/shifts", { openingFloatIdr: 100_000 });
      expect(shift.status, JSON.stringify(shift.body)).toBe(201);
      const order = await post("/orders", {
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId: item, quantity: 1, modifierIds: [] }],
      });
      expect(order.status, JSON.stringify(order.body)).toBe(201);
      const orderId = order.body.data.id as string;
      let status = order.body.data.status as string;
      if (status === "draft") {
        const submitted = await post(`/orders/${orderId}/submit`, {
          expectedStatus: status,
        });
        status = submitted.body.data.status as string;
      }
      const paid = await post(`/orders/${orderId}/tenders`, {
        method: "cash",
        receivedIdr: order.body.data.totalIdr + 5000,
        expectedStatus: status,
      });
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      const done = await post(`/orders/${orderId}/complete`, {
        expectedStatus: paid.body.data.order.status,
      });
      expect(done.status).toBe(200);
      const issued = await post(`/orders/${orderId}/receipts`, {
        deliveries: ["print", "link"],
      });
      expect(issued.status, JSON.stringify(issued.body)).toBeLessThan(300);

      // Staff document and the customer's e-receipt carry the brand's outlet.
      expect(issued.body.data.document.outletName).toBe("Kopi Senja Dago");
      expect(platformLeaks(issued.body)).toEqual([]);
      const token = String(issued.body.data.link.url).split("/r/")[1];
      const publicDoc = await request(app)
        .get(`/api/public/receipts/${token}`)
        .set("Host", t.hostname);
      expect(publicDoc.status).toBe(200);
      expect(platformLeaks(publicDoc.body)).toEqual([]);

      // PDFs (receipt and kuitansi) hold no platform name either.
      for (const kind of ["receipt", "kuitansi"]) {
        const pdf = await request(app)
          .get(`/api/public/receipts/${token}/pdf?kind=${kind}`)
          .set("Host", t.hostname)
          .buffer(true)
          .parse((res, done) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => done(null, Buffer.concat(chunks)));
          });
        expect(pdf.status).toBe(200);
        const text = (pdf.body as Buffer).toString("latin1");
        expect(text.startsWith("%PDF-")).toBe(true);
        expect(text).toContain("Kopi Senja Dago");
        expect(platformLeaks(text)).toEqual([]);
      }
    } finally {
      setPosReceiptPort(null);
      setDeviceOutletResolver(null);
    }
  });
});

describeUntilMerged(
  "ws/tenant-config-export",
  "Alur R ekspor konfigurasi tenant (TEN-08, TEN-09)",
  () => {
    itUntilMerged(
      "ws/tenant-config-export",
      "TEN-09 TEN-08: konfigurasi Cafe Legend yang diekspor jadi template tenant B tanpa nama platform; B tetap memakai brand sendiri",
      async () => {
        const exported = await admin
          .get(`/api/platform/tenants/${fixtures.tenant.id}/config-export`)
          .set(originHeader);
        expect(exported.status, JSON.stringify(exported.body)).toBe(200);
        // Template text is copied to the next cafe, so it must not name the platform.
        expect(platformLeaks(exported.body)).toEqual([]);

        const template = await admin
          .post(`/api/platform/tenants/${fixtures.tenant.id}/config-templates`)
          .set(originHeader)
          .send({
            name: `Template Legend ${suffix}`,
            description: "Template pertama untuk cafe berikutnya",
          });
        expect(template.status, JSON.stringify(template.body)).toBe(201);
        const imported = await admin
          .post(`/api/platform/tenants/${created.tenantId}/config-import`)
          .set(originHeader)
          .send({ templateId: template.body.data.id });
        expect(imported.status, JSON.stringify(imported.body)).toBeLessThan(
          300,
        );

        const context = await request(app)
          .get("/api/tenant/context")
          .set("Host", hostB);
        expect(context.body.data.brand.name).toBe(BRAND_B);
        expect(platformLeaks(context.body)).toEqual([]);
      },
    );
  },
);
