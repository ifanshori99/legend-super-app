// Owner override route (bead legend-10nex, founder Q57): only the OWNER may
// allow sales after 24 hours without a catalog sync, on the edge API.
// Written from the design contract, not from the implementation:
//   POST /api/edge/catalog-override  body { minutes, reason }
//   GET  /api/edge/catalog-override  current override
// requireAuth + requireTrustedOrigin + jsonBody, OWNER only; the grant leaves
// an audit row `edge.catalog_override.grant` and a row in
// `edge_catalog_sale_overrides` (granted_by, granted_at, until_at, reason).
//
// Assumptions (the contract is silent):
//  - The app is `createApp({ edgeMode: true })` (the route answers 404
//    EDGE_ONLY_ROUTE on a cloud app); accounts are signed up on a cloud app and
//    signed in on the edge app, as edge-print-api.test.ts does. The tenant comes
//    from the seeded host name header.
//  - Success answers 200 or 201; a refused body answers 400 or 422; a role
//    other than OWNER (outlet manager, supervisor, cashier) answers 403;
//    no session answers 401.
//  - The response is `{ data: {...} | null }`.
//  - Second factor (F2, same rule as pos-receipt-writeoff): no verification is
//    403 MFA_REQUIRED, one older than 5 minutes 401 REAUTH_REQUIRED; nothing is
//    written in both cases. Error code is read from `error.code` or `code`.
//  - F1: before the trusted clock is installed (setCatalogOverrideClock(null))
//    a grant answers 503 EDGE_CLOCK_NOT_READY and writes nothing.
//  - The process is made the edge node of a cloned outlet through
//    setEdgeRuntimeStateForTests (as device-edge.test.ts does).
//  - Rows are told apart by `granted_by` (the test user), so no edge node id
//    has to be known here.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import { setCatalogOverrideClock } from "../edge/catalog-override.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import {
  cloudSignIn,
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers.ts";
import {
  owner as pool,
  seededHostname,
  seededOutletA,
  seededTenantId,
} from "./floor-test-helpers.ts";

const app = createApp({ edgeMode: true });
const headers = { Host: seededHostname };
const PATH = "/api/edge/catalog-override";
const REASON = "Internet toko mati sejak pagi";

type Staff = { client: ReturnType<typeof agent>; userId: string };

/**
 * Sign-up and password sign-in are cloud only (edgeRouteGuard). Same
 * pattern as edge-print-api.test.ts. One seeded role template, tenant scope.
 */
async function staffWithRole(
  _app: unknown,
  input: {
    template: "owner" | "outlet_manager" | "supervisor" | "cashier";
    label: string;
    /** Mark the session's second factor as verified (default true). */
    mfa?: boolean;
    /** SQL for valid_until (default NULL: open-ended). */
    validUntilSql?: string;
  },
): Promise<Staff> {
  const email = await signUp(agent(createApp()), input.label);
  await setRole(email, null);
  const client = agent(app);
  client.set("Cookie", await cloudSignIn(email));
  if (input.mfa !== false) await verifySessionMfa(email);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [seededTenantId, input.template],
  );
  if (!rows[0]) throw new Error(`No role template ${input.template}`);
  await pool.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', ${input.validUntilSql ?? "NULL"}, $2)`,
    [seededTenantId, userId, rows[0].id],
  );
  return { client, userId };
}

const cloudState = getEdgeRuntimeState();
let ownerStaff: Staff;
const others: Record<string, Staff> = {};

const post = (who: Staff, body: unknown) =>
  who.client
    .post(PATH)
    .set(headers)
    .set(originHeader)
    .send(body as object);

type OverrideRow = {
  granted_by: string;
  granted_at: Date;
  until_at: Date;
  reason: string;
  superseded_at: Date | null;
};

async function rowsOf(userId: string): Promise<OverrideRow[]> {
  const { rows } = await pool.query<OverrideRow>(
    `SELECT granted_by, granted_at, until_at, reason, superseded_at
       FROM edge_catalog_sale_overrides WHERE granted_by = $1 ORDER BY granted_at, id`,
    [userId],
  );
  return rows;
}

async function auditCount(userId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = 'edge.catalog_override.grant'
        AND event->>'actorId' = $2`,
    [seededTenantId, userId],
  );
  return rowCount ?? 0;
}

const body = (res: { body: { data?: unknown } }) =>
  (res.body.data ?? res.body) as Record<string, unknown>;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // This process becomes the edge node of its own cloned outlet (one active
  // node per role per outlet, so the shared fixture outlets are left alone).
  const outletId = randomUUID();
  await pool.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet uji override rute', address, timezone, opening_hours, status
       FROM outlets WHERE id = $3`,
    [outletId, `OR${outletId.slice(0, 8)}`.toUpperCase(), seededOutletA],
  );
  const edgeContext = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "device",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );
  const registered = await registerEdgeNode(
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(seededTenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
    ),
    randomUUID() as never,
    { outletId, role: "standby", label: "Mini PC uji override rute" } as never,
  );
  // The runtime installs the trusted clock at boot; a grant is refused before.
  setCatalogOverrideClock(() => new Date());
  setEdgeRuntimeStateForTests({
    edgeMode: true,
    identity: {
      context: edgeContext,
      scope: {
        tenantId: seededTenantId,
        outletId,
        edgeNodeId: registered.edgeNode.id as string,
      },
    },
    link: { cloudLink: "disconnected", refused: false, lastConnectedAt: null },
  });
  ownerStaff = await staffWithRole(app, {
    template: "owner",
    label: "Owner Override",
  });
  for (const template of ["outlet_manager", "supervisor", "cashier"] as const)
    others[template] = await staffWithRole(app, {
      template,
      label: `Override ${template}`,
    });
});

afterAll(async () => {
  setCatalogOverrideClock(null);
  setEdgeRuntimeStateForTests(cloudState);
  const ids = [ownerStaff, ...Object.values(others)].map((s) => s.userId);
  await pool.query(
    "DELETE FROM edge_catalog_sale_overrides WHERE granted_by = ANY($1::text[])",
    [ids],
  );
  await pool.end();
});

describe("legend-10nex only the owner may allow sales on a stale catalog", () => {
  it("lets the owner grant 240 minutes: who, when, until and why are recorded", async () => {
    const before = Date.now();
    const res = await post(ownerStaff, { minutes: 240, reason: REASON });
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    const after = Date.now();

    const stored = await rowsOf(ownerStaff.userId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.reason).toBe(REASON);
    const grantedAt = stored[0]!.granted_at.getTime();
    expect(grantedAt).toBeGreaterThanOrEqual(before - 5_000);
    expect(grantedAt).toBeLessThanOrEqual(after + 5_000);
    expect(stored[0]!.until_at.getTime() - grantedAt).toBe(240 * 60_000);
    expect(stored[0]!.superseded_at).toBeNull();

    // The owner can read the current override back.
    const current = await ownerStaff.client
      .get(PATH)
      .set(headers)
      .set(originHeader);
    expect(current.status).toBe(200);
    expect(JSON.stringify(current.body)).toContain(REASON);
  });

  it("writes an audit row naming the owner", async () => {
    expect(await auditCount(ownerStaff.userId)).toBeGreaterThanOrEqual(1);
  });

  it.each(["outlet_manager", "supervisor", "cashier"])(
    "refuses a %s with 403 and writes nothing",
    async (template) => {
      const who = others[template]!;
      const res = await post(who, { minutes: 60, reason: REASON });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(await rowsOf(who.userId)).toHaveLength(0);
      expect(await auditCount(who.userId)).toBe(0);
    },
  );

  it("refuses a request without a session with 401", async () => {
    const res = await agent(app)
      .post(PATH)
      .set(headers)
      .set(originHeader)
      .send({ minutes: 60, reason: REASON });
    expect(res.status).toBe(401);
  });

  it("refuses an untrusted origin", async () => {
    const res = await ownerStaff.client
      .post(PATH)
      .set(headers)
      .set({ Origin: "https://evil.example" })
      .send({ minutes: 60, reason: REASON });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await rowsOf(ownerStaff.userId)).toHaveLength(1); // only the first test's grant
  });
});

describe("legend-10nex override duration is 1 to 1440 minutes", () => {
  it.each([0, -1, 1441, 100_000, 1.5, "240", null])(
    "refuses minutes = %j",
    async (minutes) => {
      const count = (await rowsOf(ownerStaff.userId)).length;
      const res = await post(ownerStaff, { minutes, reason: REASON });
      expect([400, 422], JSON.stringify(res.body)).toContain(res.status);
      expect(await rowsOf(ownerStaff.userId)).toHaveLength(count);
    },
  );

  it("refuses a body without minutes", async () => {
    const res = await post(ownerStaff, { reason: REASON });
    expect([400, 422]).toContain(res.status);
  });

  it.each([1, 1440])(
    "accepts %i minutes and ends exactly then",
    async (minutes) => {
      const res = await post(ownerStaff, { minutes, reason: REASON });
      expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
      const stored = await rowsOf(ownerStaff.userId);
      const last = stored[stored.length - 1]!;
      expect(last.until_at.getTime() - last.granted_at.getTime()).toBe(
        minutes * 60_000,
      );
    },
  );
});

describe("legend-10nex override needs a written reason", () => {
  it.each([undefined, "", "   ", "ab"])(
    "refuses reason = %j",
    async (reason) => {
      const count = (await rowsOf(ownerStaff.userId)).length;
      const res = await post(ownerStaff, { minutes: 60, reason });
      expect([400, 422], JSON.stringify(res.body)).toContain(res.status);
      expect(await rowsOf(ownerStaff.userId)).toHaveLength(count);
    },
  );

  it("refuses unknown fields", async () => {
    const res = await post(ownerStaff, {
      minutes: 60,
      reason: REASON,
      untilAt: "2099-01-01T00:00:00.000Z",
    });
    expect([400, 422]).toContain(res.status);
  });
});

describe("legend-10nex a second grant replaces the first", () => {
  it("keeps the old row marked superseded and only the newest is active", async () => {
    const first = await post(ownerStaff, { minutes: 30, reason: "Pertama" });
    expect([200, 201]).toContain(first.status);
    const second = await post(ownerStaff, { minutes: 90, reason: "Kedua" });
    expect([200, 201]).toContain(second.status);

    const stored = await rowsOf(ownerStaff.userId);
    const active = stored.filter((row) => row.superseded_at === null);
    expect(active).toHaveLength(1);
    expect(active[0]!.reason).toBe("Kedua");
    const old = stored.find((row) => row.reason === "Pertama");
    expect(old?.superseded_at).not.toBeNull();

    const current = await ownerStaff.client
      .get(PATH)
      .set(headers)
      .set(originHeader);
    expect(current.status).toBe(200);
    expect(JSON.stringify(current.body)).toContain("Kedua");
    expect(JSON.stringify(current.body)).not.toContain("Pertama");
    expect(body(current)).toBeTruthy();
  });
});

const errorCode = (body: { error?: { code?: string }; code?: string }) =>
  body.error?.code ?? body.code;

describe("legend-10nex granting needs a recent second factor", () => {
  it("an owner without a verified second factor is refused (403 MFA_REQUIRED) and nothing is written", async () => {
    const noMfa = await staffWithRole(app, {
      template: "owner",
      label: "Owner Tanpa MFA",
      mfa: false,
    });
    const res = await post(noMfa, { minutes: 60, reason: REASON });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(errorCode(res.body)).toBe("MFA_REQUIRED");
    expect(await rowsOf(noMfa.userId)).toHaveLength(0);
    expect(await auditCount(noMfa.userId)).toBe(0);
    await pool.query(
      "DELETE FROM edge_catalog_sale_overrides WHERE granted_by = $1",
      [noMfa.userId],
    );
  });

  it("a second factor verified 10 minutes ago is refused (401 REAUTH_REQUIRED); verifying again lets the same call through", async () => {
    const stale = await staffWithRole(app, {
      template: "owner",
      label: "Owner MFA Basi",
    });
    await pool.query(
      `UPDATE "session" SET mfa_verified_at = $2 WHERE revoked_at IS NULL AND user_id = $1`,
      [stale.userId, new Date(Date.now() - 10 * 60_000)],
    );
    const refused = await post(stale, { minutes: 60, reason: REASON });
    expect(refused.status, JSON.stringify(refused.body)).toBe(401);
    expect(errorCode(refused.body)).toBe("REAUTH_REQUIRED");
    expect(await rowsOf(stale.userId)).toHaveLength(0);

    await pool.query(
      `UPDATE "session" SET mfa_verified_at = $2 WHERE revoked_at IS NULL AND user_id = $1`,
      [stale.userId, new Date()],
    );
    const ok = await post(stale, { minutes: 60, reason: REASON });
    expect([200, 201], JSON.stringify(ok.body)).toContain(ok.status);
    expect(await rowsOf(stale.userId)).toHaveLength(1);
    await pool.query(
      "DELETE FROM edge_catalog_sale_overrides WHERE granted_by = $1",
      [stale.userId],
    );
  });
});

describe("legend-10nex granting waits for the trusted clock", () => {
  it("answers 503 EDGE_CLOCK_NOT_READY before the clock is installed and writes nothing", async () => {
    const before = (await rowsOf(ownerStaff.userId)).length;
    setCatalogOverrideClock(null);
    try {
      const res = await post(ownerStaff, { minutes: 60, reason: REASON });
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(errorCode(res.body)).toBe("EDGE_CLOCK_NOT_READY");
      expect(await rowsOf(ownerStaff.userId)).toHaveLength(before);
    } finally {
      setCatalogOverrideClock(() => new Date());
    }
    const again = await post(ownerStaff, { minutes: 60, reason: REASON });
    expect([200, 201], JSON.stringify(again.body)).toContain(again.status);
  });
});

describe("521 override authentication uses the trusted edge clock", () => {
  it("refuses wall-clock-fresh MFA after trusted time advanced 48 hours and writes nothing", async () => {
    const staff = await staffWithRole(app, {
      template: "owner",
      label: "Owner Trusted MFA Basi",
    });
    const trustedNow = new Date(Date.now() + 48 * 60 * 60_000);
    setCatalogOverrideClock(() => trustedNow);
    try {
      const res = await post(staff, { minutes: 240, reason: REASON });
      expect(res.status, JSON.stringify(res.body)).toBe(401);
      expect(errorCode(res.body)).toBe("REAUTH_REQUIRED");
      expect(await rowsOf(staff.userId)).toHaveLength(0);
      expect(await auditCount(staff.userId)).toBe(0);
    } finally {
      setCatalogOverrideClock(() => new Date());
      await pool.query(
        "DELETE FROM edge_catalog_sale_overrides WHERE granted_by = $1",
        [staff.userId],
      );
    }
  });

  it("accepts MFA fresh on trusted time after the wall clock was restored", async () => {
    const staff = await staffWithRole(app, {
      template: "owner",
      label: "Owner Trusted MFA Segar",
    });
    const trustedNow = new Date(Date.now() + 48 * 60 * 60_000);
    await pool.query(
      `UPDATE "session" SET mfa_verified_at = $2
       WHERE revoked_at IS NULL AND user_id = $1`,
      [staff.userId, new Date(trustedNow.getTime() - 60_000)],
    );
    setCatalogOverrideClock(() => trustedNow);
    try {
      const res = await post(staff, { minutes: 240, reason: REASON });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const stored = await rowsOf(staff.userId);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.granted_at).toEqual(trustedNow);
      expect(stored[0]!.until_at.getTime()).toBe(
        trustedNow.getTime() + 240 * 60_000,
      );
    } finally {
      setCatalogOverrideClock(() => new Date());
      await pool.query(
        "DELETE FROM edge_catalog_sale_overrides WHERE granted_by = $1",
        [staff.userId],
      );
    }
  });

  it("refuses a session expired on trusted time even when MFA is fresh on both clocks", async () => {
    const staff = await staffWithRole(app, {
      template: "owner",
      label: "Owner Trusted Sesi Kedaluwarsa",
    });
    const wallNow = Date.now();
    const trustedNow = new Date(wallNow + 2 * 60_000);
    await pool.query(
      `UPDATE "session" SET mfa_verified_at = $2, expires_at = $3
       WHERE revoked_at IS NULL AND user_id = $1`,
      [staff.userId, new Date(wallNow), new Date(wallNow + 60_000)],
    );
    setCatalogOverrideClock(() => trustedNow);
    try {
      const res = await post(staff, { minutes: 240, reason: REASON });
      expect(res.status, JSON.stringify(res.body)).toBe(401);
      expect(errorCode(res.body)).toBe("REAUTH_REQUIRED");
      expect(await rowsOf(staff.userId)).toHaveLength(0);
      expect(await auditCount(staff.userId)).toBe(0);
    } finally {
      setCatalogOverrideClock(() => new Date());
      await pool.query(
        "DELETE FROM edge_catalog_sale_overrides WHERE granted_by = $1",
        [staff.userId],
      );
    }
  });
});

// legend-7zwmv (P3-1 of the 1201 second opinion): on the edge the Owner gate
// judges an assignment's validity by the trusted monotonic clock, not by the
// edge box's wall clock (statement_timestamp()), and fails closed without it.
describe("legend-7zwmv the Owner gate uses the trusted edge clock", () => {
  it("refuses an Owner whose valid_until the trusted clock passed although the local DB clock has not", async () => {
    const temporary = await staffWithRole(app, {
      template: "owner",
      label: "Owner Sementara Jam Edge",
      validUntilSql: "now() + interval '1 hour'",
    });
    // Control: the DB clock and the trusted clock agree, so the Owner is valid.
    const before = await temporary.client
      .get(PATH)
      .set(headers)
      .set(originHeader);
    expect(before.status, JSON.stringify(before.body)).toBe(200);

    // The trusted clock is 2 hours on: valid_until (1 h ahead of the DB clock)
    // is over for the edge. The local DB clock still says "valid".
    setCatalogOverrideClock(() => new Date(Date.now() + 2 * 3_600_000));
    try {
      const read = await temporary.client
        .get(PATH)
        .set(headers)
        .set(originHeader);
      expect(read.status, JSON.stringify(read.body)).toBe(403);
      const rowsBefore = (await rowsOf(temporary.userId)).length;
      const grant = await post(temporary, { minutes: 60, reason: REASON });
      expect(grant.status, JSON.stringify(grant.body)).toBe(403);
      expect(await rowsOf(temporary.userId)).toHaveLength(rowsBefore);
    } finally {
      setCatalogOverrideClock(() => new Date());
    }
    await pool.query("DELETE FROM role_assignments WHERE user_id = $1", [
      temporary.userId,
    ]);
  });

  it("still allows an Owner row the DB already treats as expired while the trusted clock is earlier", async () => {
    const staff = await staffWithRole(app, {
      template: "owner",
      label: "Owner Kedaluwarsa DB Jam Edge",
      validUntilSql: "now() + interval '1 hour'",
    });
    // The DB clock now judges this row expired (valid_until 1 h ago), yet the
    // row must still be loaded: the trusted clock (3 h back) lies inside it.
    await pool.query(
      `UPDATE role_assignments
          SET valid_from = now() - interval '5 hours',
              valid_until = now() - interval '1 hour'
        WHERE user_id = $1`,
      [staff.userId],
    );
    try {
      const dbJudged = await pool.query(
        `SELECT 1 FROM role_assignments
          WHERE user_id = $1 AND valid_until < statement_timestamp()`,
        [staff.userId],
      );
      expect(dbJudged.rowCount).toBe(1);
      setCatalogOverrideClock(() => new Date(Date.now() - 3 * 3_600_000));
      const read = await staff.client.get(PATH).set(headers).set(originHeader);
      expect(read.status, JSON.stringify(read.body)).toBe(200);
    } finally {
      setCatalogOverrideClock(() => new Date());
      await pool.query("DELETE FROM role_assignments WHERE user_id = $1", [
        staff.userId,
      ]);
    }
  });

  it("answers the session status read from the DB clock while the trusted clock is not ready", async () => {
    setCatalogOverrideClock(null);
    try {
      const res = await ownerStaff.client
        .get("/api/edge/status")
        .set(headers)
        .set(originHeader);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    } finally {
      setCatalogOverrideClock(() => new Date());
    }
  });

  it("refuses a grant with 503 EDGE_CLOCK_NOT_READY and writes no row while the trusted clock is not ready", async () => {
    const rowsBefore = (await rowsOf(ownerStaff.userId)).length;
    const auditBefore = await auditCount(ownerStaff.userId);
    setCatalogOverrideClock(null);
    try {
      const res = await post(ownerStaff, { minutes: 60, reason: REASON });
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(errorCode(res.body)).toBe("EDGE_CLOCK_NOT_READY");
      expect(await rowsOf(ownerStaff.userId)).toHaveLength(rowsBefore);
      expect(await auditCount(ownerStaff.userId)).toBe(auditBefore);
    } finally {
      setCatalogOverrideClock(() => new Date());
    }
  });

  it("fails closed for even a valid Owner while the trusted clock is not ready", async () => {
    setCatalogOverrideClock(null);
    try {
      const read = await ownerStaff.client
        .get(PATH)
        .set(headers)
        .set(originHeader);
      expect(read.status, JSON.stringify(read.body)).toBe(503);
      expect(errorCode(read.body)).toBe("EDGE_CLOCK_NOT_READY");
    } finally {
      setCatalogOverrideClock(() => new Date());
    }
  });
});
