// Audit trail of tenant domain writes (legend-ix04y). add, remove, verify and a
// failed verification each leave one `audit_logs` row of object type
// `tenant_domain`, written by the acting user, isolated per tenant, and never
// carrying the verification token or the DNS TXT record.
//
// Assumptions (CONTRACT/brief, not implementation):
// - actions are `tenant_domain.added|removed|verified|verification_failed`;
// - the hostname is audited under the key `domain` (`hostname` would be masked);
// - an already verified row, or a failed add, writes no new audit row;
// - rows are read as the table owner by `objectId` (the domain id) and
//   `tenant_id`; tenant isolation is asserted on that same column (RLS itself is
//   covered by audit-events.test.ts).
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
  process.env.PLATFORM_DOMAIN = "platform.audit.example";
});

import { sql } from "drizzle-orm";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  addDomain,
  removeDomain,
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
     VALUES ($1, $2, 'Uji Audit Domain', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `uji-da-${id.slice(0, 8)}`,
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
  return `audit-${randomBytes(4).toString("hex")}.example.com`;
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

type AuditEvent = {
  id: string;
  tenantId: string;
  actorType: string;
  actorId: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  maskedChanges: {
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  };
};

/** Every audit event written about one domain row, oldest first. */
async function auditOf(
  tenantId: string,
  domainId: string,
): Promise<AuditEvent[]> {
  const result = await owner.query(
    `SELECT event FROM audit_logs
     WHERE tenant_id = $1 AND event::jsonb ->> 'objectId' = $2
     ORDER BY created_at, id`,
    [tenantId, domainId],
  );
  return result.rows.map((row) =>
    typeof row.event === "string" ? JSON.parse(row.event) : row.event,
  ) as AuditEvent[];
}

const actions = (events: AuditEvent[]) => events.map((event) => event.action);

let a: Tenant;
let b: Tenant;
const actorA = randomUUID();
const actorB = randomUUID();

beforeAll(async () => {
  a = await makeTenant();
  b = await makeTenant();
});

afterEach(() => setDomainTxtResolver(null));

afterAll(async () => {
  // audit_logs is append-only and keeps its rows. The seeded tenant is reused
  // for the HTTP test: keep its fixture domains.
  await owner.query(
    "DELETE FROM tenant_domains WHERE tenant_id = ANY($1) AND hostname <> ALL($2)",
    [tenantIds, fixtures.domains.map((domain) => domain.hostname)],
  );
  await owner.end();
});

describe("legend-ix04y tenant domain audit (service)", () => {
  it("1. add writes one tenant_domain.added row for the actor", async () => {
    const hostname = host();
    const claim = await addDomain(
      a.context,
      { brandId: a.brandId, hostname },
      actorA,
    );

    const events = await auditOf(a.id, claim.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: a.id,
      actorType: "user",
      actorId: actorA,
      action: "tenant_domain.added",
      objectType: "tenant_domain",
      objectId: claim.id,
    });
    expect(events[0]?.maskedChanges.before).toBeNull();
    expect(events[0]?.maskedChanges.after).toMatchObject({
      domain: hostname,
      kind: "custom",
      brandId: a.brandId,
      verified: false,
    });
  });

  it("1b. a refused add (taken or reserved host) writes no audit row", async () => {
    const hostname = host();
    const claim = await addDomain(
      a.context,
      { brandId: a.brandId, hostname },
      actorA,
    );
    expect(
      await codeOf(
        addDomain(a.context, { brandId: a.brandId, hostname }, actorA),
      ),
    ).toBe("DOMAIN_TAKEN");
    expect(
      await codeOf(
        addDomain(
          a.context,
          { brandId: a.brandId, hostname: "platform.audit.example" },
          actorA,
        ),
      ),
    ).toBe("DOMAIN_RESERVED");

    expect(actions(await auditOf(a.id, claim.id))).toEqual([
      "tenant_domain.added",
    ]);
    const reserved = await owner.query(
      `SELECT count(*)::int AS n FROM audit_logs
       WHERE tenant_id = $1 AND event::jsonb #>> '{maskedChanges,after,domain}' = $2`,
      [a.id, "platform.audit.example"],
    );
    expect(reserved.rows[0].n).toBe(0);
  });

  it("2. remove writes one tenant_domain.removed row with the old values", async () => {
    const hostname = host();
    const claim = await addDomain(
      a.context,
      { brandId: a.brandId, hostname },
      actorA,
    );
    await removeDomain(a.context, claim.id, actorB);

    const events = await auditOf(a.id, claim.id);
    expect(actions(events)).toEqual([
      "tenant_domain.added",
      "tenant_domain.removed",
    ]);
    expect(events[1]).toMatchObject({
      tenantId: a.id,
      actorType: "user",
      actorId: actorB,
      objectType: "tenant_domain",
      objectId: claim.id,
    });
    expect(events[1]?.maskedChanges.before).toMatchObject({
      domain: hostname,
      kind: "custom",
      brandId: a.brandId,
      verified: false,
    });
    expect(events[1]?.maskedChanges.after).toBeNull();
  });

  it("3. a successful verification writes one tenant_domain.verified row", async () => {
    const hostname = host();
    const claim = await addDomain(
      a.context,
      { brandId: a.brandId, hostname },
      actorA,
    );
    publish({ [claim.verification!.name]: [[claim.verification!.value]] });
    await verifyDomain(a.context, claim.id, actorB);

    const events = await auditOf(a.id, claim.id);
    expect(actions(events)).toEqual([
      "tenant_domain.added",
      "tenant_domain.verified",
    ]);
    expect(events[1]).toMatchObject({
      tenantId: a.id,
      actorType: "user",
      actorId: actorB,
      objectId: claim.id,
    });
    expect(events[1]?.maskedChanges.before).toMatchObject({
      domain: hostname,
      verified: false,
    });
    expect(events[1]?.maskedChanges.after).toMatchObject({
      domain: hostname,
      verified: true,
    });
  });

  it("4. a failed verification throws and still leaves a verification_failed row", async () => {
    const hostname = host();
    const claim = await addDomain(
      a.context,
      { brandId: a.brandId, hostname },
      actorA,
    );
    publish({}); // no TXT published

    expect(await codeOf(verifyDomain(a.context, claim.id, actorB))).toBe(
      "DOMAIN_VERIFICATION_FAILED",
    );

    const events = await auditOf(a.id, claim.id);
    expect(actions(events)).toEqual([
      "tenant_domain.added",
      "tenant_domain.verification_failed",
    ]);
    expect(events[1]).toMatchObject({
      tenantId: a.id,
      actorType: "user",
      actorId: actorB,
      objectType: "tenant_domain",
      objectId: claim.id,
    });
    expect(events[1]?.maskedChanges.before).toMatchObject({
      domain: hostname,
      verified: false,
    });
    expect(events[1]?.maskedChanges.after).toMatchObject({
      domain: hostname,
      result: "failed",
      reason: "dns_txt_mismatch",
    });
  });

  it("4b. a lookup that throws is audited the same way", async () => {
    const claim = await addDomain(
      a.context,
      { brandId: a.brandId, hostname: host() },
      actorA,
    );
    setDomainTxtResolver(async () => {
      throw new Error("boom");
    });
    expect(await codeOf(verifyDomain(a.context, claim.id, actorA))).toBe(
      "DOMAIN_VERIFICATION_FAILED",
    );
    expect(actions(await auditOf(a.id, claim.id))).toEqual([
      "tenant_domain.added",
      "tenant_domain.verification_failed",
    ]);
  });

  it("4c. losing the host to another tenant audits verification_failed (domain_taken)", async () => {
    const hostname = host();
    const claimA = await addDomain(
      a.context,
      { brandId: a.brandId, hostname },
      actorA,
    );
    const claimB = await addDomain(
      b.context,
      { brandId: b.brandId, hostname },
      actorB,
    );
    publish({
      [claimA.verification!.name]: [
        [claimA.verification!.value],
        [claimB.verification!.value],
      ],
    });
    await verifyDomain(a.context, claimA.id, actorA);

    expect(await codeOf(verifyDomain(b.context, claimB.id, actorB))).toBe(
      "DOMAIN_TAKEN",
    );

    const events = await auditOf(b.id, claimB.id);
    expect(actions(events)).toEqual([
      "tenant_domain.added",
      "tenant_domain.verification_failed",
    ]);
    expect(events[1]?.maskedChanges.after).toMatchObject({
      domain: hostname,
      result: "failed",
      reason: "domain_taken",
    });
  });

  it("6. one tenant's audit rows never appear under another tenant", async () => {
    const hostA = host();
    const hostB = host();
    const claimA = await addDomain(
      a.context,
      { brandId: a.brandId, hostname: hostA },
      actorA,
    );
    const claimB = await addDomain(
      b.context,
      { brandId: b.brandId, hostname: hostB },
      actorB,
    );

    expect(await auditOf(b.id, claimA.id)).toEqual([]);
    expect(await auditOf(a.id, claimB.id)).toEqual([]);
    const seenByA = await owner.query(
      `SELECT event FROM audit_logs
       WHERE tenant_id = $1 AND event::jsonb ->> 'objectType' = 'tenant_domain'`,
      [a.id],
    );
    const text = JSON.stringify(seenByA.rows);
    expect(text).toContain(hostA);
    expect(text).not.toContain(hostB);
    expect(text).not.toContain(claimB.id);
    expect((await auditOf(b.id, claimB.id))[0]).toMatchObject({
      tenantId: b.id,
      actorId: actorB,
    });

    // Real RLS: read as tenant B through the app role; A's rows stay hidden.
    const seenByB = await withTenant(db, b.context, async (tx) =>
      JSON.stringify(
        (await tx.execute(sql`SELECT event FROM audit_logs`)).rows,
      ),
    );
    expect(seenByB).toContain(hostB);
    expect(seenByB).not.toContain(hostA);
    expect(seenByB).not.toContain(claimA.id);
  });

  it("7. no verification token or TXT record reaches any audit row", async () => {
    const hostname = host();
    const claim = await addDomain(
      a.context,
      { brandId: a.brandId, hostname },
      actorA,
    );
    const txtValue = claim.verification!.value;
    const txtName = claim.verification!.name;
    const rawToken = txtValue.replace("legend-domain-verification=", "");
    expect(rawToken).toMatch(/^[0-9a-f]{64}$/);

    publish({}); // failed attempt
    await codeOf(verifyDomain(a.context, claim.id, actorA));
    publish({ [txtName]: [[txtValue]] }); // then a successful one
    await verifyDomain(a.context, claim.id, actorA);
    await removeDomain(a.context, claim.id, actorA);

    const events = await auditOf(a.id, claim.id);
    expect(actions(events)).toEqual([
      "tenant_domain.added",
      "tenant_domain.verification_failed",
      "tenant_domain.verified",
      "tenant_domain.removed",
    ]);
    const text = JSON.stringify(events);
    expect(text).not.toContain(rawToken);
    expect(text).not.toContain(txtValue);
    expect(text).not.toContain(txtName);
    expect(text).not.toContain("legend-domain-verification");
    expect(text).not.toContain("verificationToken");
  });

  it("8. verifying an already verified domain adds no audit row", async () => {
    const claim = await addDomain(
      a.context,
      { brandId: a.brandId, hostname: host() },
      actorA,
    );
    publish({ [claim.verification!.name]: [[claim.verification!.value]] });
    await verifyDomain(a.context, claim.id, actorA);
    const before = await auditOf(a.id, claim.id);
    expect(actions(before)).toEqual([
      "tenant_domain.added",
      "tenant_domain.verified",
    ]);

    await verifyDomain(a.context, claim.id, actorA);
    await verifyDomain(a.context, claim.id, actorB);

    expect(await auditOf(a.id, claim.id)).toEqual(before);
  });
});

describe("legend-ix04y tenant domain audit (HTTP)", () => {
  async function adminClient() {
    const client = agent(app);
    const email = await signUp(client, "Domain Audit Admin");
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
    return { client, userId };
  }

  it("5. add, failed verify, verify and delete over the routes each audit the signed-in user", async () => {
    const { client, userId } = await adminClient();
    const brandId = (await client.get("/api/org/brands")).body.data[0]
      .id as string;
    const hostname = host();

    const created = await client
      .post("/api/org/domains")
      .set(originHeader)
      .send({ brandId, hostname });
    expect(created.status).toBe(201);
    const domainId = created.body.data.id as string;
    const tenantId = fixtures.tenant.id;

    let events = await auditOf(tenantId, domainId);
    expect(actions(events)).toEqual(["tenant_domain.added"]);
    expect(events[0]).toMatchObject({
      actorType: "user",
      actorId: userId,
      objectType: "tenant_domain",
      objectId: domainId,
    });
    expect(events[0]?.maskedChanges.after).toMatchObject({ domain: hostname });

    const path = `/api/org/domains/${domainId}/verify`;
    publish({});
    const failed = await client.post(path).set(originHeader);
    expect(failed.status).toBe(422);
    expect(failed.body.error.code).toBe("DOMAIN_VERIFICATION_FAILED");
    events = await auditOf(tenantId, domainId);
    expect(actions(events)).toEqual([
      "tenant_domain.added",
      "tenant_domain.verification_failed",
    ]);
    expect(events[1]).toMatchObject({ actorId: userId });

    publish({
      [created.body.data.verification.name]: [
        [created.body.data.verification.value],
      ],
    });
    const verified = await client.post(path).set(originHeader);
    expect(verified.status).toBe(200);
    events = await auditOf(tenantId, domainId);
    expect(actions(events)).toEqual([
      "tenant_domain.added",
      "tenant_domain.verification_failed",
      "tenant_domain.verified",
    ]);
    expect(events[2]).toMatchObject({ actorId: userId });

    const removed = await client
      .delete(`/api/org/domains/${domainId}`)
      .set(originHeader);
    expect(removed.status).toBe(204);
    events = await auditOf(tenantId, domainId);
    expect(actions(events)).toEqual([
      "tenant_domain.added",
      "tenant_domain.verification_failed",
      "tenant_domain.verified",
      "tenant_domain.removed",
    ]);
    expect(events[3]).toMatchObject({ actorId: userId });
    expect(events[3]?.maskedChanges.before).toMatchObject({
      domain: hostname,
      verified: true,
    });

    const text = JSON.stringify(events);
    expect(text).not.toContain(created.body.data.verification.value);
  });
});
