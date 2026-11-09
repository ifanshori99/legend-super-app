// Cross-tenant WhatsApp number claim (bead legend-mbd2; PRD §3 F4, AUTH-02).
// One number may route only one tenant: the database enforces it with two
// partial unique indexes over active tenant-wide whatsapp rows, and the
// integrations service maps their violation to WHATSAPP_NUMBER_TAKEN.
// Real Express app, Better Auth and PostgreSQL. Two throwaway tenants are
// resolved through their verified domain (Host header); the seeded tenant is
// left alone because the identity-login suite owns its whatsapp row.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import type { Test } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normalizeWhatsAppNumber } from "@starter/shared/identity";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { resolveWhatsAppChannel } from "../services/identity-login.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const app = createApp();
const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const unique = () => randomBytes(4).toString("hex");

type Member = { put: (url: string) => Test; post: (url: string) => Test };
type TenantFixture = { tenantId: string; client: Member };

const limits = {
  maxOutlets: 5,
  maxActiveEmployees: 30,
  maxDevices: 10,
  aiRequestsPerMonth: 0,
  whatsappCostCapIdr: 0,
  aiCostCapIdr: 0,
  emailCostCapIdr: 0,
};

/** A tenant that may use whatsapp, with a tenant_admin signed in on its host. */
async function createTenant(label: string): Promise<TenantFixture> {
  const tenantId = randomUUID();
  const brandId = randomUUID();
  const hostname = `wa-${label}-${unique()}.contoh.example`;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":["whatsapp"]}', $4, $5)`,
    [
      tenantId,
      `wa-${label}-${unique()}`,
      `Tenant ${label} WA`,
      JSON.stringify(limits),
      randomUUID(),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand WA')",
    [brandId, tenantId, `wa-${unique()}`],
  );
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'custom', 'active', now())`,
    [randomUUID(), tenantId, brandId, hostname],
  );
  // The tenant's own copy of the seeded tenant_admin role template.
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT gen_random_uuid(), $1, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $2 AND template_key = 'tenant_admin'`,
    [tenantId, seededTenantId],
  );
  const client = agent(app);
  const email = await signUp(client, `Admin WA ${label}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const assigned = await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
      WHERE tenant_id = $1 AND template_key = 'tenant_admin'`,
    [tenantId, userId],
  );
  if (assigned.rowCount !== 1) throw new Error("No tenant_admin role");
  await verifySessionMfa(email);
  return {
    tenantId,
    client: {
      put: (url) => client.put(url).set("Host", hostname).set(originHeader),
      post: (url) => client.post(url).set("Host", hostname).set(originHeader),
    },
  };
}

let tenantA: TenantFixture;
let tenantB: TenantFixture;

/** A fresh Indonesian mobile number: 11 digits after the country code. */
function freshNumber() {
  const subscriber = `8${Array.from({ length: 10 }, () =>
    Math.floor(Math.random() * 10),
  ).join("")}`;
  return {
    normalized: `62${subscriber}`,
    local: `0${subscriber.slice(0, 3)}-${subscriber.slice(3, 7)}-${subscriber.slice(7)}`,
    international: `+62 ${subscriber.slice(0, 3)} ${subscriber.slice(3, 7)} ${subscriber.slice(7)}`,
  };
}

const whatsappBody = (config: Record<string, string | number>) => ({
  outletId: null,
  provider: "whatsapp",
  config,
  credentials: { accessKey: "kunci-uji" },
});

/** Saves a draft whatsapp config and returns the integration id. */
async function saveDraft(
  tenant: TenantFixture,
  config: Record<string, string | number>,
): Promise<string> {
  const saved = await tenant.client
    .put("/api/org/integrations")
    .send(whatsappBody(config));
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  return saved.body.data.id as string;
}

const setStatus = (
  tenant: TenantFixture,
  id: string,
  status: "active" | "disabled",
) => tenant.client.post(`/api/org/integrations/${id}/status`).send({ status });

async function activate(
  tenant: TenantFixture,
  config: Record<string, string | number>,
): Promise<string> {
  const id = await saveDraft(tenant, config);
  const activated = await setStatus(tenant, id, "active");
  expect(activated.status, JSON.stringify(activated.body)).toBe(200);
  return id;
}

beforeAll(async () => {
  [tenantA, tenantB] = await Promise.all([
    createTenant("a"),
    createTenant("b"),
  ]);
});

beforeEach(async () => {
  await owner.query(
    "DELETE FROM tenant_integrations WHERE tenant_id = ANY($1)",
    [[tenantA.tenantId, tenantB.tenantId]],
  );
});

afterAll(async () => {
  const ids = [tenantA.tenantId, tenantB.tenantId];
  for (const table of [
    "tenant_integrations",
    "role_assignments",
    "roles",
    "tenant_domains",
    "brands",
  ])
    await owner.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1)`, [ids]);
  await owner.query("DELETE FROM tenants WHERE id = ANY($1)", [ids]);
  await owner.end();
});

describe("WhatsApp number claim (legend-mbd2)", () => {
  it("refuses tenant B activating the number tenant A holds, in another format", async () => {
    const number = freshNumber();
    await activate(tenantA, { receivingNumber: number.international });
    const draft = await saveDraft(tenantB, { receivingNumber: number.local });

    const refused = await setStatus(tenantB, draft, "active");
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("WHATSAPP_NUMBER_TAKEN");

    const stored = await owner.query(
      "SELECT status FROM tenant_integrations WHERE id = $1",
      [draft],
    );
    expect(stored.rows[0]?.status).toBe("draft");
  });

  it("refuses the same phoneNumberId with different receiving numbers", async () => {
    const phoneNumberId = `pnid-${unique()}`;
    await activate(tenantA, {
      receivingNumber: freshNumber().normalized,
      phoneNumberId,
    });
    const draft = await saveDraft(tenantB, {
      receivingNumber: freshNumber().normalized,
      phoneNumberId,
    });

    const refused = await setStatus(tenantB, draft, "active");
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("WHATSAPP_NUMBER_TAKEN");
  });

  it("allows a draft with a taken number, refuses activating it, and ignores a disabled row", async () => {
    const number = freshNumber();
    const idA = await activate(tenantA, { receivingNumber: number.normalized });

    // A draft never routes, so it does not clash.
    const draft = await saveDraft(tenantB, {
      receivingNumber: number.international,
    });
    const blocked = await setStatus(tenantB, draft, "active");
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("WHATSAPP_NUMBER_TAKEN");

    // Once A disables its row, the number is free for B.
    const disabled = await setStatus(tenantA, idA, "disabled");
    expect(disabled.status).toBe(200);
    const activated = await setStatus(tenantB, draft, "active");
    expect(activated.status).toBe(200);
    expect(activated.body.data.status).toBe("active");
  });

  it("refuses editing an active config onto a number another tenant holds", async () => {
    const taken = freshNumber();
    await activate(tenantA, { receivingNumber: taken.normalized });
    await activate(tenantB, { receivingNumber: freshNumber().normalized });

    const refused = await tenantB.client
      .put("/api/org/integrations")
      .send(whatsappBody({ receivingNumber: taken.local }));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("WHATSAPP_NUMBER_TAKEN");
  });

  it("lets a tenant re-save its own active config", async () => {
    const number = freshNumber();
    const id = await activate(tenantA, { receivingNumber: number.normalized });

    const same = await tenantA.client
      .put("/api/org/integrations")
      .send(whatsappBody({ receivingNumber: number.normalized }));
    expect(same.status).toBe(200);
    // Same number written another way is still its own number.
    const reformatted = await tenantA.client
      .put("/api/org/integrations")
      .send(whatsappBody({ receivingNumber: number.local }));
    expect(reformatted.status).toBe(200);
    expect(reformatted.body.data.id).toBe(id);
    expect(reformatted.body.data.status).toBe("active");
  });

  it("lets exactly one of two tenants activate the same number at the same time", async () => {
    const number = freshNumber();
    const [draftA, draftB] = await Promise.all([
      saveDraft(tenantA, { receivingNumber: number.local }),
      saveDraft(tenantB, { receivingNumber: number.international }),
    ]);

    const results = await Promise.all([
      setStatus(tenantA, draftA, "active"),
      setStatus(tenantB, draftB, "active"),
    ]);
    const statuses = results.map((result) => result.status).sort();
    expect(statuses).toEqual([200, 409]);
    const loser = results.find((result) => result.status === 409);
    expect(loser?.body.error.code).toBe("WHATSAPP_NUMBER_TAKEN");

    const active = await owner.query(
      `SELECT count(*)::int AS count FROM tenant_integrations
        WHERE tenant_id = ANY($1) AND status = 'active'`,
      [[tenantA.tenantId, tenantB.tenantId]],
    );
    expect(active.rows[0]?.count).toBe(1);
  });
});

describe("write-side canonical form (whitespace JS trims but SQL once missed)", () => {
  const stored = async (id: string) =>
    (
      await owner.query<{ config: Record<string, unknown> }>(
        "SELECT config FROM tenant_integrations WHERE id = $1",
        [id],
      )
    ).rows[0]?.config;

  it("never lets exotic whitespace dodge the number claim", async () => {
    const number = freshNumber();
    await activate(tenantA, { receivingNumber: number.normalized });
    const variants = [
      `\uFEFF${number.normalized}`,
      `0${number.normalized.slice(2, 5)}\u00A0${number.normalized.slice(5)}`,
      ` ${number.normalized}`,
      `\u202F+${number.normalized}\u2007`,
    ];
    for (const receivingNumber of variants) {
      const saved = await tenantB.client
        .put("/api/org/integrations")
        .send(whatsappBody({ receivingNumber }));
      if (saved.status !== 200) {
        expect(saved.status, JSON.stringify(receivingNumber)).toBe(422);
        continue;
      }
      expect((await stored(saved.body.data.id))?.receivingNumber).toBe(
        number.normalized,
      );
      const refused = await setStatus(tenantB, saved.body.data.id, "active");
      expect(refused.status, JSON.stringify(receivingNumber)).toBe(409);
      expect(refused.body.error.code).toBe("WHATSAPP_NUMBER_TAKEN");
    }
  });

  it("never lets a padded phoneNumberId dodge the routing claim", async () => {
    const phoneNumberId = `pnid-${unique()}`;
    await activate(tenantA, {
      receivingNumber: freshNumber().normalized,
      phoneNumberId,
    });
    for (const padded of [
      `\uFEFF${phoneNumberId}`,
      `\u00A0${phoneNumberId}\u202F`,
    ]) {
      const saved = await tenantB.client.put("/api/org/integrations").send(
        whatsappBody({
          receivingNumber: freshNumber().normalized,
          phoneNumberId: padded,
        }),
      );
      expect(saved.status, JSON.stringify(padded)).toBe(200);
      expect((await stored(saved.body.data.id))?.phoneNumberId).toBe(
        phoneNumberId,
      );
      const refused = await setStatus(tenantB, saved.body.data.id, "active");
      expect(refused.status, JSON.stringify(padded)).toBe(409);
      expect(refused.body.error.code).toBe("WHATSAPP_NUMBER_TAKEN");
    }
  });

  it("stores canonical digits and a JSON-number id as text", async () => {
    const number = freshNumber();
    const id = await saveDraft(tenantB, {
      receivingNumber: number.international,
      phoneNumberId: 10987654321,
    });
    expect(await stored(id)).toEqual({
      receivingNumber: number.normalized,
      phoneNumberId: "10987654321",
    });
  });

  it("refuses a number or id that cannot be valid", async () => {
    const refused: Record<string, string>[] = [
      { receivingNumber: "abc" },
      { receivingNumber: "0" },
      { receivingNumber: freshNumber().normalized, phoneNumberId: "a b" },
      {
        receivingNumber: freshNumber().normalized,
        phoneNumberId: "x".repeat(65),
      },
    ];
    for (const config of refused) {
      const saved = await tenantB.client
        .put("/api/org/integrations")
        .send(whatsappBody(config));
      expect(saved.status, JSON.stringify(config)).toBe(422);
    }
  });

  it("treats a blank number or id as not set yet (draft)", async () => {
    const saved = await tenantB.client
      .put("/api/org/integrations")
      .send(whatsappBody({ receivingNumber: "", phoneNumberId: " " }));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  });
});

describe("SQL number functions match the TypeScript they mirror", () => {
  const inputs: string[] = [
    "0812-3456-7890",
    "+62 812 3456 7890",
    " 6281234567890 ",
    "(021) 555-1234",
    "abc",
    "0",
    "",
    "1234567890123456",
    "62 812.3456.7890",
    "+0812345678901",
    "0000000000",
    "12345678",
    "1234567",
    "\uFEFF6281234567890",
    "0812\u00A03456\u00A07890",
    " 6281234567890",
    "\u20286281234567890\u2029",
    "0812\u202F3456\u20077890",
    "\u1680+62\u3000812\u205F3456\u20007890",
  ];

  it("app.normalize_wa_number equals normalizeWhatsAppNumber", async () => {
    for (const input of inputs) {
      const { rows } = await owner.query<{ value: string | null }>(
        "SELECT app.normalize_wa_number($1) AS value",
        [input],
      );
      expect(rows[0]?.value, JSON.stringify(input)).toBe(
        normalizeWhatsAppNumber(input),
      );
    }
    const { rows } = await owner.query<{ value: string | null }>(
      "SELECT app.normalize_wa_number(NULL) AS value",
    );
    expect(rows[0]?.value).toBe(normalizeWhatsAppNumber(null));
  });

  it("app.whatsapp_routing_key matches resolveWhatsAppChannel", async () => {
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantA.tenantId,
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    const configs: Record<string, string | number>[] = [
      { receivingNumber: "0812-3456-7890" },
      { receivingNumber: "+62 812 3456 7890", phoneNumberId: " 10987654321 " },
      { receivingNumber: " 6281234567890 ", phoneNumberId: 10987654321 },
      { receivingNumber: 6281234567890 },
      { receivingNumber: "0812-3456-7890", phoneNumberId: "   " },
      { receivingNumber: "0812-3456-7890", phoneNumberId: "" },
      { receivingNumber: "\uFEFF6281234567890" },
      { receivingNumber: "0812\u00A03456\u00A07890" },
      { receivingNumber: "0812-3456-7890", phoneNumberId: "\uFEFF10987654321" },
      { receivingNumber: "0812-3456-7890", phoneNumberId: "\u00A0\u202F  " },
    ];
    for (const config of configs) {
      await owner.query(
        "DELETE FROM tenant_integrations WHERE tenant_id = $1",
        [tenantA.tenantId],
      );
      await owner.query(
        `INSERT INTO tenant_integrations (tenant_id, provider, config, credentials_encrypted, status)
         VALUES ($1, 'whatsapp', $2, 'c2VhbGVkLXRlc3Q=', 'active')`,
        [tenantA.tenantId, JSON.stringify(config)],
      );
      const channel = await withTenant(db, context, (tx) =>
        resolveWhatsAppChannel(tx, context),
      );
      const { rows } = await owner.query<{
        routing: string | null;
        receiving: string | null;
      }>(
        `SELECT app.whatsapp_routing_key(config) AS routing,
                app.whatsapp_receiving_number(config) AS receiving
           FROM tenant_integrations WHERE tenant_id = $1`,
        [tenantA.tenantId],
      );
      expect(rows[0]?.routing, JSON.stringify(config)).toBe(
        channel.routingNumber,
      );
      expect(rows[0]?.receiving, JSON.stringify(config)).toBe(
        channel.receivingNumber,
      );
    }
  });

  it("whatsapp_receiving_number is null where the login flow refuses the number", async () => {
    for (const receivingNumber of ["abc", "0", "", "1234567890123456"]) {
      const { rows } = await owner.query<{ value: string | null }>(
        "SELECT app.whatsapp_receiving_number($1::jsonb) AS value",
        [JSON.stringify({ receivingNumber })],
      );
      expect(rows[0]?.value, receivingNumber).toBeNull();
    }
  });
});

describe("migration guard for existing duplicate numbers", () => {
  it("fails with 23505 naming legend-mbd2 when two tenants already share an active number", async () => {
    const sql = readFileSync(
      fileURLToPath(
        new URL(
          "../db/schema/platform-integrations.custom.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const block = sql.match(/DO \$\$[\s\S]*?\n\$\$;?/)?.[0];
    if (!block) throw new Error("DO block not found in the custom SQL");

    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DROP INDEX tenant_integrations_whatsapp_number_key, tenant_integrations_whatsapp_routing_key",
      );
      const number = freshNumber().normalized;
      for (const tenantId of [tenantA.tenantId, tenantB.tenantId])
        await client.query(
          `INSERT INTO tenant_integrations (tenant_id, provider, config, credentials_encrypted, status)
           VALUES ($1, 'whatsapp', $2, 'c2VhbGVkLXRlc3Q=', 'active')`,
          [tenantId, JSON.stringify({ receivingNumber: number })],
        );
      await expect(client.query(block)).rejects.toMatchObject({
        code: "23505",
        message: expect.stringContaining("legend-mbd2"),
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }

    // The rollback restored both indexes.
    const { rows } = await owner.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'tenant_integrations'
          AND indexname LIKE 'tenant_integrations_whatsapp_%_key'`,
    );
    expect(rows).toHaveLength(2);
  });
});
