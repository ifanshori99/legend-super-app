// Migration 0333/0334 (WS-06 supplier invoices, purchasing policy, debit note
// settlements): RLS is forced, the app login cannot rewrite the money columns
// or delete a row, and a debit note settles an open item at most once.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

const tables = [
  "purchase_invoices",
  "purchase_invoice_lines",
  "purchasing_policies",
] as const;

describe("purchase invoices migration (0333, 0334)", () => {
  it("forces row level security and the tenant policy on every new table", async () => {
    const { rows } = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: number;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c
        WHERE c.relname = ANY($1) AND c.relnamespace = 'public'::regnamespace`,
      [[...tables]],
    );
    expect(rows.map((row) => row.relname).sort()).toEqual([...tables].sort());
    for (const row of rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
      // Tenant policy, plus the outlet policy on the outlet-owned tables.
      expect(row.policies, row.relname).toBeGreaterThanOrEqual(
        row.relname === "purchasing_policies" ? 1 : 2,
      );
    }
  });

  it("lets the app login change only the decision columns of an invoice", async () => {
    const privilege = async (sql: string, args: unknown[]) =>
      (await pool.query<{ ok: boolean }>(sql, args)).rows[0]!.ok;
    for (const privilegeName of ["DELETE", "TRUNCATE"])
      for (const table of ["purchase_invoices", "purchase_invoice_lines"])
        expect(
          await privilege(
            "SELECT has_table_privilege(current_user, $1, $2) AS ok",
            [table, privilegeName],
          ),
          `${privilegeName} ${table}`,
        ).toBe(false);
    const column = (table: string, name: string) =>
      privilege(
        "SELECT has_column_privilege(current_user, $1, $2, 'UPDATE') AS ok",
        [table, name],
      );
    for (const name of [
      "status",
      "decided_by",
      "decided_at",
      "decision_note",
      "journal_entry_id",
      "match_result",
      "match_snapshot",
      "match_note",
      "tolerance_bp",
      "updated_at",
    ])
      expect(await column("purchase_invoices", name), name).toBe(true);
    for (const name of [
      "payable_idr",
      "total_idr",
      "goods_idr",
      "ppn_idr",
      "pph23_idr",
      "number",
      "recorded_by",
    ])
      expect(await column("purchase_invoices", name), name).toBe(false);
    expect(await column("purchase_invoice_lines", "quantity")).toBe(false);
  });

  it("keeps the state shape and separation of duties as constraints", async () => {
    const { rows } = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.purchase_invoices'::regclass AND contype = 'c'`,
    );
    const names = rows.map((row) => row.conname);
    for (const name of [
      "purchase_invoices_amounts_check",
      "purchase_invoices_journal_state_check",
      "purchase_invoices_decision_state_check",
      "purchase_invoices_match_state_check",
      "purchase_invoices_decider_check",
    ])
      expect(names).toContain(name);
  });

  it("allows a debit note settlement once per open item and return", async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE indexname = 'accounting_open_item_settlements_debit_note_key'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain("UNIQUE");
    expect(rows[0]!.indexdef).toContain("debit_note");
    const check = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'accounting_open_item_settlements_method_check'`,
    );
    expect(check.rows[0]!.def).toContain("debit_note");
  });
});
