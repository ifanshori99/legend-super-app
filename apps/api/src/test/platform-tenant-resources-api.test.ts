// legend-utnll: U5a platform staff select a target tenant explicitly, with no
// dependency on the tenant resolved from the caller's host/session.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  brandSchema,
  legalEntitySchema,
  outletSchema,
} from "@starter/shared/platform";
import { agent, verifySessionMfa } from "./helpers";
import {
  app,
  assign,
  audit,
  closeFixtures,
  owner,
  platformAdmin,
  signedIn,
  supportReadOnly,
  tenant,
} from "./platform-tenant-559-helpers";

let admin: Awaited<ReturnType<typeof platformAdmin>>;
let target: string;
let other: string;
let own: Awaited<ReturnType<typeof structure>>;
let foreign: Awaited<ReturnType<typeof structure>>;
const base = (id: string) => `/api/platform/tenants/${id}`;
const resources = ["brands", "outlets", "legal-entities"] as const;

async function structure(tenantId: string, label: string) {
  const brandId = randomUUID();
  const legalEntityId = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    [brandId, tenantId, `brand-${brandId}`, `Brand ${label}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, npwp_encrypted, npwp_last4, is_pkp, address)
     VALUES ($1, $2, $3, 'private-ciphertext', '1234', true, 'Alamat rumah pribadi')`,
    [legalEntityId, tenantId, `PT ${label}`],
  );
  await owner.query(
    `INSERT INTO outlets
       (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     VALUES ($1, $2, $3, $4, $5, $6, 'Alamat outlet publik', $7::jsonb)`,
    [
      outletId,
      tenantId,
      brandId,
      legalEntityId,
      `UJI-${outletId.slice(0, 8).toUpperCase()}`,
      `Outlet ${label}`,
      JSON.stringify({
        mon: null,
        tue: null,
        wed: null,
        thu: null,
        fri: null,
        sat: null,
        sun: null,
      }),
    ],
  );
  return { brandId, legalEntityId, outletId };
}

beforeAll(async () => {
  admin = await platformAdmin("Platform Resources");
  target = await tenant("Resource Tenant A");
  other = await tenant("Resource Tenant B");
  own = await structure(target, "Target");
  foreign = await structure(other, "Foreign");
});
afterAll(closeFixtures);

describe("legend-utnll U5a target tenant organisation reads", () => {
  it("TEN-02 AC1 returns target tenant brands without a session tenant", async () => {
    const result = await admin.client.get(`${base(target)}/brands`);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data).toEqual([
      expect.objectContaining({ id: own.brandId, tenantId: target }),
    ]);
    expect(brandSchema.safeParse(result.body.data[0]).success).toBe(true);
    expect(JSON.stringify(result.body)).not.toContain(foreign.brandId);
    expect(
      await audit(target, admin.userId, "platform.tenant_brands.read"),
    ).toHaveLength(1);
  });

  it("TEN-02 AC2 returns only target outlets and never follows a foreign brand filter", async () => {
    const result = await admin.client
      .get(`${base(target)}/outlets`)
      .query({ limit: 1 });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data).toEqual([
      expect.objectContaining({
        id: own.outletId,
        tenantId: target,
        brandId: own.brandId,
      }),
    ]);
    expect(outletSchema.safeParse(result.body.data[0]).success).toBe(true);
    expect(result.body.meta).toMatchObject({ limit: 1, nextCursor: null });
    const filtered = await admin.client
      .get(`${base(target)}/outlets`)
      .query({ brandId: foreign.brandId });
    expect(filtered.status, JSON.stringify(filtered.body)).toBe(200);
    expect(filtered.body.data).toEqual([]);
    expect(
      await audit(target, admin.userId, "platform.tenant_outlets.read"),
    ).toHaveLength(2);
  });

  it("TEN-04 AC3 legal entities expose NPWP last4 while hiding private address and bank fields", async () => {
    const result = await admin.client.get(`${base(target)}/legal-entities`);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data).toEqual([
      expect.objectContaining({
        id: own.legalEntityId,
        tenantId: target,
        npwpLast4: "1234",
        isPkp: true,
        address: null,
        bankAccountIds: [],
      }),
    ]);
    expect(JSON.stringify(result.body)).not.toMatch(
      /private-ciphertext|Alamat rumah pribadi|npwpEncrypted|npwp_encrypted/,
    );
    expect(legalEntitySchema.safeParse(result.body.data[0]).success).toBe(true);
    expect(JSON.stringify(result.body)).not.toContain(foreign.legalEntityId);
    const events = await audit(
      target,
      admin.userId,
      "platform.tenant_legal_entities.read",
    );
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(
      /Alamat rumah pribadi|private-ciphertext/,
    );
  });

  it("TEN-02 AC4 ignores forged client tenant headers and validates tenant and paging inputs", async () => {
    for (const resource of resources) {
      const result = await admin.client
        .get(`${base(target)}/${resource}`)
        .set("Host", "pesan.cafelegend.example")
        .set("X-Tenant-Id", other);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(
        result.body.data.every(
          (row: { tenantId: string }) => row.tenantId === target,
        ),
      ).toBe(true);
      expect(
        (await admin.client.get(`${base(randomUUID())}/${resource}`)).status,
      ).toBe(404);
      expect(
        (await admin.client.get(`${base("bad-id")}/${resource}`)).status,
      ).toBe(422);
    }
    expect(
      (await admin.client.get(`${base(target)}/outlets`).query({ limit: 101 }))
        .status,
    ).toBe(422);
  });

  it("TEN-04 AC5 tenant Owner and read-only support grant alone cannot enumerate platform resources", async () => {
    const member = await signedIn("Tenant Resource Owner");
    await assign(target, member.userId, "owner");
    await verifySessionMfa(member.email);
    await supportReadOnly(target, member.userId);
    for (const resource of resources) {
      expect(
        (await member.client.get(`${base(target)}/${resource}`)).status,
      ).toBe(403);
      expect((await agent(app).get(`${base(target)}/${resource}`)).status).toBe(
        401,
      );
    }
  });

  it("TEN-02 AC6 known empty tenant resources return successful empty lists", async () => {
    const empty = await tenant("Empty Resources");
    for (const resource of resources) {
      const result = await admin.client.get(`${base(empty)}/${resource}`);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.data).toEqual([]);
    }
  });
});
