// Race between deleting a UOM conversion and saving a recipe version that uses
// the unit that conversion makes reachable (WS-06 second-opinion finding T2,
// legend-o1n1). Written from packages/shared/src/inventory/{endpoints,errors}.ts
// and the legend-o1n1 contract (see recipe-reference-checks.test.ts), not from
// the services.
//
// How the interleaving is forced (no production hook needed): the test holds a
// row lock on the conversion from a separate owner connection. The DELETE
// request then stalls inside its own transaction. The test waits (pg_locks via
// pg_blocking_pids) until that request is provably blocked, then fires the
// recipe save. Two outcomes are legal, and the assertions hold for both:
//   - no cross-path lock: the save runs while the delete is parked after
//     validating, commits a line on the carton unit, and then the delete
//     removes the conversion -> BOTH succeed -> the test FAILS (the bug).
//   - a shared lock: the save parks behind the delete (the test detects that it
//     is blocked by the delete's backend) -> after release one of the two is
//     refused with 409/422 and the other succeeds -> the test PASSES.
//
// Assumptions where the spec is silent:
// - Saving a recipe version whose item line uses a unit that has no remaining
//   conversion path to the item base unit is refused with 409 or 422
//   (the baseline test below pins that sequential behaviour; if it fails the
//   contract is ambiguous, not the lock).
// - The loser of the race is refused with 409 or 422; never a 5xx.
// - Final state invariant: if the conversion is gone, no recipe line of that
//   item uses the carton unit.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_TEMPLATES } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantA = randomUUID();
const brandA = randomUUID();
const legalEntityA = randomUUID();
const outletA = randomUUID();
const slugA = `rce${randomUUID().slice(0, 8)}`;
const hostA = `tenant-${slugA}.legend.test`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const app = createApp();
const createdUserIds: string[] = [];

const short = () => randomUUID().slice(0, 6);
const key = (prefix: string) => `${prefix}-${randomUUID()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let admin: { client: ReturnType<typeof agent>; userId: string };
let gramId: string;
let cartonId: string;
let portionId: string;

// ------------------------------------------------------------ owner fixtures

async function insertUom(code: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
    [tenantA, `${code}${short().slice(0, 4)}`.slice(0, 10)],
  );
  return rows[0]!.id;
}

async function insertItem(
  name: string,
  baseUomId: string,
  type: "raw_material" | "semi_finished" = "raw_material",
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', $3, $4, true) RETURNING id`,
    [tenantA, `${name} ${short()}`, type, baseUomId],
  );
  return rows[0]!.id;
}

// ------------------------------------------------------------------- HTTP

async function createConversion(
  itemId: string,
  fromUomId: string,
  toUomId: string,
  factor = "1000.0000",
): Promise<string> {
  const res = await admin.client
    .post(`/api/inventory/items/${itemId}/uom-conversions`)
    .set(originHeader)
    .send({ fromUomId, toUomId, factor, idempotencyKey: key("uom") });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body.data.id as string;
}

const deleteConversion = (itemId: string, id: string) =>
  admin.client
    .delete(`/api/inventory/items/${itemId}/uom-conversions/${id}`)
    .set(originHeader);

/** A semi-finished recipe (own output item) with one gram line of `leaf`. */
async function createRecipe(leafItem: string): Promise<string> {
  const output = await insertItem("Saus Hasil", portionId, "semi_finished");
  const res = await admin.client
    .post("/api/inventory/recipes")
    .set(originHeader)
    .send({
      brandId: brandA,
      name: `Saus ${short()}`,
      outputItemId: output,
      yieldQuantity: "1.0000",
      yieldUomId: portionId,
      lines: [
        {
          componentType: "item",
          componentId: leafItem,
          quantity: "10.0000",
          uomId: gramId,
          wastePctBp: 0,
        },
      ],
      idempotencyKey: key("recipe"),
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.recipe.id as string;
}

/** Saves a new version whose only line uses `leafItem` in `uomId`. */
const saveVersion = (recipeId: string, leafItem: string, uomId: string) =>
  admin.client
    .post(`/api/inventory/recipes/${recipeId}/versions`)
    .set(originHeader)
    .send({
      lines: [
        {
          componentType: "item",
          componentId: leafItem,
          quantity: "1.0000",
          uomId,
          wastePctBp: 0,
        },
      ],
      idempotencyKey: key("version"),
    });

async function rowExists(table: string, id: string): Promise<boolean> {
  const { rows } = await owner.query(`SELECT 1 FROM ${table} WHERE id = $1`, [
    id,
  ]);
  return rows.length === 1;
}

async function lineCountOnUnit(itemId: string, uomId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM recipe_lines
      WHERE tenant_id = $1 AND component_type = 'item'
        AND component_id = $2 AND uom_id = $3`,
    [tenantA, itemId, uomId],
  );
  return Number(rows[0]!.n);
}

// ------------------------------------------------------------ interleaving

/** Number of backends currently blocked (directly) by backend `pid`. */
async function backendsBlockedBy(pid: number): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_stat_activity
      WHERE datname = current_database() AND $1 = ANY (pg_blocking_pids(pid))`,
    [pid],
  );
  return Number(rows[0]!.n);
}

/** Polls until `predicate` is true; throws on timeout (a setup failure). */
async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

// -------------------------------------------------------------------- setup

async function createOwnTenant() {
  const fixtures = cafeLegendPlatformFixtures;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', 'active', 'shared', $4, $5, 'test')`,
    [
      tenantA,
      `tenant-${slugA}`,
      `Tenant ${slugA}`,
      JSON.stringify(fixtures.tenant.featureFlags),
      JSON.stringify(fixtures.tenant.limits),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    [brandA, tenantA, `brand-${slugA}`, `Brand ${slugA}`],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [legalEntityA, tenantA, `Entity ${slugA}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji 1', 'Asia/Jakarta', $7, 'active')`,
    [
      outletA,
      tenantA,
      brandA,
      legalEntityA,
      `R${slugA.slice(3)}`.toUpperCase(),
      `Outlet ${slugA}`,
      JSON.stringify(fixtures.outlets[0]!.openingHours),
    ],
  );
  for (const template of ROLE_TEMPLATES.filter((t) => t.level === "tenant"))
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, true, $4, $5, $6, $7)`,
      [
        randomUUID(),
        tenantA,
        template.defaultName,
        template.key,
        JSON.stringify(template.permissions),
        template.mfaRequired,
        JSON.stringify(template.allowedScopeTypes),
      ],
    );
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'platform_subdomain', 'active', now())`,
    [randomUUID(), tenantA, brandA, hostA],
  );
}

async function dropOwnTenant() {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
          AND t.table_type = 'BASE TABLE'`,
    );
    for (const { table_name } of rows)
      await client.query(`DELETE FROM "${table_name}" WHERE tenant_id = $1`, [
        tenantA,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantA]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await createOwnTenant();
  const client = agent(app);
  await signUp(client, "Race Owner");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  client.set("Host", hostA);
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner'",
    [tenantA],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantA, userId, rows[0]!.id],
  );
  admin = { client, userId };
  gramId = await insertUom("g");
  cartonId = await insertUom("ctn");
  portionId = await insertUom("porsi");
});

afterAll(async () => {
  await dropOwnTenant();
  await owner.end();
});

async function insertModifier(): Promise<string> {
  const group = await owner.query<{ id: string }>(
    "INSERT INTO modifier_groups (tenant_id, name, min_select, max_select) VALUES ($1, 'Tambahan Uji', 0, 10) RETURNING id",
    [tenantA],
  );
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO modifiers (tenant_id, group_id, name) VALUES ($1, $2, $3) RETURNING id",
    [tenantA, group.rows[0]!.id, `Mod ${short()}`],
  );
  return rows[0]!.id;
}

/** Replaces the modifier's rules with one 'add' rule of `leafItem` in `uomId`. */
const putRules = (modifierId: string, leafItem: string, uomId: string) =>
  admin.client
    .put(`/api/inventory/modifiers/${modifierId}/recipe-rules`)
    .set(originHeader)
    .send({
      rules: [
        {
          action: "add",
          targetComponentType: null,
          targetComponentId: null,
          componentType: "item",
          componentId: leafItem,
          quantity: "1.0000",
          uomId,
          wastePctBp: 0,
        },
      ],
    });

async function ruleCountOnUnit(itemId: string, uomId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM modifier_recipe_rules
      WHERE tenant_id = $1 AND component_type = 'item'
        AND component_id = $2 AND uom_id = $3`,
    [tenantA, itemId, uomId],
  );
  return Number(rows[0]!.n);
}

/**
 * Parks a conversion delete behind a row lock, fires `save` while it waits, and
 * asserts the delete and the save are not both accepted (see file header).
 */
async function expectDeleteAndSaveNotBothAccepted(
  item: string,
  conversionId: string,
  save: () => PromiseLike<{ status: number; body: unknown }>,
  usesUnit: () => Promise<boolean>,
): Promise<void> {
  // Barrier: a separate connection holds a lock on the conversion row so the
  // delete request stalls inside its transaction. NO KEY UPDATE conflicts
  // with DELETE but not with the foreign-key checks a recipe save makes.
  const holder = await owner.connect();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await holder.query("ROLLBACK");
    holder.release();
  };
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT id FROM uom_conversions WHERE id = $1 FOR NO KEY UPDATE",
      [conversionId],
    );
    const { rows: pidRows } = await holder.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    const holderPid = pidRows[0]!.pid;

    // 1. Fire the delete; wait until it is provably parked behind the lock.
    const deletePromise = deleteConversion(item, conversionId).then((r) => r);
    await waitUntil(
      async () => (await backendsBlockedBy(holderPid)) >= 1,
      "delete request blocked on the conversion row",
    );
    const { rows: delRows } = await owner.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND $1 = ANY (pg_blocking_pids(pid))`,
      [holderPid],
    );
    const deletePid = delRows[0]!.pid;

    // 2. Fire the recipe save. Either it completes (nothing serialises the
    // two paths) or it parks behind the delete's backend (a shared lock).
    let saveSettled = false;
    const savePromise = save().then((r) => {
      saveSettled = true;
      return r;
    });
    await waitUntil(
      async () => saveSettled || (await backendsBlockedBy(deletePid)) >= 1,
      "recipe save finished or parked behind the delete",
    );

    // 3. Release the barrier and let both finish.
    await release();
    const [deleteRes, saveRes] = await Promise.all([
      deletePromise,
      savePromise,
    ]);

    const deleteOk = deleteRes.status === 204;
    const saveOk = saveRes.status < 300;
    const detail = JSON.stringify({
      delete: [deleteRes.status, deleteRes.body],
      save: [saveRes.status, saveRes.body],
    });
    expect(
      deleteOk && saveOk,
      `both succeeded: a recipe line now uses a unit with no conversion. ${detail}`,
    ).toBe(false);
    // The loser is refused cleanly, the winner succeeded; no 5xx.
    expect(deleteOk || saveOk, detail).toBe(true);
    if (!deleteOk) expect(deleteRes.status, detail).toBe(409);
    if (!saveOk) expect([409, 422], detail).toContain(saveRes.status);

    // Final state is consistent.
    const conversionGone = !(await rowExists("uom_conversions", conversionId));
    if (conversionGone) expect(await usesUnit(), detail).toBe(false);
  } finally {
    await release();
  }
}

// ------------------------------------------------------------------- tests

describe("legend-o1n1 deleting a UOM conversion races with saving a recipe version that uses its unit", () => {
  it("legend-o1n1 baseline (no race): saving a line on the carton unit works while the conversion exists, and is refused after it is deleted", async () => {
    const item = await insertItem("Tepung Dasar", gramId);
    const conversionId = await createConversion(item, cartonId, gramId);
    const recipeId = await createRecipe(item);

    const ok = await saveVersion(recipeId, item, cartonId);
    expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);

    // The saved version now uses the unit, so the delete is refused.
    const refused = await deleteConversion(item, conversionId);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(await rowExists("uom_conversions", conversionId)).toBe(true);

    // Move the recipe off the carton unit, delete, then try to come back.
    const off = await saveVersion(recipeId, item, gramId);
    expect(off.status, JSON.stringify(off.body)).toBeLessThan(300);
    const deleted = await deleteConversion(item, conversionId);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(204);
    const back = await saveVersion(recipeId, item, cartonId);
    expect([409, 422], JSON.stringify(back.body)).toContain(back.status);
  });

  it("legend-o1n1 delete parked after validating, recipe save arrives meanwhile: both must not succeed", async () => {
    const item = await insertItem("Tepung Balap", gramId);
    const conversionId = await createConversion(item, cartonId, gramId);
    const recipeId = await createRecipe(item);
    await expectDeleteAndSaveNotBothAccepted(
      item,
      conversionId,
      () => saveVersion(recipeId, item, cartonId),
      async () => (await lineCountOnUnit(item, cartonId)) > 0,
    );
  });

  it("legend-o1n1 delete parked after validating, modifier rules save arrives meanwhile: both must not succeed", async () => {
    const item = await insertItem("Gula Balap", gramId);
    const conversionId = await createConversion(item, cartonId, gramId);
    const modifierId = await insertModifier();
    await expectDeleteAndSaveNotBothAccepted(
      item,
      conversionId,
      () => putRules(modifierId, item, cartonId),
      async () => (await ruleCountOnUnit(item, cartonId)) > 0,
    );
  });
});
