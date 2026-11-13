// legend-0mn8: platform admin creates a brand / outlet / legal entity inside a
// target tenant chosen by path (POST /api/platform/tenants/:tenantId/...).
// Written from docs/briefs/0mn8-platform-tenant-create.md and the shared
// contract (@starter/shared/platform), not from the service code.
//
// Assumptions (spec silent):
// - Audit actions follow the event catalog names: `brand.created`,
//   `outlet.created`, `legal_entity.created`, written on the TARGET tenant
//   with actorId = the platform admin.
// - A brandId/legalEntityId of another tenant is refused with 404 or 422
//   (brief: "404/422, bukan bocor"); duplicate code/slug is 409.
// - Legal entity address and the full NPWP are private: never in audit.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  brandSchema,
  legalEntitySchema,
  outletSchema,
} from "@starter/shared/platform";
import { agent, originHeader, verifySessionMfa } from "./helpers";
import {
  app,
  assign,
  audit,
  closeFixtures,
  owner,
  platformAdmin,
  signedIn,
  tenant,
} from "./platform-tenant-559-helpers";

type Resource = "brands" | "outlets" | "legal-entities";
type Table = "brands" | "outlets" | "legal_entities";

const tableOf: Record<Resource, Table> = {
  brands: "brands",
  outlets: "outlets",
  "legal-entities": "legal_entities",
};
const auditAction: Record<Resource, string> = {
  brands: "brand.created",
  outlets: "outlet.created",
  "legal-entities": "legal_entity.created",
};
const resources: Resource[] = ["brands", "outlets", "legal-entities"];

const OPENING_HOURS = {
  mon: { opens: "08:00", closes: "22:00" },
  tue: { opens: "08:00", closes: "22:00" },
  wed: { opens: "08:00", closes: "22:00" },
  thu: { opens: "08:00", closes: "22:00" },
  fri: { opens: "08:00", closes: "23:00" },
  sat: { opens: "08:00", closes: "23:00" },
  sun: null,
};
const NPWP_FORMATTED = "01.234.567.8-901.000";
const NPWP_DIGITS = "012345678901000";
const LE_ADDRESS = "Jl. Rahasia Pribadi No. 99, Bandung";

const path = (tenantId: string, resource: Resource) =>
  `/api/platform/tenants/${tenantId}/${resource}`;
const suffix = () => randomUUID().replace(/-/g, "").slice(0, 8);

function brandBody(over: Record<string, unknown> = {}) {
  return {
    slug: `brand-${suffix()}`,
    name: "Brand Uji Platform",
    logoMediaId: null,
    ...over,
  };
}
function entityBody(over: Record<string, unknown> = {}) {
  return {
    name: `PT Uji ${suffix()}`,
    npwp: NPWP_FORMATTED,
    isPkp: true,
    address: LE_ADDRESS,
    ...over,
  };
}
function outletBody(
  brandId: string,
  legalEntityId: string,
  over: Record<string, unknown> = {},
) {
  return {
    brandId,
    legalEntityId,
    code: `T-${suffix().toUpperCase()}`,
    name: "Outlet Uji Platform",
    address: "Jl. Uji No. 1, Bandung",
    regionId: null,
    geofence: null,
    timeZone: "Asia/Jakarta",
    openingHours: OPENING_HOURS,
    ...over,
  };
}
function bodyFor(resource: Resource, brandId: string, legalEntityId: string) {
  if (resource === "brands") return brandBody();
  if (resource === "legal-entities") return entityBody();
  return outletBody(brandId, legalEntityId);
}

/** Direct DB seed: a brand and a legal entity owned by `tenantId`. */
async function seedParents(tenantId: string, label: string) {
  const brandId = randomUUID();
  const legalEntityId = randomUUID();
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    [brandId, tenantId, `seed-${brandId}`, `Brand ${label}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, npwp_encrypted, npwp_last4, is_pkp, address)
     VALUES ($1, $2, $3, 'private-ciphertext', '1234', false, NULL)`,
    [legalEntityId, tenantId, `PT Seed ${label} ${suffix()}`],
  );
  return { brandId, legalEntityId };
}

async function count(tenantId: string, resource: Resource) {
  const result = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${tableOf[resource]} WHERE tenant_id = $1`,
    [tenantId],
  );
  return Number(result.rows[0]!.n);
}
async function auditCount(tenantId: string, resource?: Resource) {
  const result = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs WHERE tenant_id = $1
       AND event->>'action' = ANY($2::text[])`,
    [tenantId, resource ? [auditAction[resource]] : Object.values(auditAction)],
  );
  return Number(result.rows[0]!.n);
}

let admin: Awaited<ReturnType<typeof platformAdmin>>;
let noMfaAdminId: string;
let noMfaClient: Awaited<ReturnType<typeof signedIn>>["client"];
let tenantAdmin: Awaited<ReturnType<typeof signedIn>>;
let target: string;
let other: string;
let targetParents: { brandId: string; legalEntityId: string };
let otherParents: { brandId: string; legalEntityId: string };

beforeAll(async () => {
  admin = await platformAdmin("Platform Create");
  target = await tenant("Create Tenant A");
  other = await tenant("Create Tenant B");
  targetParents = await seedParents(target, "Target");
  otherParents = await seedParents(other, "Foreign");

  const noMfa = await signedIn("Platform Tanpa MFA");
  await owner.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [
    noMfa.userId,
  ]);
  noMfaAdminId = noMfa.userId;
  noMfaClient = noMfa.client;

  tenantAdmin = await signedIn("Tenant Admin Create");
  await assign(target, tenantAdmin.userId, "tenant_admin");
  await verifySessionMfa(tenantAdmin.email);
});
afterAll(async () => {
  await owner.query("DELETE FROM platform_admins WHERE user_id = $1", [
    noMfaAdminId,
  ]);
  await closeFixtures();
});

describe("legend-0mn8 success: platform admin creates in a target tenant", () => {
  it("TEN-06 POST brands returns 201 + brand DTO and writes one audit row", async () => {
    const tenantId = await tenant("Create Brand OK");
    const body = brandBody();
    const res = await admin.client
      .post(path(tenantId, "brands"))
      .set(originHeader)
      .send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(brandSchema.safeParse(res.body.data).success).toBe(true);
    expect(res.body.data).toMatchObject({
      tenantId,
      slug: body.slug,
      name: body.name,
      logoMediaId: null,
      primaryHostname: null,
    });
    expect(await count(tenantId, "brands")).toBe(1);
    const events = await audit(tenantId, admin.userId, "brand.created");
    expect(events).toHaveLength(1);
  });

  it("TEN-04 POST legal-entities returns 201 + DTO (NPWP last4 only) and an audit row without private data", async () => {
    const tenantId = await tenant("Create LE OK");
    const body = entityBody();
    const res = await admin.client
      .post(path(tenantId, "legal-entities"))
      .set(originHeader)
      .send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(legalEntitySchema.safeParse(res.body.data).success).toBe(true);
    expect(res.body.data).toMatchObject({
      tenantId,
      name: body.name,
      npwpLast4: "1000",
      isPkp: true,
      bankAccountIds: [],
    });
    expect(JSON.stringify(res.body)).not.toContain(NPWP_DIGITS);
    expect(JSON.stringify(res.body)).not.toContain(NPWP_FORMATTED);
    expect(await count(tenantId, "legal-entities")).toBe(1);
    const events = await audit(tenantId, admin.userId, "legal_entity.created");
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(NPWP_DIGITS);
    expect(JSON.stringify(events)).not.toContain(NPWP_FORMATTED);
    expect(JSON.stringify(events)).not.toContain(LE_ADDRESS);
  });

  it("TEN-06 POST outlets returns 201 + outlet DTO (preopening, tenant from path) and one audit row", async () => {
    const tenantId = await tenant("Create Outlet OK");
    const parents = await seedParents(tenantId, "Outlet OK");
    const body = outletBody(parents.brandId, parents.legalEntityId);
    const res = await admin.client
      .post(path(tenantId, "outlets"))
      .set(originHeader)
      .send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(outletSchema.safeParse(res.body.data).success).toBe(true);
    expect(res.body.data).toMatchObject({
      tenantId,
      brandId: parents.brandId,
      legalEntityId: parents.legalEntityId,
      code: body.code,
      name: body.name,
      status: "preopening",
      timeZone: "Asia/Jakarta",
    });
    expect(await count(tenantId, "outlets")).toBe(1);
    const events = await audit(tenantId, admin.userId, "outlet.created");
    expect(events).toHaveLength(1);
  });

  it("TEN-06 created rows show up in the platform GET lists of that tenant only", async () => {
    const tenantId = await tenant("Create Then List");
    const brand = await admin.client
      .post(path(tenantId, "brands"))
      .set(originHeader)
      .send(brandBody());
    const entity = await admin.client
      .post(path(tenantId, "legal-entities"))
      .set(originHeader)
      .send(entityBody());
    expect(brand.status).toBe(201);
    expect(entity.status).toBe(201);
    const outlet = await admin.client
      .post(path(tenantId, "outlets"))
      .set(originHeader)
      .send(outletBody(brand.body.data.id, entity.body.data.id));
    expect(outlet.status, JSON.stringify(outlet.body)).toBe(201);

    const lists = await Promise.all(
      resources.map((r) => admin.client.get(path(tenantId, r))),
    );
    expect(lists[0]!.body.data.map((x: { id: string }) => x.id)).toEqual([
      brand.body.data.id,
    ]);
    expect(lists[1]!.body.data.map((x: { id: string }) => x.id)).toEqual([
      outlet.body.data.id,
    ]);
    expect(lists[2]!.body.data.map((x: { id: string }) => x.id)).toEqual([
      entity.body.data.id,
    ]);
    // Not visible in another tenant's lists.
    const otherLists = JSON.stringify(
      (
        await Promise.all(
          resources.map((r) => admin.client.get(path(other, r))),
        )
      ).map((r) => r.body),
    );
    for (const id of [
      brand.body.data.id,
      entity.body.data.id,
      outlet.body.data.id,
    ])
      expect(otherLists).not.toContain(id);
  });
});

describe("legend-0mn8 access control", () => {
  it("TEN-04 without login every create answers 401 and writes nothing", async () => {
    for (const resource of resources) {
      const before = await count(target, resource);
      const res = await agent(app)
        .post(path(target, resource))
        .set(originHeader)
        .send(
          bodyFor(resource, targetParents.brandId, targetParents.legalEntityId),
        );
      expect(res.status, resource).toBe(401);
      expect(await count(target, resource)).toBe(before);
    }
  });

  it("TEN-04 a tenant admin of that very tenant (with MFA) gets 403 and nothing is written", async () => {
    for (const resource of resources) {
      const before = await count(target, resource);
      const auditBefore = await auditCount(target, resource);
      const res = await tenantAdmin.client
        .post(path(target, resource))
        .set(originHeader)
        .send(
          bodyFor(resource, targetParents.brandId, targetParents.legalEntityId),
        );
      expect(res.status, resource).toBe(403);
      expect(await count(target, resource)).toBe(before);
      expect(await auditCount(target, resource)).toBe(auditBefore);
    }
  });

  it("TEN-04 a platform admin without MFA gets 403 and nothing is written", async () => {
    for (const resource of resources) {
      const before = await count(target, resource);
      const auditBefore = await auditCount(target, resource);
      const res = await noMfaClient
        .post(path(target, resource))
        .set(originHeader)
        .send(
          bodyFor(resource, targetParents.brandId, targetParents.legalEntityId),
        );
      expect(res.status, resource).toBe(403);
      expect(await count(target, resource)).toBe(before);
      expect(await auditCount(target, resource)).toBe(auditBefore);
    }
  });
});

describe("legend-0mn8 validation and unknown tenant", () => {
  it("TEN-06 unknown tenant is 404 and writes nothing anywhere", async () => {
    const ghost = randomUUID();
    for (const resource of resources) {
      const res = await admin.client
        .post(path(ghost, resource))
        .set(originHeader)
        .send(
          bodyFor(resource, targetParents.brandId, targetParents.legalEntityId),
        );
      expect(res.status, resource).toBe(404);
      // A missing route is also 404: require the tenant-level NOT_FOUND error.
      expect(res.body.error?.code, resource).toBe("NOT_FOUND");
      expect(res.body.error?.message, resource).not.toBe("Route not found.");
      expect(await count(ghost, resource)).toBe(0);
      expect(await auditCount(ghost)).toBe(0);
    }
  });

  it("TEN-06 malformed tenant id in the path is 422", async () => {
    for (const resource of resources) {
      const res = await admin.client
        .post(path("bad-id", resource))
        .set(originHeader)
        .send(
          bodyFor(resource, targetParents.brandId, targetParents.legalEntityId),
        );
      expect(res.status, resource).toBe(422);
    }
  });

  it("TEN-06 tenantId in the body (even equal to the path) is 422; so is any unknown field", async () => {
    for (const resource of resources) {
      const before = await count(target, resource);
      const otherBefore = await count(other, resource);
      const base = bodyFor(
        resource,
        targetParents.brandId,
        targetParents.legalEntityId,
      );
      for (const extra of [
        { tenantId: target },
        { tenantId: other },
        { x: 1 },
      ]) {
        const res = await admin.client
          .post(path(target, resource))
          .set(originHeader)
          .send({ ...base, ...extra });
        expect(res.status, `${resource} ${JSON.stringify(extra)}`).toBe(422);
      }
      expect(await count(target, resource)).toBe(before);
      expect(await count(other, resource)).toBe(otherBefore);
    }
  });

  it("TEN-06 missing or invalid required fields are 422 (brand slug, entity NPWP, outlet code)", async () => {
    const badBodies: Array<[Resource, Record<string, unknown>]> = [
      ["brands", { name: "Tanpa slug" }],
      ["brands", brandBody({ slug: "Slug Salah!" })],
      ["legal-entities", entityBody({ name: "" })],
      ["legal-entities", entityBody({ npwp: "123" })],
      [
        "outlets",
        outletBody(targetParents.brandId, targetParents.legalEntityId, {
          code: "kode salah",
        }),
      ],
      ["outlets", { name: "Tanpa brand" }],
    ];
    for (const [resource, body] of badBodies) {
      const before = await count(target, resource);
      const res = await admin.client
        .post(path(target, resource))
        .set(originHeader)
        .send(body);
      expect(res.status, `${resource} ${JSON.stringify(body)}`).toBe(422);
      expect(await count(target, resource)).toBe(before);
    }
  });
});

describe("legend-0mn8 duplicates, atomicity and cross-tenant isolation", () => {
  it("TEN-06 duplicate brand slug in the same tenant is 409: no extra row, no extra audit", async () => {
    const tenantId = await tenant("Dup Brand");
    const body = brandBody();
    const first = await admin.client
      .post(path(tenantId, "brands"))
      .set(originHeader)
      .send(body);
    expect(first.status).toBe(201);
    const second = await admin.client
      .post(path(tenantId, "brands"))
      .set(originHeader)
      .send({ ...body, name: "Nama Lain" });
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(second.body.error.code).toBe("CONFLICT");
    expect(await count(tenantId, "brands")).toBe(1);
    expect(await auditCount(tenantId, "brands")).toBe(1);
  });

  it("TEN-06 duplicate outlet code in the same tenant is 409: atomic, no extra row or audit", async () => {
    const tenantId = await tenant("Dup Outlet");
    const parents = await seedParents(tenantId, "Dup");
    const body = outletBody(parents.brandId, parents.legalEntityId);
    const first = await admin.client
      .post(path(tenantId, "outlets"))
      .set(originHeader)
      .send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await admin.client
      .post(path(tenantId, "outlets"))
      .set(originHeader)
      .send({ ...body, name: "Nama Lain" });
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(second.body.error.code).toBe("CONFLICT");
    expect(await count(tenantId, "outlets")).toBe(1);
    expect(await auditCount(tenantId, "outlets")).toBe(1);
  });

  it("TEN-06 the same outlet code may exist in a different tenant (unique per tenant only)", async () => {
    const a = await tenant("Code A");
    const b = await tenant("Code B");
    const pa = await seedParents(a, "A");
    const pb = await seedParents(b, "B");
    const code = `T-${suffix().toUpperCase()}`;
    const ra = await admin.client
      .post(path(a, "outlets"))
      .set(originHeader)
      .send(outletBody(pa.brandId, pa.legalEntityId, { code }));
    const rb = await admin.client
      .post(path(b, "outlets"))
      .set(originHeader)
      .send(outletBody(pb.brandId, pb.legalEntityId, { code }));
    expect(ra.status, JSON.stringify(ra.body)).toBe(201);
    expect(rb.status, JSON.stringify(rb.body)).toBe(201);
    expect(rb.body.data.tenantId).toBe(b);
  });

  it("TEN-06 outlet with a brandId of another tenant is refused (404/422), no row, no audit, no leak", async () => {
    const tenantId = await tenant("Foreign Brand");
    const parents = await seedParents(tenantId, "FB");
    const body = outletBody(otherParents.brandId, parents.legalEntityId);
    const otherOutlets = await count(other, "outlets");
    const res = await admin.client
      .post(path(tenantId, "outlets"))
      .set(originHeader)
      .send(body);
    expect([404, 422], JSON.stringify(res.body)).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain("Brand Foreign");
    expect(JSON.stringify(res.body)).not.toContain(other);
    expect(await count(tenantId, "outlets")).toBe(0);
    expect(await auditCount(tenantId, "outlets")).toBe(0);
    expect(await count(other, "outlets")).toBe(otherOutlets);
  });

  it("TEN-06 outlet with a legalEntityId of another tenant is refused (404/422), no row, no audit, no leak", async () => {
    const tenantId = await tenant("Foreign LE");
    const parents = await seedParents(tenantId, "FL");
    const body = outletBody(parents.brandId, otherParents.legalEntityId);
    const otherOutlets = await count(other, "outlets");
    const res = await admin.client
      .post(path(tenantId, "outlets"))
      .set(originHeader)
      .send(body);
    expect([404, 422], JSON.stringify(res.body)).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain("PT Seed Foreign");
    expect(JSON.stringify(res.body)).not.toContain(other);
    expect(await count(tenantId, "outlets")).toBe(0);
    expect(await auditCount(tenantId, "outlets")).toBe(0);
    expect(await count(other, "outlets")).toBe(otherOutlets);
  });

  it("TEN-06 outlet with unknown brandId/legalEntityId is refused (404/422) and writes nothing", async () => {
    const tenantId = await tenant("Ghost Parents");
    const res = await admin.client
      .post(path(tenantId, "outlets"))
      .set(originHeader)
      .send(outletBody(randomUUID(), randomUUID()));
    expect([404, 422], JSON.stringify(res.body)).toContain(res.status);
    expect(await count(tenantId, "outlets")).toBe(0);
    expect(await auditCount(tenantId, "outlets")).toBe(0);
  });

  // Assumption: the brief says 409 or 422; the shared contract
  // (platformErrorHttpStatus.TENANT_NOT_ACTIVE) says 403 for a suspended or
  // archived tenant. Any of 403/409/422 is accepted: the point is "not 201,
  // nothing written". Status 404 or 5xx still fail.
  it("TEN-06 archived tenant refuses POST brands/outlets/legal-entities (403/409/422, never 201): no row, no audit", async () => {
    const tenantId = await tenant("Archived Target");
    const parents = await seedParents(tenantId, "Archived");
    await owner.query(
      `UPDATE tenants SET status = 'archived', archived_at = now(),
              status_before_archive = 'active' WHERE id = $1`,
      [tenantId],
    );
    for (const resource of resources) {
      const before = await count(tenantId, resource);
      const auditBefore = await auditCount(tenantId);
      const res = await admin.client
        .post(path(tenantId, resource))
        .set(originHeader)
        .send(bodyFor(resource, parents.brandId, parents.legalEntityId));
      expect(
        [403, 409, 422],
        `${resource} ${JSON.stringify(res.body)}`,
      ).toContain(res.status);
      expect(await count(tenantId, resource), resource).toBe(before);
      expect(await auditCount(tenantId), resource).toBe(auditBefore);
    }
  });

  // Assumption: a suspended tenant is still managed by the platform admin
  // (onboarding / fixing data), so create is allowed (201). The outlet quota
  // still applies but is not exercised here (default limits are not reached).
  it("TEN-06 suspended tenant still accepts POST brands/legal-entities/outlets (201) with one audit row each", async () => {
    const tenantId = await tenant("Suspended Target");
    const parents = await seedParents(tenantId, "Suspended");
    await owner.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [
      tenantId,
    ]);
    for (const resource of resources) {
      const before = await count(tenantId, resource);
      const auditBefore = await auditCount(tenantId, resource);
      const res = await admin.client
        .post(path(tenantId, resource))
        .set(originHeader)
        .send(bodyFor(resource, parents.brandId, parents.legalEntityId));
      expect(res.status, `${resource} ${JSON.stringify(res.body)}`).toBe(201);
      expect(res.body.data.tenantId, resource).toBe(tenantId);
      expect(await count(tenantId, resource), resource).toBe(before + 1);
      expect(await auditCount(tenantId, resource), resource).toBe(
        auditBefore + 1,
      );
    }
  });

  it("TEN-06 creating in tenant A never changes tenant B and the audit stays on the path tenant", async () => {
    const tenantId = await tenant("Isolation A");
    const otherBefore = {
      brands: await count(other, "brands"),
      outlets: await count(other, "outlets"),
      entities: await count(other, "legal-entities"),
      audit: await auditCount(other),
    };
    const brand = await admin.client
      .post(path(tenantId, "brands"))
      .set(originHeader)
      .send(brandBody())
      .set("X-Tenant-Id", other);
    const entity = await admin.client
      .post(path(tenantId, "legal-entities"))
      .set(originHeader)
      .send(entityBody())
      .set("X-Tenant-Id", other);
    expect(brand.status, JSON.stringify(brand.body)).toBe(201);
    expect(entity.status, JSON.stringify(entity.body)).toBe(201);
    expect(brand.body.data.tenantId).toBe(tenantId);
    expect(entity.body.data.tenantId).toBe(tenantId);
    expect({
      brands: await count(other, "brands"),
      outlets: await count(other, "outlets"),
      entities: await count(other, "legal-entities"),
      audit: await auditCount(other),
    }).toEqual(otherBefore);
    expect(await auditCount(tenantId)).toBe(2);
  });
});

describe("legend-0mn8 concurrency", () => {
  // Assumption: a deterministic deadlock (loyalty journal lock vs. tenant row
  // lock) cannot be reproduced from the HTTP contract alone, so this fires
  // overlapping creates (different outlet codes + a brand + a legal entity in
  // the same tenant, repeated in rounds). Expectation: every request is 201,
  // none is 5xx (no 40P01 deadlock), and every row + audit event is written.
  it("TEN-06 parallel outlet, brand and legal-entity creates in one tenant all return 201, never 5xx", async () => {
    const tenantId = await tenant("Parallel Create");
    const parents = await seedParents(tenantId, "Parallel");
    const rounds = 1; // default plan allows 5 outlets
    const outletsPerRound = 4;
    const all: Array<{ resource: Resource; status: number; body: unknown }> =
      [];
    for (let round = 0; round < rounds; round++) {
      const requests: Array<
        Promise<{ resource: Resource; res: { status: number; body: unknown } }>
      > = [];
      for (let i = 0; i < outletsPerRound; i++) {
        requests.push(
          admin.client
            .post(path(tenantId, "outlets"))
            .set(originHeader)
            .send(
              outletBody(parents.brandId, parents.legalEntityId, {
                code: `P-${round}${i}-${suffix().toUpperCase()}`,
              }),
            )
            .then((res) => ({ resource: "outlets" as Resource, res })),
        );
      }
      requests.push(
        admin.client
          .post(path(tenantId, "brands"))
          .set(originHeader)
          .send(brandBody())
          .then((res) => ({ resource: "brands" as Resource, res })),
        admin.client
          .post(path(tenantId, "legal-entities"))
          .set(originHeader)
          .send(entityBody({ npwp: null }))
          .then((res) => ({ resource: "legal-entities" as Resource, res })),
      );
      for (const { resource, res } of await Promise.all(requests))
        all.push({ resource, status: res.status, body: res.body });
    }
    for (const r of all) {
      expect(r.status, `${r.resource} ${JSON.stringify(r.body)}`).toBe(201);
    }
    expect(all.filter((r) => r.status >= 500)).toEqual([]);
    expect(await count(tenantId, "outlets")).toBe(rounds * outletsPerRound);
    expect(await count(tenantId, "brands")).toBe(1 + rounds);
    expect(await count(tenantId, "legal-entities")).toBe(1 + rounds);
    expect(await auditCount(tenantId, "outlets")).toBe(
      rounds * outletsPerRound,
    );
    expect(await auditCount(tenantId, "brands")).toBe(rounds);
    expect(await auditCount(tenantId, "legal-entities")).toBe(rounds);
  });
});
