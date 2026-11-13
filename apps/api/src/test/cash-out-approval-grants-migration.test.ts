// Cash-out approval (founder Q7, tier K money), review finding H1 + M1:
// - H1: the role templates are copied into each tenant once, so a tenant that
//   existed before the new codes has stored owner/finance rows without them.
//   Migration 0497 must append `accounting.cash_bank.approve`,
//   `accounting.cash_bank.limit.manage` and `accounting.cash_bank.record` (0484
//   forgot it) to those stored `owner` and `finance` template rows: idempotent,
//   no duplicates. `tenant_admin`, every other template and custom roles do
//   NOT get them. Written from docs/briefs/sub-cash-out-approval.md and the
//   0090 data-migration test pattern; the role statements run as the migration
//   owner, twice. Each template row is restored right after its test so other
//   files see the seeded permissions.
// - M1: the application role may update only the decision columns of
//   cash_bank_entries (append-only otherwise), and never DELETE.
//
// Assumption: the backfill lives in drizzle/0497_cash_out_approval_grants.sql
// (the brief names 0497), and the whole file is safe to run again as the
// migration owner (GRANT and the idempotent DO block).
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const NEW_CODES = [
  "accounting.cash_bank.approve",
  "accounting.cash_bank.limit.manage",
  "accounting.cash_bank.record",
];
const GRANTED_TEMPLATES = ["owner", "finance"];
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const unique = () => randomBytes(6).toString("hex");
const migration = readFileSync(
  resolve(
    import.meta.dirname,
    "../../drizzle/0497_cash_out_approval_grants.sql",
  ),
  "utf8",
);

type TemplateRow = { id: string; permissions: string[]; updated_at: Date };
let originals: TemplateRow[] = [];
const createdRoles: string[] = [];

beforeAll(async () => {
  originals = (
    await owner.query<TemplateRow>(
      "SELECT id, permissions, updated_at FROM roles WHERE tenant_id = $1 AND is_template",
      [tenantId],
    )
  ).rows;
});

async function restoreTemplates(): Promise<void> {
  for (const row of originals)
    await owner.query(
      "UPDATE roles SET permissions = $3::jsonb, updated_at = $4 WHERE tenant_id = $1 AND id = $2",
      [tenantId, row.id, JSON.stringify(row.permissions), row.updated_at],
    );
}

afterAll(async () => {
  await restoreTemplates();
  if (createdRoles.length > 0)
    await owner.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, createdRoles],
    );
  await owner.end();
});

/** Runs the whole migration file as the migration owner. */
const migrate = async () => {
  await owner.query(migration.replace(/--> statement-breakpoint/g, ""));
};

const permissionsOf = async (id: string): Promise<string[]> =>
  (
    await owner.query<{ permissions: string[] }>(
      "SELECT permissions FROM roles WHERE tenant_id = $1 AND id = $2",
      [tenantId, id],
    )
  ).rows[0]!.permissions;

/** Strips the new codes from every stored template, as a pre-0497 tenant has it. */
async function legacyTemplates(): Promise<Map<string, string>> {
  const { rows } = await owner.query<{ id: string; template_key: string }>(
    `UPDATE roles SET permissions = (
         SELECT coalesce(jsonb_agg(p), '[]'::jsonb)
           FROM jsonb_array_elements(permissions) AS p
          WHERE p #>> '{}' <> ALL($2::text[]))
      WHERE tenant_id = $1 AND is_template
      RETURNING id, template_key`,
    [tenantId, NEW_CODES],
  );
  return new Map(rows.map((r) => [r.template_key, r.id]));
}

async function customRole(permissions: string[]): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4::jsonb, false, '["outlet"]'::jsonb)`,
    [id, tenantId, `Backfill ${unique()}`, JSON.stringify(permissions)],
  );
  createdRoles.push(id);
  return id;
}

describe("cash-out approval grants migration 0497", () => {
  it("[cash-out-approval-MIG-1] existing owner and finance templates gain the 3 codes exactly once, also when run twice; tenant_admin and others do not", async () => {
    try {
      const ids = await legacyTemplates();
      for (const key of GRANTED_TEMPLATES) {
        expect(ids.has(key), `template ${key} exists`).toBe(true);
        const before = await permissionsOf(ids.get(key)!);
        for (const code of NEW_CODES) expect(before).not.toContain(code);
      }
      expect(ids.has("tenant_admin"), "tenant_admin template exists").toBe(
        true,
      );

      await migrate();
      await migrate();

      for (const key of GRANTED_TEMPLATES) {
        const permissions = await permissionsOf(ids.get(key)!);
        for (const code of NEW_CODES)
          expect(
            permissions.filter((p) => p === code),
            `${key} holds ${code} once`,
          ).toHaveLength(1);
      }
      for (const [key, id] of ids) {
        if (GRANTED_TEMPLATES.includes(key)) continue;
        const permissions = await permissionsOf(id);
        for (const code of NEW_CODES)
          expect(permissions, `${key} must not get ${code}`).not.toContain(
            code,
          );
      }
    } finally {
      await restoreTemplates();
    }
  });

  it("[cash-out-approval-MIG-2] the backfill keeps the rest of the role and does not duplicate a code a template already holds", async () => {
    try {
      const ids = await legacyTemplates();
      const financeId = ids.get("finance")!;
      const original = originals.find((r) => r.id === financeId)!;
      const base = original.permissions.filter((p) => !NEW_CODES.includes(p));
      // Finance already holds one of the codes before the migration runs.
      await owner.query(
        "UPDATE roles SET permissions = permissions || $3::jsonb WHERE tenant_id = $1 AND id = $2",
        [tenantId, financeId, JSON.stringify(["accounting.cash_bank.record"])],
      );

      await migrate();

      const after = await permissionsOf(financeId);
      for (const code of NEW_CODES)
        expect(after.filter((p) => p === code)).toHaveLength(1);
      for (const code of base) expect(after).toContain(code);
      expect(after).toHaveLength(base.length + NEW_CODES.length);
    } finally {
      await restoreTemplates();
    }
  });

  it("[cash-out-approval-MIG-3] custom roles are never touched, even one holding another accounting code", async () => {
    const holder = await customRole([
      "accounting.journal.post",
      "accounting.cash_bank.view",
    ]);
    const empty = await customRole([]);
    try {
      await legacyTemplates();
      await migrate();
      expect(await permissionsOf(holder)).toEqual([
        "accounting.journal.post",
        "accounting.cash_bank.view",
      ]);
      expect(await permissionsOf(empty)).toEqual([]);
    } finally {
      await restoreTemplates();
    }
  });
});

describe("cash-out approval grants: application role privileges (M1)", () => {
  it("[cash-out-approval-MIG-4] legend_app may update only the decision columns of cash_bank_entries and never delete", async () => {
    const { rows } = await owner.query<{
      column_name: string;
      can_update: boolean;
    }>(
      `SELECT column_name,
              has_column_privilege('legend_app', 'public.cash_bank_entries', column_name, 'UPDATE') AS can_update
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'cash_bank_entries'`,
    );
    const updatable = rows
      .filter((r) => r.can_update)
      .map((r) => r.column_name)
      .sort();
    expect(updatable).toEqual(
      [
        "approver_id",
        "decided_at",
        "decision_reason",
        "journal_entry_id",
        "status",
      ].sort(),
    );
    const del = await owner.query<{ granted: boolean }>(
      "SELECT has_table_privilege('legend_app', 'public.cash_bank_entries', 'DELETE') AS granted",
    );
    expect(del.rows[0]!.granted).toBe(false);
  });
});
