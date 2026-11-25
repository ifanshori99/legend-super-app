// TEN-09 (legend-u74y8): portable facility configuration, never tickets,
// rewards, customer entitlements, hardware credentials or billing provider ids.
// The owning domain deliberately does not import platform (its registry imports us).
import { z } from "zod";
import {
  entitlementRuleSchema,
  facilityAddonSchema,
  facilityAreaSchema,
  facilityProductSchema,
  facilitySchema,
  facilityUnitSchema,
  subscriptionPlanSchema,
  type EntitlementRule,
  type Facility,
  type FacilityAddon,
  type FacilityArea,
  type FacilityProduct,
  type FacilityUnit,
  type SubscriptionPlan,
} from "./schemas.ts";
import { wfcProductSplitSchema } from "../wfc/index.ts";

const keySchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/);
const rowFields = {
  id: true,
  tenantId: true,
  outletId: true,
  updatedAt: true,
} as const;
const childFields = { ...rowFields, facilityId: true } as const;
const facilityItem = facilitySchema
  .omit(rowFields)
  .extend({
    key: keySchema,
    kind: z.literal("facility"),
    outletKey: keySchema,
    cleaningMinutes: z.number().int().min(0).max(240),
  })
  .refine((item) => item.sessionMinutes + item.cleaningMinutes <= 720, {
    path: ["cleaningMinutes"],
    message: "sessionMinutes + cleaningMinutes must be at most 720",
  });
const areaItem = facilityAreaSchema
  .omit({ ...childFields, entranceLockDeviceId: true })
  .extend({
    key: keySchema,
    kind: z.literal("area"),
    facilityKey: keySchema,
  });
const unitItem = facilityUnitSchema
  .omit({
    ...childFields,
    areaId: true,
    lockDeviceId: true,
    panicDeviceId: true,
  })
  .extend({
    key: keySchema,
    kind: z.literal("unit"),
    facilityKey: keySchema,
    areaKey: keySchema,
  });
const productItem = facilityProductSchema
  .omit({ ...childFields, taxRuleId: true, menuItemId: true })
  .extend({
    key: keySchema,
    kind: z.literal("product"),
    facilityKey: keySchema,
    taxRuleKey: keySchema.nullable(),
    /** Present only for a WFC product (1270); older exports omit it. */
    wfc: wfcProductSplitSchema.optional(),
  });
const addonItem = facilityAddonSchema
  .omit({ ...childFields, inventoryItemId: true })
  .extend({
    key: keySchema,
    kind: z.literal("addon"),
    facilityKey: keySchema,
  });
const entitlementItem = z
  .strictObject({
    key: keySchema,
    kind: z.literal("entitlement"),
    facilityKey: keySchema,
    type: z.enum(["min_spend", "tier_benefit"]),
    condition: z.record(z.string(), z.json()),
    sessions: z.number().int().min(1).max(100),
    validity: entitlementRuleSchema.options[0].shape.validity,
    isEnabled: z.boolean(),
  })
  .superRefine((item, ctx) => {
    const condition =
      item.type === "min_spend"
        ? entitlementRuleSchema.options[0].shape.condition
        : entitlementRuleSchema.options[1].shape.condition;
    const parsed = condition.safeParse(item.condition);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({
          code: "custom",
          path: ["condition", ...issue.path],
          message: issue.message,
        });
  });
const planItem = subscriptionPlanSchema
  .omit({ ...childFields, providerPlanId: true })
  .extend({
    key: keySchema,
    kind: z.literal("subscription_plan"),
    facilityKey: keySchema,
  });

export const facilitiesItemSchema = z.discriminatedUnion("kind", [
  facilityItem,
  areaItem,
  unitItem,
  productItem,
  addonItem,
  entitlementItem,
  planItem,
]);
export type FacilitiesConfigItem = z.infer<typeof facilitiesItemSchema>;
export type FacilitiesConfigDraft = FacilitiesConfigItem;
export type FacilitiesConfigRows = {
  facilities: readonly Facility[];
  areas?: readonly FacilityArea[];
  units?: readonly FacilityUnit[];
  products?: readonly FacilityProduct[];
  addons?: readonly FacilityAddon[];
  entitlementRules?: readonly EntitlementRule[];
  subscriptionPlans?: readonly SubscriptionPlan[];
};
export type FacilitiesExportContext = {
  outletKeys: ReadonlyMap<string, string>;
  taxRuleKeys?: ReadonlyMap<string, string>;
};
export type FacilitiesImportContext = {
  outletKeys?: ReadonlySet<string>;
  /** Tax item key to its outlet key; null means a tenant-wide rule. */
  taxRuleOutletKeyByKey?: ReadonlyMap<string, string | null>;
};
export type FacilitiesFromTemplate =
  | { ok: true; drafts: FacilitiesConfigDraft[] }
  | { ok: false; issues: string[] };

// Same portable key convention as tenant-config-types; collisions receive a
// suffix inside the shared section key space, with no source ids in keys.
function configKey(...parts: string[]): string {
  const slug = parts
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
const order = {
  facility: 0,
  area: 1,
  unit: 2,
  product: 3,
  addon: 4,
  entitlement: 5,
  subscription_plan: 6,
} as const;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function fromTemplate(
  items: readonly unknown[],
  ctx: FacilitiesImportContext = {},
): FacilitiesFromTemplate {
  const issues: string[] = [];
  const parsed: FacilitiesConfigItem[] = [];
  const byKey = new Map<string, FacilitiesConfigItem>();
  for (const raw of items) {
    const label = String((raw as { key?: unknown } | null)?.key);
    const result = facilitiesItemSchema.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues)
        issues.push(
          `Facility item ${label}: ${issue.path.join(".") || "item"} ${issue.message}`,
        );
      continue;
    }
    const item = result.data;
    // A template carries configuration, not a previous guest's live session.
    if (item.kind === "unit" && item.status !== "maintenance")
      item.status = "available";
    if (byKey.has(item.key)) {
      issues.push(`Facility item ${item.key}: duplicate key`);
      continue;
    }
    byKey.set(item.key, item);
    parsed.push(item);
  }
  const naturalKeys = new Set<string>();
  for (const item of parsed) {
    const issue = (message: string) =>
      issues.push(`Facility item ${item.key}: ${message}`);
    if (item.kind === "facility") {
      if (ctx.outletKeys && !ctx.outletKeys.has(item.outletKey))
        issue(`outletKey ${item.outletKey} does not exist`);
    } else {
      if (byKey.get(item.facilityKey)?.kind !== "facility")
        issue(`facilityKey ${item.facilityKey} does not name a facility`);
      if (item.kind === "unit") {
        const area = byKey.get(item.areaKey);
        if (area?.kind !== "area")
          issue(`areaKey ${item.areaKey} does not name an area`);
        else if (area.facilityKey !== item.facilityKey)
          issue(`areaKey ${item.areaKey} belongs to another facility`);
      }
      if (
        item.kind === "product" &&
        item.taxRuleKey !== null &&
        ctx.taxRuleOutletKeyByKey
      ) {
        if (!ctx.taxRuleOutletKeyByKey.has(item.taxRuleKey))
          issue(`taxRuleKey ${item.taxRuleKey} does not exist`);
        else {
          const taxOutletKey = ctx.taxRuleOutletKeyByKey.get(item.taxRuleKey);
          const facility = byKey.get(item.facilityKey);
          if (
            taxOutletKey !== null &&
            facility?.kind === "facility" &&
            taxOutletKey !== facility.outletKey
          )
            issue(`taxRuleKey ${item.taxRuleKey} belongs to another outlet`);
        }
      }
    }
    const natural =
      item.kind === "facility"
        ? [item.kind, item.outletKey, item.name]
        : item.kind === "area"
          ? [item.kind, item.facilityKey, item.name]
          : item.kind === "unit"
            ? [item.kind, item.facilityKey, item.code]
            : null;
    if (natural) {
      const key = JSON.stringify(natural);
      if (naturalKeys.has(key))
        issue("duplicate name or code in the same parent");
      naturalKeys.add(key);
    }
  }
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    drafts: parsed.sort(
      (a, b) => order[a.kind] - order[b.kind] || compare(a.key, b.key),
    ),
  };
}

function toTemplate(
  rows: FacilitiesConfigRows,
  ctx: FacilitiesExportContext,
): FacilitiesConfigItem[] {
  const tenantIds = new Set(
    Object.values(rows).flatMap((collection) =>
      (collection ?? []).map((row) => row.tenantId),
    ),
  );
  if (tenantIds.size > 1)
    throw new Error("facilities toTemplate needs rows of one tenant");
  const keys = new Set<string>();
  const unique = (base: string) => {
    let key = base;
    for (let suffix = 2; keys.has(key); suffix++)
      key = configKey(`${base.slice(0, 95)}-${suffix}`);
    keys.add(key);
    return key;
  };
  const facilities = new Map<string, string>();
  const areas = new Map<string, string>();
  const items: FacilitiesConfigItem[] = [];
  for (const row of [...rows.facilities].sort((a, b) => compare(a.id, b.id))) {
    const outletKey = ctx.outletKeys.get(row.outletId);
    if (!outletKey)
      throw new Error(`Facility ${row.name}: outletKey is missing`);
    const key = unique(configKey(outletKey, row.name));
    if (facilities.has(row.id))
      throw new Error("facilities contains a duplicate row id");
    facilities.set(row.id, key);
    items.push({
      kind: "facility",
      key,
      outletKey,
      name: row.name,
      type: row.type,
      sessionMinutes: row.sessionMinutes,
      cleaningMinutes: row.cleaningMinutes,
      arrivalGraceMinutes: row.arrivalGraceMinutes,
      operatingHours: row.operatingHours,
      overtimePolicy: row.overtimePolicy,
      cancellationPolicy: row.cancellationPolicy,
    });
  }
  const facilityKey = (row: { facilityId: string; outletId: string }) => {
    const key = facilities.get(row.facilityId);
    const parent = rows.facilities.find(
      (facility) => facility.id === row.facilityId,
    );
    if (!key || parent?.outletId !== row.outletId)
      throw new Error(
        "Facility child: facility is missing or belongs to another outlet",
      );
    return key;
  };
  for (const row of [...(rows.areas ?? [])].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder ||
      compare(a.name, b.name) ||
      compare(a.id, b.id),
  )) {
    const parent = facilityKey(row);
    const key = unique(configKey(parent, "area", row.name));
    if (areas.has(row.id))
      throw new Error("facilities contains a duplicate area id");
    areas.set(row.id, key);
    items.push({
      kind: "area",
      key,
      facilityKey: parent,
      name: row.name,
      sortOrder: row.sortOrder,
    });
  }
  for (const row of [...(rows.units ?? [])].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder ||
      compare(a.code, b.code) ||
      compare(a.id, b.id),
  )) {
    const parent = facilityKey(row);
    const areaKey = areas.get(row.areaId);
    if (!areaKey) throw new Error(`Facility unit ${row.code}: area is missing`);
    items.push({
      kind: "unit",
      key: unique(configKey(parent, "unit", row.code)),
      facilityKey: parent,
      areaKey,
      code: row.code,
      status: row.status === "maintenance" ? "maintenance" : "available",
      sortOrder: row.sortOrder,
    });
  }
  for (const row of [...(rows.products ?? [])].sort(
    (a, b) =>
      compare(a.type, b.type) || compare(a.name, b.name) || compare(a.id, b.id),
  )) {
    const parent = facilityKey(row);
    const taxRuleKey =
      row.taxRuleId === null ? null : ctx.taxRuleKeys?.get(row.taxRuleId);
    if (taxRuleKey === undefined)
      throw new Error(`Facility product ${row.name}: taxRuleKey is missing`);
    items.push({
      kind: "product",
      key: unique(configKey(parent, "prod", row.name)),
      facilityKey: parent,
      name: row.name,
      type: row.type,
      priceIdr: row.priceIdr,
      sessions: row.sessions,
      isActive: row.isActive,
      taxRuleKey,
      maxPerDay: row.maxPerDay,
    });
  }
  for (const row of [...(rows.addons ?? [])].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder ||
      compare(a.name, b.name) ||
      compare(a.id, b.id),
  )) {
    const parent = facilityKey(row);
    items.push({
      kind: "addon",
      key: unique(configKey(parent, "addon", row.name)),
      facilityKey: parent,
      name: row.name,
      priceIdr: row.priceIdr,
      isEnabled: row.isEnabled,
      sortOrder: row.sortOrder,
    });
  }
  for (const row of [...(rows.entitlementRules ?? [])].sort(
    (a, b) => compare(a.type, b.type) || compare(a.id, b.id),
  )) {
    if (row.type === "package") continue;
    const parent = facilityKey(row);
    items.push({
      kind: "entitlement",
      key: unique(configKey(parent, "ent", row.type)),
      facilityKey: parent,
      type: row.type,
      condition: row.condition,
      sessions: row.sessions,
      validity: row.validity,
      isEnabled: row.isEnabled,
    });
  }
  for (const row of [...(rows.subscriptionPlans ?? [])].sort(
    (a, b) => compare(a.name, b.name) || compare(a.id, b.id),
  )) {
    const parent = facilityKey(row);
    items.push({
      kind: "subscription_plan",
      key: unique(configKey(parent, "plan", row.name)),
      facilityKey: parent,
      name: row.name,
      priceIdr: row.priceIdr,
      quotaPerPeriod: row.quotaPerPeriod,
      interval: row.interval,
      maxPerDay: row.maxPerDay,
      isActive: row.isActive,
    });
  }
  const checked = fromTemplate(items);
  if (!checked.ok) throw new Error(checked.issues.join("; "));
  return checked.drafts;
}

export const facilitiesConfigCodec = {
  section: "facilities",
  version: 1,
  itemSchema: facilitiesItemSchema,
  toTemplate,
  fromTemplate,
} as const;
