// Default refund approval matrix, level 1 for supervisor, outlet manager,
// general manager and owner (brief 532 B2; founder Q63; mirrors the cash shift
// close default). Before this change the default matrix named only the
// supervisor, whose Q63 ceiling is Rp200.000, so a Rp1.000.000 refund on a
// default tenant could not be approved by anyone the matrix lets decide it.
//
// Written from the Q63 ceilings (supervisor Rp200.000, outlet manager
// Rp1.000.000, general manager Rp5.000.000, owner above) and the brief, not from
// the implementation. Real HTTP, Better Auth, roles, approval inbox, PostgreSQL
// (RLS on); only the refund provider is the fake gateway.
//
// Assumptions where the brief is silent:
// - The default rows are written out here, not imported, so a wrong shared
//   constant cannot hide itself: threshold Rp0, level 1, distinct actor, for
//   exactly supervisor, outlet_manager, general_manager and owner.
// - "Data migration" is the new migration numbered 0285-0286 whose SQL inserts
//   into approval_policies for action_type 'refund'. It is re-run inside a
//   rolled-back transaction (as payment-refund-default-tier does), so it cannot
//   change tenants owned by other suites.
// - The migration gives the full default to a tenant with no refund rows, and
//   widens a tenant that still holds exactly the OLD default (one supervisor row
//   from Rp0, level 1) to the new default; any other (configured) matrix is never
//   touched, and re-running adds nothing. A tenant that deliberately kept only
//   the supervisor row cannot be told apart from the old default; that is the
//   accepted trade-off of this assumption.
// - A refund decided over the approver's ceiling through the approval inbox is
//   refused with 403 REFUND_APPROVAL_LIMIT_EXCEEDED and the request stays
//   pending (same contract as payment-refund-role-limits).
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { and, eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { tenantIdSchema } from "@starter/shared/core";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { db } from "../db";
import { paymentRefunds } from "../db/schema/index";
import { withTenant } from "../db/tenant";
import { outletContext } from "../services/device-pin-support";
import { openRefundChainAtRequest } from "../services/payment-refund.service";
import { seedTenantRoleTemplates } from "../services/access.service";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import { createIsolatedTenant } from "./floor-test-helpers";
import { FakeRefundGateway } from "./refund-fake-gateway";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletId = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const ADMIN = "/api/payments/admin";
type Client = ReturnType<typeof agent>;
type Level = "supervisor" | "outlet_manager" | "general_manager" | "owner";
const LEVELS: readonly Level[] = [
  "supervisor",
  "outlet_manager",
  "general_manager",
  "owner",
];

// Sorted by template key, as the query below orders them.
const DEFAULT_ROWS = [
  { threshold: 0, level: 1, template: "general_manager", distinct: true },
  { threshold: 0, level: 1, template: "outlet_manager", distinct: true },
  { threshold: 0, level: 1, template: "owner", distinct: true },
  { threshold: 0, level: 1, template: "supervisor", distinct: true },
];
const OLD_DEFAULT_ROWS = [
  { threshold: 0, level: 1, template: "supervisor", distinct: true },
];

const tenantContext = (id: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(id),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

const users: string[] = [];
const links: string[] = [];
const intents: string[] = [];
const refunds: string[] = [];
const approvers = new Map<Level, { client: Client; id: string }>();
let requester: Client;
let requesterId: string;
let savedPolicies: Record<string, unknown>[] = [];
let gateway: FakeRefundGateway;
const key = () => `mgr-${randomUUID()}`;

async function roleId(template: string, tenant: string = tenantId) {
  const result = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenant, template],
  );
  if (!result.rows[0]) throw new Error(`Missing role ${template}`);
  return result.rows[0].id;
}

async function grant(userId: string, template: string, scope: string | null) {
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
    [
      tenantId,
      userId,
      await roleId(template),
      scope === null ? "tenant" : "outlet",
      scope,
    ],
  );
}

async function user(label: string) {
  const client = agent(app);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const id = session.body.user.id as string;
  users.push(id);
  await verifySessionMfa(email);
  return { client, id };
}

type PolicyRow = {
  threshold: number | null;
  level: number;
  template_key: string | null;
  requires_distinct_actor: boolean;
};

async function refundPolicies(
  tenant: string,
  via: Pick<PoolClient, "query"> = owner,
) {
  const { rows } = await via.query<PolicyRow>(
    `SELECT p.threshold_idr::int AS threshold, p.levels AS level, r.template_key,
            p.requires_distinct_actor
     FROM approval_policies p JOIN roles r ON r.id = p.approver_role_id
     WHERE p.tenant_id = $1 AND p.action_type = 'refund'
     ORDER BY p.threshold_idr NULLS FIRST, p.levels, r.template_key`,
    [tenant],
  );
  return rows.map((row) => ({
    threshold: row.threshold,
    level: row.level,
    template: row.template_key,
    distinct: row.requires_distinct_actor,
  }));
}

/** Back to the factory matrix of the seeded tenant, through the real seeding path. */
async function resetToDefaults() {
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [tenantId],
  );
  await withTenant(db, tenantContext(tenantId), (tx) =>
    seedTenantRoleTemplates(tx, tenantId),
  );
}

async function provisionedTenant() {
  const suffix = `rm${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const isolated = await createIsolatedTenant(suffix);
  await withTenant(db, tenantContext(isolated.tenantId), (tx) =>
    seedTenantRoleTemplates(tx, isolated.tenantId),
  );
  return isolated.tenantId;
}

async function setRefundRows(
  tenant: string,
  rows: { threshold: number; template: string }[],
) {
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [tenant],
  );
  for (const row of rows)
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, 'refund', $2, $3, 1, true)`,
      [tenant, row.threshold, await roleId(row.template, tenant)],
    );
}

async function seedPaid(amountIdr: number) {
  const linkId = randomUUID();
  const intentId = randomUUID();
  links.push(linkId);
  intents.push(intentId);
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7)`,
    [
      linkId,
      tenantId,
      outletId,
      randomBytes(32).toString("hex"),
      `MGR-${linkId.slice(0, 8)}`,
      amountIdr,
      requesterId,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [intentId, tenantId, outletId, linkId, amountIdr, key()],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [tenantId, outletId, intentId, `evidence-${intentId}`, amountIdr],
  );
  return intentId;
}

async function request(amountIdr: number) {
  const intentId = await seedPaid(amountIdr);
  const response = await requester
    .post(`${ADMIN}/refunds`)
    .set(originHeader)
    .send({
      idempotencyKey: key(),
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pengembalian pesanan untuk matriks bawaan",
    });
  expect(response.status).toBe(201);
  const id = response.body.data.id as string;
  refunds.push(id);
  return id;
}

async function openChain(id: string) {
  const tenant = establishTenantContext({
    tenantId,
    brandId: null,
    source: "session",
  });
  const context = outletContext(tenant, outletId);
  await withTenant(db, context, async (tx) => {
    const [refund] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(eq(paymentRefunds.tenantId, tenantId), eq(paymentRefunds.id, id)),
      );
    if (!refund) throw new Error("Missing refund");
    await openRefundChainAtRequest(tx, context, refund, new Date());
  });
  const result = await owner.query<{ id: string }>(
    "SELECT id FROM approval_requests WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2 AND status = 'pending' ORDER BY level",
    [tenantId, id],
  );
  return result.rows[0]!.id;
}

async function decideInInbox(level: Level, refundId: string) {
  const requestId = await openChain(refundId);
  const response = await approvers
    .get(level)!
    .client.post(`/api/approvals/${requestId}/decisions`)
    .set(originHeader)
    .set("Idempotency-Key", key())
    .send({ decision: "approved", reason: "Bukti pengembalian sesuai" });
  const stored = await owner.query<{
    status: string;
    decided_by: string | null;
  }>("SELECT status, decided_by FROM approval_requests WHERE id = $1", [
    requestId,
  ]);
  return { response, request: stored.rows[0]! };
}

async function refundStatus(id: string) {
  const result = await owner.query<{ status: string }>(
    "SELECT status FROM payment_refunds WHERE tenant_id = $1 AND id = $2",
    [tenantId, id],
  );
  return result.rows[0]!.status;
}

/**
 * Run the new data migration (0285-0286, inserts refund approval policies) on a
 * dedicated connection inside a transaction that is always rolled back. It locks
 * roles and approval_policies, so every read inside goes through this same
 * connection.
 */
async function inRolledBackMigration<T>(
  inspect: (client: PoolClient, rerun: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const dir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
  const file = readdirSync(dir).find(
    (name) =>
      /^028[56]_.+\.sql$/.test(name) &&
      /approval_policies/.test(readFileSync(`${dir}${name}`, "utf8")) &&
      /'refund'/.test(readFileSync(`${dir}${name}`, "utf8")),
  );
  if (!file)
    throw new Error(
      "Missing data migration 028x that seeds the refund approval policies",
    );
  const statements = readFileSync(`${dir}${file}`, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const client = await owner.connect();
  const run = async () => {
    for (const statement of statements) await client.query(statement);
  };
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await run();
    return await inspect(client, run);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

beforeAll(async () => {
  const requesting = await user("Mgr matrix requester");
  requester = requesting.client;
  requesterId = requesting.id;
  // The requester files refunds through the payment admin endpoint.
  await grant(requesterId, "finance", null);
  for (const level of LEVELS) {
    const actor = await user(`Mgr matrix ${level}`);
    // Only the named role: finance is NOT in the default matrix, so the role
    // the matrix names is what lets this user decide.
    await grant(
      actor.id,
      level,
      level === "supervisor" || level === "outlet_manager" ? outletId : null,
    );
    approvers.set(level, actor);
  }
  savedPolicies = (
    await owner.query(
      "SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [tenantId],
    )
  ).rows;
});

beforeEach(async () => {
  gateway = new FakeRefundGateway();
  setPaymentRefundGateway(gateway);
  await resetToDefaults();
});
afterEach(() => setPaymentRefundGateway(null));

afterAll(async () => {
  await owner.query(
    "DELETE FROM approval_requests WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = ANY($2::text[])",
    [tenantId, refunds],
  );
  await owner.query(
    "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [intents],
  );
  await owner.query(
    "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
    [intents],
  );
  await owner.query("DELETE FROM payment_intents WHERE id = ANY($1::uuid[])", [
    intents,
  ]);
  await owner.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
    links,
  ]);
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [tenantId],
  );
  for (const row of savedPolicies)
    await owner.query(
      `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.id,
        row.tenant_id,
        row.action_type,
        row.threshold_idr,
        row.approver_role_id,
        row.levels,
        row.requires_distinct_actor,
      ],
    );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, users],
  );
  await owner.end();
});

describe("PAY-04 Q63 default refund matrix: seeding", () => {
  it("a new tenant gets level 1 for supervisor, outlet manager, general manager and owner from Rp0", async () => {
    const tenant = await provisionedTenant();
    expect(await refundPolicies(tenant)).toEqual(DEFAULT_ROWS);
  });

  it("seeding an existing tenant without refund rules adds the full default once", async () => {
    const tenant = await provisionedTenant();
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [tenant],
    );
    for (let run = 0; run < 2; run++)
      await withTenant(db, tenantContext(tenant), (tx) =>
        seedTenantRoleTemplates(tx, tenant),
      );
    expect(await refundPolicies(tenant)).toEqual(DEFAULT_ROWS);
  });

  it("seeding never touches a tenant that configured its own refund matrix", async () => {
    const tenant = await provisionedTenant();
    await setRefundRows(tenant, [
      { threshold: 250_000, template: "outlet_manager" },
    ]);
    const before = await refundPolicies(tenant);
    await withTenant(db, tenantContext(tenant), (tx) =>
      seedTenantRoleTemplates(tx, tenant),
    );
    expect(await refundPolicies(tenant)).toEqual(before);
  });

  it("the seeded default matrix of the main test tenant has the 4 rows", async () => {
    expect(await refundPolicies(tenantId)).toEqual(DEFAULT_ROWS);
  });
});

describe("PAY-04 Q63 default refund matrix: who can approve a Rp1.000.000 refund", () => {
  it("the outlet manager approves a Rp1.000.000 refund from the inbox", async () => {
    const id = await request(1_000_000);
    const { response, request: stored } = await decideInInbox(
      "outlet_manager",
      id,
    );
    expect(response.status).toBe(200);
    expect(stored.status).toBe("approved");
    expect(stored.decided_by).toBe(approvers.get("outlet_manager")!.id);
    expect(gateway.calls).toHaveLength(0);
  });

  it("the supervisor is refused on the same Rp1.000.000 refund: it stays pending, nothing is paid", async () => {
    const id = await request(1_000_000);
    const { response, request: stored } = await decideInInbox("supervisor", id);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("REFUND_APPROVAL_LIMIT_EXCEEDED");
    expect(stored).toEqual({ status: "pending", decided_by: null });
    expect(await refundStatus(id)).toBe("pending");
    expect(gateway.calls).toHaveLength(0);
  });

  it("the supervisor still approves Rp200.000, exactly its ceiling", async () => {
    const id = await request(200_000);
    const { response, request: stored } = await decideInInbox("supervisor", id);
    expect(response.status).toBe(200);
    expect(stored.status).toBe("approved");
  });

  it("the outlet manager is refused Rp1.000.001 (above the Rp1.000.000 ceiling)", async () => {
    const id = await request(1_000_001);
    const { response, request: stored } = await decideInInbox(
      "outlet_manager",
      id,
    );
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("REFUND_APPROVAL_LIMIT_EXCEEDED");
    expect(stored.status).toBe("pending");
    expect(gateway.calls).toHaveLength(0);
  });

  for (const level of ["general_manager", "owner"] as const) {
    it(`the ${level} approves Rp1.000.001 from the inbox`, async () => {
      const id = await request(1_000_001);
      const { response, request: stored } = await decideInInbox(level, id);
      expect(response.status).toBe(200);
      expect(stored.status).toBe("approved");
      expect(stored.decided_by).toBe(approvers.get(level)!.id);
    });
  }
});

describe("PAY-04 Q63 default refund matrix: data migration", () => {
  it("gives the full default to a tenant with no refund rows", async () => {
    const tenant = await provisionedTenant();
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [tenant],
    );
    await inRolledBackMigration(async (client) => {
      expect(await refundPolicies(tenant, client)).toEqual(DEFAULT_ROWS);
    });
    // Rolled back: no trace for the suites that follow.
    expect(await refundPolicies(tenant)).toHaveLength(0);
  });

  it("widens a tenant that still has the old supervisor-only default", async () => {
    const tenant = await provisionedTenant();
    await setRefundRows(tenant, [{ threshold: 0, template: "supervisor" }]);
    expect(await refundPolicies(tenant)).toEqual(OLD_DEFAULT_ROWS);
    await inRolledBackMigration(async (client) => {
      expect(await refundPolicies(tenant, client)).toEqual(DEFAULT_ROWS);
    });
    expect(await refundPolicies(tenant)).toEqual(OLD_DEFAULT_ROWS);
  });

  it("never touches a tenant that configured its own matrix, and is idempotent", async () => {
    const custom = await provisionedTenant();
    const current = await provisionedTenant(); // already on the new default
    await setRefundRows(custom, [
      { threshold: 250_000, template: "outlet_manager" },
      { threshold: 1_000_000, template: "general_manager" },
    ]);
    const customBefore = await refundPolicies(custom);
    expect(customBefore).toHaveLength(2);
    await inRolledBackMigration(async (client, rerun) => {
      await rerun();
      expect(await refundPolicies(custom, client)).toEqual(customBefore);
      expect(await refundPolicies(current, client)).toEqual(DEFAULT_ROWS);
    });
    expect(await refundPolicies(custom)).toEqual(customBefore);
  });
});
