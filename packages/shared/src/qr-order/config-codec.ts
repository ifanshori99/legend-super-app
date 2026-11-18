// TEN-09 (legend-qeott): floor-zone configuration travels by portable outlet
// and zone keys. Waiter assignments, tables and source identifiers are tenant
// data and never form part of a zone template. No platform import: the registry
// consumes this structural codec without introducing a domain/platform cycle.
import { z } from "zod";
import { floorZoneSchema, type FloorZone } from "./schemas.ts";

const itemKeySchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/);

export const zoneConfigItemSchema = z.strictObject({
  key: itemKeySchema,
  outletKey: itemKeySchema,
  name: z.string().trim().min(1).max(150),
  paymentMode: floorZoneSchema.shape.paymentMode,
  serviceChargeBp: floorZoneSchema.shape.serviceChargeBp,
  minimumSpendIdr: floorZoneSchema.shape.minimumSpendIdr,
  hours: floorZoneSchema.shape.hours.max(50),
  status: floorZoneSchema.shape.status,
  sortOrder: z.number().int().min(0),
  /** Absent in templates exported before legend-p4q10; the importer reads absent as false. */
  isWfc: floorZoneSchema.shape.isWfc.optional(),
});

export type ZoneConfigItem = z.infer<typeof zoneConfigItemSchema>;
/** The importer resolves outletKey and mints a new zone id. */
export type ZoneConfigDraft = ZoneConfigItem;
export type ZoneConfigRow = Pick<
  FloorZone,
  | "id"
  | "outletId"
  | "name"
  | "paymentMode"
  | "serviceChargeBp"
  | "minimumSpendIdr"
  | "hours"
  | "status"
  | "sortOrder"
> & { isWfc?: boolean; createdAt?: string | Date };

export type ZoneConfigExportContext = {
  /** Source outlet id to the lower-case portable outlet code. */
  outletKeys: ReadonlyMap<string, string>;
};
export type ZoneConfigImportContext = {
  /** Omitted when target outlets will be resolved by the importer. */
  outletKeys?: ReadonlySet<string>;
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Same outlet/name convention as the API's zoneConfigKey helper. */
function zoneKey(outletKey: string, name: string): string {
  const slug = [outletKey, name]
    .map((part) =>
      part
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean)
    .join(".");
  return (/^[a-z0-9]/.test(slug) ? slug : `k${slug}`).slice(0, 100) || "k";
}

function createdAt(row: ZoneConfigRow): string {
  return row.createdAt instanceof Date
    ? row.createdAt.toISOString()
    : (row.createdAt ?? "");
}

export const zonesConfigCodec = {
  section: "zones" as const,
  version: 1 as const,
  itemSchema: zoneConfigItemSchema,

  toTemplate(
    rows: readonly ZoneConfigRow[],
    context: ZoneConfigExportContext,
  ): ZoneConfigItem[] {
    const used = new Set<string>();
    // The API assigns portable keys in created_at/id order. Sorting locally
    // keeps keys stable when callers return the same rows in another order.
    const ordered = [...rows].sort(
      (a, b) =>
        compareText(createdAt(a), createdAt(b)) || compareText(a.id, b.id),
    );
    return ordered.map((row) => {
      const outletKey = context.outletKeys.get(row.outletId);
      if (!outletKey)
        throw new Error("zones: source outlet has no portable outlet key");
      const base = zoneKey(outletKey, row.name);
      let key = base;
      for (let count = 2; used.has(key); count++) {
        const suffix = `-${count}`;
        key = `${base.slice(0, 100 - suffix.length)}${suffix}`;
      }
      used.add(key);
      // Explicit field selection strips ids; parsing checks the domain
      // limits and returns detached arrays/objects (especially zone hours).
      return zoneConfigItemSchema.parse({
        key,
        outletKey,
        name: row.name,
        paymentMode: row.paymentMode,
        serviceChargeBp: row.serviceChargeBp,
        minimumSpendIdr: row.minimumSpendIdr,
        hours: row.hours,
        status: row.status,
        sortOrder: row.sortOrder,
        ...(row.isWfc === undefined ? {} : { isWfc: row.isWfc }),
      });
    });
  },

  fromTemplate(
    items: readonly unknown[],
    context: ZoneConfigImportContext = {},
  ): { ok: true; drafts: ZoneConfigDraft[] } | { ok: false; issues: string[] } {
    const issues: string[] = [];
    const drafts: ZoneConfigDraft[] = [];
    const keys = new Set<string>();
    const namesByOutlet = new Map<string, Set<string>>();
    for (const raw of items) {
      const parsed = zoneConfigItemSchema.safeParse(raw);
      if (!parsed.success) {
        const key =
          typeof raw === "object" && raw !== null && "key" in raw
            ? String(raw.key)
            : "unknown";
        issues.push(
          `zones item ${key}: ${parsed.error.issues
            .map(
              (issue) => `${issue.path.join(".") || "item"} ${issue.message}`,
            )
            .join("; ")}`,
        );
        continue;
      }
      const item = parsed.data;
      if (keys.has(item.key))
        issues.push(`zones item ${item.key}: duplicate key`);
      keys.add(item.key);
      const names = namesByOutlet.get(item.outletKey) ?? new Set<string>();
      const nameKey = item.name;
      if (names.has(nameKey))
        issues.push(
          `zones item ${item.key}: duplicate name in outlet ${item.outletKey}`,
        );
      names.add(nameKey);
      namesByOutlet.set(item.outletKey, names);
      if (context.outletKeys && !context.outletKeys.has(item.outletKey))
        issues.push(
          `zones item ${item.key}: unknown outlet key ${item.outletKey}`,
        );
      drafts.push(item);
    }
    return issues.length > 0 ? { ok: false, issues } : { ok: true, drafts };
  },
};
