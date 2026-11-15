// Custom domain claims (legend-t57t): hostnames are claimed per tenant and only
// a DNS TXT proof makes one serve; one verified owner per host, platform
// domains are reserved. Tenant B is driven through the service because the
// HTTP session of these tests always resolves to the seeded tenant.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { BrandId, ScopedTenantContext } from "@starter/shared/core";

// env.ts parses process.env at import time.
vi.hoisted(() => {
  process.env.PLATFORM_DOMAIN = "platform.claim.example";
});

import { createApp } from "../app";
import { resolveHostname } from "../services/org-resolve.service";
import {
  addDomain,
  listDomains,
  setDomainTxtResolver,
  verifyDomain,
} from "../services/org.service";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers";

const app = createApp();
const fixtures = cafeLegendPlatformFixtures;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

type Tenant = { id: string; brandId: BrandId; context: ScopedTenantContext };
const tenantIds: string[] = [];

function contextOf(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

async function makeTenant(): Promise<Tenant> {
  const id = randomUUID();
  const brandId = randomUUID() as BrandId;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Klaim Domain', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `uji-dc-${id.slice(0, 8)}`,
      JSON.stringify({ modules: ["pos"], integrationProviders: [] }),
      JSON.stringify({
        maxOutlets: 5,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
    [brandId, id],
  );
  tenantIds.push(id);
  return { id, brandId, context: contextOf(id) };
}

function host(): string {
  return `klaim-${randomBytes(4).toString("hex")}.example.com`;
}

/** Fake DNS: every name maps to the TXT values published for it. */
function publish(records: Record<string, string[][]>) {
  setDomainTxtResolver(async (name) => {
    const found = records[name];
    if (!found) throw Object.assign(new Error("no data"), { code: "ENODATA" });
    return found;
  });
}

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

// Audit actor of every service call (legend-ix04y); the audit rows are asserted in
// tenant-domain-audit.test.ts.
const actor = randomUUID();

let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  a = await makeTenant();
  b = await makeTenant();
});

afterEach(() => setDomainTxtResolver(null));

afterAll(async () => {
  // The seeded tenant is reused for the HTTP test: keep its fixture domains,
  // later test files resolve them.
  await owner.query(
    "DELETE FROM tenant_domains WHERE tenant_id = ANY($1) AND hostname <> ALL($2)",
    [tenantIds, fixtures.domains.map((domain) => domain.hostname)],
  );
  await owner.end();
});

describe("tenant domain claims", () => {
  it("lets B add A's unverified host; A verifies and wins resolution", async () => {
    const hostname = host();
    const claimA = await addDomain(
      a.context,
      { brandId: a.brandId, hostname },
      actor,
    );
    const claimB = await addDomain(
      b.context,
      { brandId: b.brandId, hostname },
      actor,
    );
    expect(claimA.verification).toMatchObject({
      type: "TXT",
      name: `_legend-verification.${hostname}`,
    });
    expect(claimA.verification?.value).toMatch(
      /^legend-domain-verification=[0-9a-f]{64}$/,
    );
    expect(claimB.verification?.value).not.toBe(claimA.verification?.value);
    expect((await resolveHostname(hostname)).ok).toBe(false);

    publish({
      [claimA.verification!.name]: [[claimA.verification!.value]],
    });
    const verified = await verifyDomain(a.context, claimA.id, actor);
    expect(verified.verifiedAt).not.toBeNull();
    expect(verified.verification).toBeNull();

    const resolved = await resolveHostname(hostname);
    expect(resolved).toMatchObject({ ok: true, tenantId: a.id });
  });

  it("joins TXT chunks and returns an already verified row unchanged", async () => {
    const hostname = host();
    const claim = await addDomain(
      a.context,
      { brandId: a.brandId, hostname },
      actor,
    );
    const value = claim.verification!.value;
    publish({
      [claim.verification!.name]: [
        ["unrelated"],
        [value.slice(0, 20), value.slice(20)],
      ],
    });
    const verified = await verifyDomain(a.context, claim.id, actor);
    expect(verified.verifiedAt).not.toBeNull();
    setDomainTxtResolver(async () => {
      throw new Error("must not look up a verified row");
    });
    expect(await verifyDomain(a.context, claim.id, actor)).toEqual(verified);
  });

  it("refuses B's verification once A holds the host", async () => {
    const hostname = host();
    const claimA = await addDomain(
      a.context,
      { brandId: a.brandId, hostname },
      actor,
    );
    const claimB = await addDomain(
      b.context,
      { brandId: b.brandId, hostname },
      actor,
    );
    publish({
      [claimA.verification!.name]: [
        [claimA.verification!.value],
        [claimB.verification!.value],
      ],
    });
    await verifyDomain(a.context, claimA.id, actor);
    expect(await codeOf(verifyDomain(b.context, claimB.id, actor))).toBe(
      "DOMAIN_TAKEN",
    );
    const rows = await listDomains(b.context);
    expect(
      rows.data.find((row) => row.id === claimB.id)?.verifiedAt,
    ).toBeNull();
    expect(await resolveHostname(hostname)).toMatchObject({
      ok: true,
      tenantId: a.id,
    });
  });

  it("keeps a row unverified when the proof is wrong, missing or the lookup fails", async () => {
    const hostname = host();
    const claim = await addDomain(
      a.context,
      { brandId: a.brandId, hostname },
      actor,
    );
    const name = claim.verification!.name;

    publish({ [name]: [["legend-domain-verification=wrong"]] });
    expect(await codeOf(verifyDomain(a.context, claim.id, actor))).toBe(
      "DOMAIN_VERIFICATION_FAILED",
    );
    publish({});
    expect(await codeOf(verifyDomain(a.context, claim.id, actor))).toBe(
      "DOMAIN_VERIFICATION_FAILED",
    );
    for (const code of ["ENOTFOUND", "ESERVFAIL", "ETIMEOUT"]) {
      setDomainTxtResolver(async () => {
        throw Object.assign(new Error(code), { code });
      });
      expect(await codeOf(verifyDomain(a.context, claim.id, actor))).toBe(
        "DOMAIN_VERIFICATION_FAILED",
      );
    }
    setDomainTxtResolver(async () => {
      throw new Error("boom");
    });
    expect(await codeOf(verifyDomain(a.context, claim.id, actor))).toBe(
      "DOMAIN_VERIFICATION_FAILED",
    );

    const rows = await listDomains(a.context);
    expect(rows.data.find((row) => row.id === claim.id)?.verifiedAt).toBeNull();
    expect(await resolveHostname(hostname)).toEqual({
      ok: false,
      reason: "unverified",
    });
  });

  it("verifies only the caller's own row", async () => {
    const claim = await addDomain(
      a.context,
      {
        brandId: a.brandId,
        hostname: host(),
      },
      actor,
    );
    publish({ [claim.verification!.name]: [[claim.verification!.value]] });
    expect(await codeOf(verifyDomain(b.context, claim.id, actor))).toBe(
      "NOT_FOUND",
    );
  });

  it("rejects the same tenant adding a host twice", async () => {
    const hostname = host();
    await addDomain(a.context, { brandId: a.brandId, hostname }, actor);
    expect(
      await codeOf(
        addDomain(a.context, { brandId: a.brandId, hostname }, actor),
      ),
    ).toBe("DOMAIN_TAKEN");
  });

  it("reserves the platform domain and everything under it", async () => {
    for (const hostname of [
      "platform.claim.example",
      "cafe.platform.claim.example",
    ]) {
      expect(
        await codeOf(
          addDomain(a.context, { brandId: a.brandId, hostname }, actor),
        ),
      ).toBe("DOMAIN_RESERVED");
    }
    const lookalike = await addDomain(
      a.context,
      {
        brandId: a.brandId,
        hostname: "notplatform.claim.example",
      },
      actor,
    );
    expect(lookalike.kind).toBe("custom");
  });
});

describe("tenant domain claims over HTTP", () => {
  async function adminClient() {
    const client = agent(app);
    const email = await signUp(client, "Domain Admin");
    await setRole(email, "admin");
    const session = await client.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
       WHERE tenant_id = $1 AND template_key = 'owner'`,
      [fixtures.tenant.id, userId],
    );
    await verifySessionMfa(email);
    tenantIds.push(fixtures.tenant.id);
    return client;
  }

  it("adds, verifies over the route, and answers reserved and failed codes", async () => {
    const client = await adminClient();
    const brandId = (await client.get("/api/org/brands")).body.data[0]
      .id as string;
    const hostname = host();

    const created = await client
      .post("/api/org/domains")
      .set(originHeader)
      .send({ brandId, hostname });
    expect(created.status).toBe(201);
    expect(created.body.data.verification.type).toBe("TXT");

    const reserved = await client
      .post("/api/org/domains")
      .set(originHeader)
      .send({ brandId, hostname: "platform.claim.example" });
    expect(reserved.status).toBe(422);
    expect(reserved.body.error.code).toBe("DOMAIN_RESERVED");

    const path = `/api/org/domains/${created.body.data.id}/verify`;
    expect((await client.post(path)).status).toBe(403); // origin check

    publish({});
    const failed = await client.post(path).set(originHeader);
    expect(failed.status).toBe(422);
    expect(failed.body.error.code).toBe("DOMAIN_VERIFICATION_FAILED");

    publish({
      [created.body.data.verification.name]: [
        [created.body.data.verification.value],
      ],
    });
    const ok = await client.post(path).set(originHeader);
    expect(ok.status).toBe(200);
    expect(ok.body.data.verifiedAt).not.toBeNull();
    expect(ok.body.data.verification).toBeNull();

    const missing = await client
      .post(`/api/org/domains/${randomUUID()}/verify`)
      .set(originHeader);
    expect(missing.status).toBe(404);

    await owner.query("DELETE FROM tenant_domains WHERE hostname = $1", [
      hostname,
    ]);
  });
});
