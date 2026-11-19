// legend 1147 (second opinion kas ronde 10, P1-1): a cash role (cash_on_hand,
// petty_cash, bank) may not be mapped onto an account that already has journal
// lines. Otherwise the owner can move the bank role B -> D and petty cash A -> B
// in one PUT; the reversal of an old bank-paid journal (Dr B / Cr other) then
// raises the ledger balance of B, which is now petty cash, and a cash kasbon is
// paid with money that does not exist. Rule asserted (CTO decision 1 of
// brief-1147): both the mapping endpoint (PUT account-mappings) and the config
// import refuse a CHANGE of a cash role onto such an account with 409
// CASH_MAPPING_ACCOUNT_HAS_HISTORY (the import reports it as its 422 refusal);
// an unchanged mapping (re-PUT) and non-cash roles still pass; a refusal writes
// nothing. Nobody is paid from money that was never received.
//
// Harness: same shape as tenant-config-import-mapping-lock.test.ts (platform
// admin with MFA, verified tenant domain + Host header, finance user with MFA),
// plus journals written straight into journal_lines through the owner pool.
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
  max: 4,
});
const limits = cafeLegendPlatformFixtures.tenant.limits;
const suffix = () => randomBytes(4).toString("hex");
const CODE = "CASH_MAPPING_ACCOUNT_HAS_HISTORY";

let admin: ReturnType<typeof agent>;
let adminUserId: string;

beforeAll(async () => {
  admin = agent(app);
  const email = await signUp(admin, "Platform Admin 1147");
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

// Account codes of the world. P, K, O carry the base cash mapping, E the base
// employee_receivable. H1..H3 are fresh asset accounts that get journal lines;
// N is a clean asset account.
const CODES = {
  P: "1101",
  K: "1102",
  O: "1103",
  E: "1204",
  H1: "1111",
  H2: "1112",
  H3: "1113",
  N: "1121",
  REV: "4101",
} as const;
type Key = keyof typeof CODES;

type World = {
  tenantId: string;
  entityId: string;
  ids: Record<Key, string>;
  finance: ReturnType<typeof agent>;
  host: string;
};

async function newWorld(): Promise<World> {
  const created = await admin
    .post("/api/platform/tenants")
    .set(originHeader)
    .send({
      slug: `m1147-${suffix()}`,
      name: "Uji 1147 riwayat mapping kas",
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

  const brandId = randomUUID();
  const host = `m1147-${suffix()}.contoh.example`;
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    [brandId, tenantId, `brand-${suffix()}`, "Brand Uji 1147"],
  );
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'custom', 'active', now())`,
    [randomUUID(), tenantId, brandId, host],
  );
  const entityId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entityId, tenantId, `PT Uji 1147 ${suffix()}`],
  );
  const ids = {} as Record<Key, string>;
  for (const key of Object.keys(CODES) as Key[]) {
    ids[key] = randomUUID();
    const code = CODES[key];
    const [type, group] =
      key === "REV"
        ? ["revenue", "revenue"]
        : key === "E"
          ? ["asset", "current_asset"]
          : ["asset", "cash_and_equivalents"];
    await owner.query(
      `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ids[key], tenantId, entityId, code, `Akun ${code}`, type, group],
    );
  }
  await owner.query(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, '2026-11')`,
    [tenantId, entityId],
  );

  const finance = agent(app);
  const email = await signUp(finance, "Finance 1147");
  const userId = (await finance.get("/api/auth/get-session")).body.user
    .id as string;
  const role = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'finance'",
    [tenantId],
  );
  expect(role.rows, "premise: the new tenant has a finance role").toHaveLength(
    1,
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [tenantId, userId, role.rows[0]!.id],
  );
  await verifySessionMfa(email);
  return { tenantId, entityId, ids, finance, host };
}

type Mapping = { role: string; accountId: string };

function put(world: World, mappings: Mapping[]) {
  return world.finance
    .put(`/api/accounting/legal-entities/${world.entityId}/account-mappings`)
    .set(originHeader)
    .set("Host", world.host)
    .send({ mappings });
}

/** Base mapping, written while no account has lines yet: P, K, O are cash, E a receivable. */
function baseMappings(world: World): Mapping[] {
  return [
    { role: "petty_cash", accountId: world.ids.P },
    { role: "bank", accountId: world.ids.K },
    { role: "cash_on_hand", accountId: world.ids.O },
    { role: "employee_receivable", accountId: world.ids.E },
  ];
}

async function newWorldWithBase(): Promise<World> {
  const world = await newWorld();
  const res = await put(world, baseMappings(world));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return world;
}

/** One balanced posted journal that debits `key` and credits the revenue account. */
async function postLinesOn(world: World, key: Key): Promise<void> {
  const period = (
    await owner.query<{ id: string }>(
      "SELECT id FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2",
      [world.tenantId, world.entityId],
    )
  ).rows[0]!.id;
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
          source_id, description, idempotency_key, request_fingerprint)
       VALUES ($1, $2, '2026-11-04', $3, 'sale', NULL, 'Jurnal 1147', $4, $5)
       RETURNING id`,
      [
        world.tenantId,
        world.entityId,
        period,
        `h1147-${randomUUID()}`,
        randomBytes(32).toString("hex"),
      ],
    );
    await client.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, 1, 100000, 0), ($1, $2, $4, 2, 0, 100000)`,
      [world.tenantId, rows[0]!.id, world.ids[key], world.ids.REV],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function mappingsOf(world: World): Promise<Record<string, string>> {
  const { rows } = await owner.query<{ role: string; code: string }>(
    `SELECT m.role::text AS role, a.code
       FROM account_mappings m
       JOIN chart_of_accounts a ON a.tenant_id = m.tenant_id AND a.id = m.account_id
      WHERE m.tenant_id = $1 AND m.legal_entity_id = $2
      ORDER BY m.role::text`,
    [world.tenantId, world.entityId],
  );
  return Object.fromEntries(rows.map((row) => [row.role, row.code]));
}

const baseCodes = {
  petty_cash: CODES.P,
  bank: CODES.K,
  cash_on_hand: CODES.O,
  employee_receivable: CODES.E,
};

describe("1147 mapping endpoint: a cash role cannot move onto an account with journal lines", () => {
  it.each([["petty_cash"], ["bank"], ["cash_on_hand"]])(
    "[1147-put-refused-%s] moving the role onto an account with posted lines is 409 and the mappings stay as they were",
    async (role) => {
      const world = await newWorldWithBase();
      await postLinesOn(world, "H1");

      const moved = baseMappings(world).map((m) =>
        m.role === role ? { role, accountId: world.ids.H1 } : m,
      );
      const res = await put(world, moved);

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error.code).toBe(CODE);
      expect(res.body.error.message).toContain(role);
      expect(res.body.error.message).toContain(CODES.H1);
      expect(await mappingsOf(world), "nothing was written").toEqual(baseCodes);
    },
  );

  it("[1147-put-swap] the 1147 attack: bank B -> D and petty cash A -> B in one PUT is refused (B has lines) and nothing changes", async () => {
    const world = await newWorldWithBase();
    // K (bank) paid a salary: it holds lines. D is the clean N.
    await postLinesOn(world, "K");

    const res = await put(world, [
      { role: "petty_cash", accountId: world.ids.K },
      { role: "bank", accountId: world.ids.N },
      { role: "cash_on_hand", accountId: world.ids.O },
      { role: "employee_receivable", accountId: world.ids.E },
    ]);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe(CODE);
    expect(await mappingsOf(world)).toEqual(baseCodes);
  });

  it("[1147-put-clean] a cash role moved onto an account without lines is 200 and stored", async () => {
    const world = await newWorldWithBase();
    // History elsewhere does not matter: the target N has no lines.
    await postLinesOn(world, "H1");

    const res = await put(
      world,
      baseMappings(world).map((m) =>
        m.role === "petty_cash" ? { ...m, accountId: world.ids.N } : m,
      ),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await mappingsOf(world)).toEqual({
      ...baseCodes,
      petty_cash: CODES.N,
    });
  });

  it("[1147-put-unchanged] re-PUT of the identical mapping passes even when every cash account has lines", async () => {
    const world = await newWorldWithBase();
    await postLinesOn(world, "P");
    await postLinesOn(world, "K");
    await postLinesOn(world, "O");

    const res = await put(world, baseMappings(world));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await mappingsOf(world)).toEqual(baseCodes);
  });

  it("[1147-put-unchanged-plus-other-change] an unchanged cash role with lines passes while a clean cash role moves", async () => {
    const world = await newWorldWithBase();
    await postLinesOn(world, "P");

    const res = await put(
      world,
      baseMappings(world).map((m) =>
        m.role === "bank" ? { ...m, accountId: world.ids.N } : m,
      ),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await mappingsOf(world)).toEqual({ ...baseCodes, bank: CODES.N });
  });

  it("[1147-put-new-role] a cash role that has no mapping yet counts as a change: mapping it onto an account with lines is refused", async () => {
    const world = await newWorld();
    await postLinesOn(world, "H1");

    const res = await put(world, [
      { role: "petty_cash", accountId: world.ids.H1 },
    ]);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe(CODE);
    expect(await mappingsOf(world)).toEqual({});
  });

  it("[1147-put-non-cash] a non-cash role moved onto an account with lines is 200 (the rule is for cash roles only)", async () => {
    const world = await newWorldWithBase();
    await postLinesOn(world, "H1");

    const res = await put(
      world,
      baseMappings(world).map((m) =>
        m.role === "employee_receivable"
          ? { ...m, accountId: world.ids.H1 }
          : m,
      ),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await mappingsOf(world)).toEqual({
      ...baseCodes,
      employee_receivable: CODES.H1,
    });
  });
});

// ---- config import ---------------------------------------------------------------

const importAccount = (code: string, reportGroup = "cash_and_equivalents") => ({
  key: `acct.${code}`,
  kind: "account",
  code,
  name: `Akun ${code}`,
  type: "asset",
  reportGroup,
  parentKey: null,
  isActive: true,
});
const importMapping = (role: string, code: string) => ({
  key: `map.${role}`,
  kind: "mapping",
  role,
  accountKey: `acct.${code}`,
});

function postImport(world: World, items: unknown[]) {
  return admin
    .post(`/api/platform/tenants/${world.tenantId}/config-import`)
    .set(originHeader)
    .send({
      bundle: {
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        sections: { chart_of_accounts: { version: 1, items } },
      },
    });
}

async function importErrors(world: World): Promise<string> {
  const { rows } = await owner.query<{ errors: unknown }>(
    "SELECT errors FROM config_imports WHERE tenant_id = $1",
    [world.tenantId],
  );
  return JSON.stringify(rows.map((row) => row.errors));
}

async function appliedImports(world: World): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM config_imports WHERE tenant_id = $1 AND status = 'applied'",
    [world.tenantId],
  );
  return Number(rows[0]!.n);
}

async function accountCount(world: World): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM chart_of_accounts WHERE tenant_id = $1",
    [world.tenantId],
  );
  return Number(rows[0]!.n);
}

describe("1147 config import: the same refusal, with no partial write", () => {
  it.each([["petty_cash"], ["bank"], ["cash_on_hand"]])(
    "[1147-import-refused-%s] a bundle mapping the role onto an account with lines is refused naming the code; no account, no mapping, no applied import",
    async (role) => {
      const world = await newWorld();
      await postLinesOn(world, "H1");
      const accountsBefore = await accountCount(world);

      const res = await postImport(world, [
        importAccount(CODES.H1),
        // a clean mapping and a brand-new account ride along: they must not survive
        importAccount("1999"),
        importMapping("bank" === role ? "cash_on_hand" : "bank", "1999"),
        importMapping(role, CODES.H1),
      ]);

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(
        `${JSON.stringify(res.body)} ${await importErrors(world)}`,
        "the refusal names the stable code",
      ).toContain(CODE);
      expect(await mappingsOf(world), "no mapping written").toEqual({});
      expect(await accountCount(world), "no account created").toBe(
        accountsBefore,
      );
      expect(await appliedImports(world)).toBe(0);
    },
  );

  it("[1147-import-clean] control: a cash role mapped onto an account without lines imports and is stored", async () => {
    const world = await newWorld();
    await postLinesOn(world, "H1");

    const res = await postImport(world, [
      importAccount(CODES.N),
      importMapping("petty_cash", CODES.N),
    ]);

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(await mappingsOf(world)).toEqual({ petty_cash: CODES.N });
    expect(await appliedImports(world)).toBe(1);
  });

  it("[1147-import-non-cash] a non-cash role mapped onto an account with lines imports (200/201)", async () => {
    const world = await newWorld();
    await postLinesOn(world, "H1");

    const res = await postImport(world, [
      importAccount(CODES.H1),
      importMapping("employee_receivable", CODES.H1),
    ]);

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(await mappingsOf(world)).toEqual({
      employee_receivable: CODES.H1,
    });
  });

  it("[1147-import-unchanged] re-import of a mapping the entity already has passes even though its account has lines", async () => {
    const world = await newWorldWithBase();
    await postLinesOn(world, "P");

    const res = await postImport(world, [
      importAccount(CODES.P),
      importMapping("petty_cash", CODES.P),
    ]);

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(await mappingsOf(world)).toEqual(baseCodes);
  });
});
