// Pure checks of the daily-operations schema against the contract and the
// tenant/outlet isolation rules (TEN-01..03, OPS-02). No database: the RLS
// catalogue guard (db/rls.test.ts) proves forced policies on the live server;
// this file proves the SQL we ship declares them and the OPS-02 gate exists.
import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  equipment,
  maintenanceSchedules,
  maintenanceTickets,
  operationsIdempotency,
  opsChecklistRuns,
  opsChecklistTemplates,
  prepLabels,
  prepListItems,
  prepLists,
  shiftHandovers,
  temperatureLogs,
} from "../db/schema/operations.ts";

const customSql = readFileSync(
  new URL("../db/schema/operations.custom.sql", import.meta.url),
  "utf8",
);

const tableNames = [
  "equipment",
  "ops_checklist_templates",
  "ops_checklist_runs",
  "temperature_logs",
  "prep_labels",
  "prep_lists",
  "prep_list_items",
  "maintenance_schedules",
  "maintenance_tickets",
  "shift_handovers",
  "operations_idempotency",
] as const;

describe("operations schema (WS-14)", () => {
  it("[TEN-01] every table has tenant + outlet RLS in operations.custom.sql", () => {
    for (const table of tableNames) {
      expect(customSql, table).toContain(
        `app.enforce_tenant_rls('public.${table}'::regclass)`,
      );
      expect(customSql, table).toContain(
        `app.enforce_outlet_rls('public.${table}'::regclass)`,
      );
    }
    expect(customSql).not.toContain("CREATE EXTENSION");
  });

  it("[TEN-01] every table is tenant- and outlet-owned", () => {
    for (const table of [
      equipment,
      opsChecklistTemplates,
      opsChecklistRuns,
      temperatureLogs,
      prepLabels,
      prepLists,
      prepListItems,
      maintenanceSchedules,
      maintenanceTickets,
      shiftHandovers,
      operationsIdempotency,
    ]) {
      const config = getTableConfig(table);
      expect(config.columns.some((column) => column.name === "tenant_id")).toBe(
        true,
      );
      expect(config.columns.some((column) => column.name === "outlet_id")).toBe(
        true,
      );
    }
  });

  it("[OPS-02] temperature_logs carries the corrective-action CHECK", () => {
    const config = getTableConfig(temperatureLogs);
    expect(
      config.checks.some(
        (check) => check.name === "temperature_logs_corrective_action_check",
      ),
    ).toBe(true);
  });

  it("[OPS-05] shift_handovers refuses a self-acknowledgement in SQL", () => {
    const config = getTableConfig(shiftHandovers);
    expect(
      config.checks.some(
        (check) => check.name === "shift_handovers_self_acknowledgement_check",
      ),
    ).toBe(true);
  });

  it("[OPS-01] checklist runs carry the server missed flag", () => {
    const config = getTableConfig(opsChecklistRuns);
    const columns = config.columns.map((column) => column.name);
    expect(columns).toContain("missed_at");
    expect(columns).toContain("alerted_at");
  });
});
