// Three-way match tolerance per tenant (card ws/purchasing-apar, design
// docs/briefs/ws-purchasing-apar-design.md §3, §9, §12 K1). Written fail-first
// from the design through HTTP: `GET/PUT /api/inventory/purchasing-policy`.
//
// Ids used in test names:
// - PP-01 default without a policy row is 0 bp; who may read
// - PP-02 PUT saves, is read back, audited
// - PP-03 range 0..1000 bp, integers only
// - PP-04 only finance/owner may change it (purchasing, nobody, anonymous)
// - PP-05 stale write is refused with 412; replay with the same key
// - PP-06 tenant isolation
//
// Assumptions: the policy body is `{ threeWayMatchToleranceBp, updatedAt }`
// (`updatedAt` null while no row exists); PUT body is `{ threeWayMatchToleranceBp,
// expectedUpdatedAt, idempotencyKey }`; PUT and GET answer 200 with
// `{ data }`; a stale `expectedUpdatedAt` answers 412 PRECONDITION_FAILED
// (pattern of the inventory settings); a reused key with another body answers
// IDEMPOTENCY_KEY_REUSED. Finance holds `accounting.supplier_payment.process`,
// purchasing holds only `purchasing.invoice.match` (PRD role table).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  addUser,
  api,
  app,
  appPool,
  asApp,
  codeOf,
  createWorld,
  key,
  owner,
  type Session,
  type World,
} from "./purchasing-apar-helpers.ts";

let A: World;
let B: World;
let finance: Session;
let purchasing: Session;
let nobody: Session;
let financeB: Session;
let buyerB: Session;

type Policy = { threeWayMatchToleranceBp: number; updatedAt: string | null };
const policyOf = (res: { body: unknown }) =>
  (res.body as { data: Policy }).data;

const put = (
  world: World,
  who: Session,
  bp: unknown,
  expectedUpdatedAt: string | null,
  idempotencyKey: string = key(),
) =>
  api.put(world, who, "/purchasing-policy", {
    threeWayMatchToleranceBp: bp,
    expectedUpdatedAt,
    idempotencyKey,
  });

async function storedBp(world: World): Promise<number | null> {
  const { rows } = await owner.query<{ bp: number }>(
    "SELECT three_way_match_tolerance_bp AS bp FROM purchasing_policies WHERE tenant_id = $1",
    [world.tenantId],
  );
  return rows[0]?.bp ?? null;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  A = await createWorld("pa");
  B = await createWorld("pb");
  finance = await addUser(A, "PP finance", [
    { role: "finance", outletId: null },
  ]);
  purchasing = await addUser(A, "PP purchasing", [
    { role: "purchasing", outletId: A.outletId },
  ]);
  nobody = await addUser(A, "PP nobody", []);
  financeB = await addUser(B, "PP finance B", [
    { role: "finance", outletId: null },
  ]);
  buyerB = await addUser(B, "PP purchasing B", [
    { role: "purchasing", outletId: B.outletId },
  ]);
});

afterAll(async () => {
  setAuditWriter(null);
  await appPool.end();
  await owner.end();
});

// Tests run in order: each block builds on the policy state of the tenant.
describe("ws-purchasing-apar PP tolerance policy", () => {
  it("PP-01 without a saved policy the tolerance is 0 bp (exact match); finance and purchasing may read it, a user without role may not", async () => {
    for (const who of [finance, purchasing]) {
      const res = await api.get(A, who, "/purchasing-policy");
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(policyOf(res)).toMatchObject({
        threeWayMatchToleranceBp: 0,
        updatedAt: null,
      });
    }
    const denied = await api.get(A, nobody, "/purchasing-policy");
    expect(denied.status).toBe(403);
    const anonymous = await agent(app)
      .get("/api/inventory/purchasing-policy")
      .set(originHeader)
      .set("Host", A.hostname);
    expect(anonymous.status).toBe(401);
    expect(await storedBp(A)).toBeNull();
  });

  it("PP-02 finance saves the tolerance; it is read back, stored and audited", async () => {
    const auditBefore = await owner.query(
      "SELECT 1 FROM audit_logs WHERE tenant_id = $1",
      [A.tenantId],
    );
    const saved = await put(A, finance, 200, null);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(policyOf(saved).threeWayMatchToleranceBp).toBe(200);
    expect(policyOf(saved).updatedAt).not.toBeNull();
    expect(await storedBp(A)).toBe(200);
    const read = await api.get(A, purchasing, "/purchasing-policy");
    expect(policyOf(read)).toEqual(policyOf(saved));
    const auditAfter = await owner.query(
      "SELECT 1 FROM audit_logs WHERE tenant_id = $1",
      [A.tenantId],
    );
    expect(auditAfter.rowCount).toBeGreaterThan(auditBefore.rowCount ?? 0);
  });

  it("PP-03 only whole numbers from 0 to 1000 bp are accepted; the saved value stays on a refusal", async () => {
    let current = policyOf(await api.get(A, finance, "/purchasing-policy"));
    expect(current.threeWayMatchToleranceBp).toBe(200);
    for (const bad of [1001, -1, 200.5, "200", null]) {
      const res = await put(A, finance, bad, current.updatedAt);
      expect(res.status, String(bad)).toBe(422);
    }
    expect(await storedBp(A)).toBe(200);
    // Boundaries are valid.
    for (const bp of [1000, 0]) {
      const res = await put(A, finance, bp, current.updatedAt);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      current = policyOf(res);
      expect(current.threeWayMatchToleranceBp).toBe(bp);
    }
    expect(await storedBp(A)).toBe(0);
  });

  it("PP-04 loosening the tolerance raises the risk of overpaying, so purchasing, a user without role and an anonymous caller are refused", async () => {
    const current = policyOf(await api.get(A, finance, "/purchasing-policy"));
    const byPurchasing = await put(A, purchasing, 500, current.updatedAt);
    expect(byPurchasing.status).toBe(403);
    const byNobody = await put(A, nobody, 500, current.updatedAt);
    expect(byNobody.status).toBe(403);
    const anonymous = await agent(app)
      .put("/api/inventory/purchasing-policy")
      .set(originHeader)
      .set("Host", A.hostname)
      .send({
        threeWayMatchToleranceBp: 500,
        expectedUpdatedAt: current.updatedAt,
        idempotencyKey: key(),
      });
    expect(anonymous.status).toBe(401);
    const noOrigin = await finance.client
      .put("/api/inventory/purchasing-policy")
      .set("Host", A.hostname)
      .send({
        threeWayMatchToleranceBp: 500,
        expectedUpdatedAt: current.updatedAt,
        idempotencyKey: key(),
      });
    expect(noOrigin.status).toBe(403);
    expect(await storedBp(A)).toBe(0);
  });

  it("PP-05 a stale write answers 412 and changes nothing; the same key replays the first answer; the same key with another value is refused", async () => {
    const current = policyOf(await api.get(A, finance, "/purchasing-policy"));
    const stale = await put(A, finance, 300, "2020-01-01T00:00:00.000Z");
    expect(stale.status).toBe(412);
    expect(codeOf(stale)).toBe("PRECONDITION_FAILED");
    const missing = await put(A, finance, 300, null); // a row exists now
    expect(missing.status).toBe(412);
    expect(await storedBp(A)).toBe(0);

    const idempotencyKey = key();
    const first = await put(A, finance, 300, current.updatedAt, idempotencyKey);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const replay = await put(
      A,
      finance,
      300,
      current.updatedAt,
      idempotencyKey,
    );
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(policyOf(replay)).toEqual(policyOf(first));
    const reused = await put(
      A,
      finance,
      400,
      current.updatedAt,
      idempotencyKey,
    );
    expect(reused.status).toBe(409);
    expect(codeOf(reused)).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await storedBp(A)).toBe(300);
  });

  it("PP-06 another tenant has its own policy: it reads the default, cannot change this tenant's value, and cannot see its row", async () => {
    // Tenant A holds 300 bp (PP-05); tenant B never saved a policy.
    const read = await api.get(B, buyerB, "/purchasing-policy");
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(policyOf(read)).toMatchObject({
      threeWayMatchToleranceBp: 0,
      updatedAt: null,
    });
    const saved = await put(B, financeB, 100, null);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await storedBp(A)).toBe(300);
    expect(await storedBp(B)).toBe(100);
    const aRead = await api.get(A, finance, "/purchasing-policy");
    expect(policyOf(aRead).threeWayMatchToleranceBp).toBe(300);

    // Positive control, then the cross-tenant read through RLS.
    const count = (tenantId: string, target: string) =>
      asApp(tenantId, async (query) => {
        const rows = (await query(
          "SELECT count(*)::int AS n FROM purchasing_policies WHERE tenant_id = $1",
          [target],
        )) as { n: number }[];
        return rows[0]!.n;
      });
    expect(await count(A.tenantId, A.tenantId)).toBe(1);
    expect(await count(B.tenantId, A.tenantId)).toBe(0);
    expect(await count(B.tenantId, B.tenantId)).toBe(1);
  });
});
