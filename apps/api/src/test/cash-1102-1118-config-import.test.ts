// legend 1118 F5(c): the tenant config import (POST /api/platform/tenants/:id/config-import,
// platform admin) must not create the shared cash account mapping that the
// mapping endpoint refuses. Written from the brief (docs/briefs/1118-fix-kas-ronde7-mapping.md,
// ADDENDUM F2) and the public bundle contract (chart_of_accounts section:
// kind "account" and kind "mapping" items), not from the importer code.
//
// Assumptions (stated so they can be contested):
// - "422 CASH_ACCOUNT_SHARED": the response status is 422 and the stable code
//   CASH_ACCOUNT_SHARED appears in the response body or in the errors recorded
//   on the config_imports row (the import path reports failures as
//   CONFIG_IMPORT_FAILED with the import id, or as an invalid-bundle 422).
// - "Nothing inserted": the tenant keeps zero chart_of_accounts and
//   account_mappings rows and no config_imports row becomes `applied`.
// - A fresh tenant with one legal entity and no chart; the bundle carries only
//   the accounts it maps. Roles it does not map may be derived by the importer,
//   so the control only checks the two roles it names.
// - Only cash roles are tested (cash_on_hand, petty_cash, bank vs another role),
//   matching the CASH_ACCOUNT_SHARED rule; non-cash sharing is not asserted.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const limits = cafeLegendPlatformFixtures.tenant.limits;
const suffix = () => randomBytes(4).toString("hex");

let admin: ReturnType<typeof agent>;
let adminUserId: string;

beforeAll(async () => {
  admin = agent(app);
  const email = await signUp(admin, "Platform Admin 1118 import");
  await setRole(email, "admin");
  const session = await admin.get("/api/auth/get-session");
  adminUserId = session.body.user.id as string;
  await owner.query(
    "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [adminUserId],
  );
  await verifySessionMfa(email);
});

afterAll(async () => {
  await owner.query("DELETE FROM platform_admins WHERE user_id = $1", [
    adminUserId,
  ]);
  await owner.end();
});

/** A new tenant with one legal entity (the import fills its chart). */
async function newTarget(): Promise<string> {
  const created = await admin
    .post("/api/platform/tenants")
    .set(originHeader)
    .send({
      slug: `c1118-${suffix()}`,
      name: "Uji 1118 impor",
      plan: "lengkap",
      deploymentMode: "shared",
      featureFlags: { modules: ["pos"], integrationProviders: [] },
      limits,
      firstAdmin: {
        name: "Admin Pertama",
        whatsapp: "6281234567890",
        email: null,
      },
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const tenantId = created.body.data.id as string;
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [randomUUID(), tenantId, `PT Uji 1118 ${suffix()}`],
  );
  return tenantId;
}

const account = (code: string) => ({
  key: `acct.${code}`,
  kind: "account",
  code,
  name: `Akun ${code}`,
  type: "asset",
  reportGroup: "cash_and_equivalents",
  parentKey: null,
  isActive: true,
});
const mapping = (role: string, code: string) => ({
  key: `map.${role}`,
  kind: "mapping",
  role,
  accountKey: `acct.${code}`,
});
const bundleOf = (items: unknown[]) => ({
  formatVersion: 1,
  exportedAt: new Date().toISOString(),
  sections: { chart_of_accounts: { version: 1, items } },
});

const postImport = (tenantId: string, bundle: unknown) =>
  admin
    .post(`/api/platform/tenants/${tenantId}/config-import`)
    .set(originHeader)
    .send({ bundle });

async function chartRows(tenantId: string) {
  const accounts = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM chart_of_accounts WHERE tenant_id = $1",
    [tenantId],
  );
  const mappings = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM account_mappings WHERE tenant_id = $1",
    [tenantId],
  );
  return {
    accounts: Number(accounts.rows[0]!.n),
    mappings: Number(mappings.rows[0]!.n),
  };
}

async function importRows(tenantId: string) {
  return (
    await owner.query<{ status: string; errors: string[] | null }>(
      "SELECT status, errors FROM config_imports WHERE tenant_id = $1",
      [tenantId],
    )
  ).rows;
}

describe("1118 config import refuses one account on a cash role and another role", () => {
  it.each([
    ["petty_cash", "employee_receivable"],
    ["cash_on_hand", "bank"],
    ["bank", "employee_receivable"],
  ])(
    "[1118-import-shared-%s-%s] a chart_of_accounts bundle mapping both roles to one account is refused 422 naming CASH_ACCOUNT_SHARED; no account, no mapping, no applied import",
    async (first, second) => {
      const tenantId = await newTarget();
      const before = await chartRows(tenantId);

      const res = await postImport(
        tenantId,
        bundleOf([
          account("1102"),
          mapping(first, "1102"),
          mapping(second, "1102"),
        ]),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      const recorded = (await importRows(tenantId))
        .flatMap((row) => row.errors ?? [])
        .join(" ");
      expect(
        `${JSON.stringify(res.body)} ${recorded}`,
        "the refusal names the stable code",
      ).toContain("CASH_ACCOUNT_SHARED");
      expect(await chartRows(tenantId)).toEqual(before);
      expect(
        (await importRows(tenantId)).filter((row) => row.status === "applied"),
      ).toEqual([]);
    },
  );

  it("[1118-import-distinct-ok] control: the same roles on two different accounts import (applied) and the mappings point at their own accounts", async () => {
    const tenantId = await newTarget();

    const res = await postImport(
      tenantId,
      bundleOf([
        account("1102"),
        account("1204"),
        mapping("petty_cash", "1102"),
        mapping("employee_receivable", "1204"),
      ]),
    );

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    const { rows } = await owner.query<{ role: string; code: string }>(
      `SELECT m.role, a.code FROM account_mappings m
         JOIN chart_of_accounts a ON a.tenant_id = m.tenant_id AND a.id = m.account_id
        WHERE m.tenant_id = $1 AND m.role IN ('petty_cash', 'employee_receivable')`,
      [tenantId],
    );
    expect(Object.fromEntries(rows.map((row) => [row.role, row.code]))).toEqual(
      { petty_cash: "1102", employee_receivable: "1204" },
    );
    expect(
      (await importRows(tenantId)).filter((row) => row.status === "applied"),
    ).toHaveLength(1);
  });
});
