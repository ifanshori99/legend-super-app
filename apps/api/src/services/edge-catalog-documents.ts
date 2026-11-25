// Catalog document streams (protocol 4, legend-osqou.22): one spec per table
// that travels cloud -> edge as whole rows. The export
// (services/edge-catalog-sync.ts) and the edge apply
// (services/edge-catalog-apply.ts) read the same spec, so a new stream (F7:
// facility, unit, product, opening hours) is a schema in
// packages/shared/src/edge/catalog-sync.ts, a spec here, its parents in
// edge/catalog-puller.ts, its rule in edge-catalog-restore-membership.ts and a
// migration (column, index, stamp trigger, deletion trigger when rows are
// hard-deleted). The fields that travel are the wire schema's
// (`CATALOG_DOCUMENT_FIELDS`); a column that is not in it stays home.
//
// A column the edge owns (the state of a table, later of a facility unit) is
// not a wire field: `fromRecord` decides what the record may set.
import type { CatalogDocumentStream } from "@starter/shared/edge";
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { floorZones, tables } from "../db/schema/floor.ts";
import { kitchenCapacityRules } from "../db/schema/kds-capacity.ts";
import { kitchenMenuLoads } from "../db/schema/kds-pacing.ts";
import { itemAvailability } from "../db/schema/menu.ts";
import {
  paymentCashierDefaults,
  paymentEdcTerminals,
} from "../db/schema/payment-admin.ts";
import { approvalPolicies } from "../db/schema/platform-access.ts";
import { posApprovalPolicies } from "../db/schema/pos-order.ts";
import { serviceChargeRules, taxRules, taxSettings } from "../db/schema/tax.ts";

export type DocumentTable = PgTable & {
  readonly id: AnyPgColumn;
  readonly tenantId: AnyPgColumn;
  readonly syncTxid: AnyPgColumn;
  readonly outletId?: AnyPgColumn;
};

export type DocumentRecord = Readonly<Record<string, unknown>> & {
  readonly id: string;
  readonly tenantId: string;
  readonly outletId?: string | null;
  readonly syncTxid: string;
  readonly deletedAt?: string | null;
};

export type CatalogDocumentSpec = {
  readonly table: DocumentTable;
  /** Which rows an outlet's edge gets: its own, also the tenant-wide ones, or all. */
  readonly scope: "own" | "own_or_tenant" | "tenant";
  /** `marker`: hard-deleted, announced by `edge_catalog_tombstones`. */
  readonly deletes: "never" | "soft" | "marker";
  /** The row's menu item: only items of the outlet's brand travel. */
  readonly menuItemId?: AnyPgColumn;
  /** Wire fields that are not columns. */
  readonly toRecord?: (
    row: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown>;
  /** Column values of a live record that differ from a plain copy. */
  readonly fromRecord?: (record: DocumentRecord) => {
    readonly insert: Record<string, unknown>;
    readonly update: Record<string, unknown>;
  };
  /**
   * Another local row on the record's unique key gives way (cloud wins).
   * `give` is its SET list, or null to delete it (nothing refers to it).
   */
  readonly unique?: {
    readonly sameKey: (record: DocumentRecord) => SQL;
    readonly give: SQL | null;
  };
  /** A deleted row that history still refers to stays, with this SET list. */
  readonly keepReferenced?: SQL;
};

const sameOutlet = (column: AnyPgColumn, record: DocumentRecord): SQL =>
  sql`${column} IS NOT DISTINCT FROM ${record.outletId ?? null}::uuid`;

/**
 * A rule version is evidence of tax already charged (`tax_snapshots` refer to
 * it): out of force and off the version number, never removed.
 */
const supersedeVersion = (table: PgTable): SQL =>
  sql`status = 'archived', published_at = NULL, published_by = NULL,
      version = (SELECT max(version) FROM ${table}) + 1`;

const ruleVersion = (
  table: DocumentTable & { code: AnyPgColumn; version: AnyPgColumn },
): CatalogDocumentSpec => ({
  table,
  scope: "own_or_tenant",
  deletes: "never",
  unique: {
    sameKey: (r) =>
      sql`${sameOutlet(table.outletId!, r)} AND ${table.code} = ${r.code} AND ${table.version} = ${r.version}`,
    give: supersedeVersion(table),
  },
});

export const CATALOG_DOCUMENTS: Readonly<
  Record<CatalogDocumentStream, CatalogDocumentSpec>
> = {
  tax_rules: ruleVersion(taxRules),
  service_charge_rules: ruleVersion(serviceChargeRules),
  tax_settings: {
    table: taxSettings,
    scope: "own_or_tenant",
    deletes: "never",
    unique: {
      sameKey: (r) =>
        sql`${sameOutlet(taxSettings.outletId, r)} AND ${taxSettings.version} = ${r.version}`,
      give: supersedeVersion(taxSettings),
    },
  },
  floor_zones: {
    table: floorZones,
    scope: "own",
    deletes: "marker",
    unique: {
      sameKey: (r) =>
        sql`${floorZones.outletId} = ${r.outletId}::uuid AND ${floorZones.name} = ${r.name}`,
      give: sql`name = left(name, 100) || ' ~' || id::text, status = 'inactive'`,
    },
    keepReferenced: sql`status = 'inactive'`,
  },
  tables: {
    table: tables,
    scope: "own",
    deletes: "marker",
    toRecord: (row) => ({ isActive: row.status !== "inactive" }),
    // The edge owns occupied / reserved / dirty: the cloud only takes the table
    // out of use or puts it back.
    fromRecord: (r) => ({
      insert: { status: r.isActive ? "available" : "inactive" },
      update: {
        status: r.isActive
          ? sql`CASE WHEN ${tables.status} = 'inactive' THEN 'available' ELSE ${tables.status} END`
          : "inactive",
      },
    }),
    unique: {
      sameKey: (r) =>
        sql`${tables.outletId} = ${r.outletId}::uuid AND ${tables.code} = ${r.code}`,
      // Upper-case hex of the id: within the code format, unique per table.
      give: sql`code = 'X' || upper(left(md5(id::text), 19)), status = 'inactive'`,
    },
    keepReferenced: sql`status = 'inactive'`,
  },
  payment_edc_terminals: {
    table: paymentEdcTerminals,
    scope: "own",
    deletes: "never",
    unique: {
      sameKey: (r) =>
        sql`${paymentEdcTerminals.bankCode} = ${r.bankCode} AND ${paymentEdcTerminals.terminalId} = ${r.terminalId}`,
      give: sql`terminal_id = left(terminal_id, 60) || '~' || id::text, status = 'inactive'`,
    },
  },
  payment_cashier_defaults: {
    table: paymentCashierDefaults,
    scope: "own",
    deletes: "marker",
    unique: {
      sameKey: (r) =>
        sql`${paymentCashierDefaults.outletId} = ${r.outletId}::uuid AND ${paymentCashierDefaults.cashierId} = ${r.cashierId}::uuid`,
      give: null,
    },
  },
  pos_approval_policies: {
    table: posApprovalPolicies,
    scope: "own_or_tenant",
    deletes: "never",
    unique: {
      sameKey: (r) => sameOutlet(posApprovalPolicies.outletId, r),
      give: null,
    },
  },
  approval_policies: {
    table: approvalPolicies,
    scope: "tenant",
    deletes: "marker",
    unique: {
      sameKey: (r) =>
        sql`${approvalPolicies.actionType} = ${r.actionType} AND ${approvalPolicies.thresholdIdr} IS NOT DISTINCT FROM ${r.thresholdIdr}::bigint AND ${approvalPolicies.levels} = ${r.levels} AND ${approvalPolicies.approverRoleId} = ${r.approverRoleId}::uuid`,
      give: null,
    },
  },
  kitchen_capacity_rules: {
    table: kitchenCapacityRules,
    scope: "own",
    deletes: "marker",
  },
  kitchen_menu_loads: {
    table: kitchenMenuLoads,
    scope: "own",
    deletes: "marker",
    menuItemId: kitchenMenuLoads.menuItemId,
    unique: {
      sameKey: (r) =>
        sql`${kitchenMenuLoads.outletId} = ${r.outletId}::uuid AND ${kitchenMenuLoads.menuItemId} = ${r.menuItemId}::uuid AND ${kitchenMenuLoads.variantId} IS NOT DISTINCT FROM ${r.variantId}::uuid`,
      give: null,
    },
  },
  item_availability: {
    table: itemAvailability,
    scope: "own",
    deletes: "soft",
    menuItemId: itemAvailability.menuItemId,
    unique: {
      sameKey: (r) =>
        sql`${itemAvailability.deletedAt} IS NULL AND ${itemAvailability.outletId} = ${r.outletId}::uuid AND ${itemAvailability.menuItemId} = ${r.menuItemId}::uuid`,
      give: sql`deleted_at = now()`,
    },
  },
};
