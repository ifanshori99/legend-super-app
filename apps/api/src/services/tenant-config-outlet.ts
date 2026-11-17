// TEN-09 (PRD v1.7 §3 F4): outlet-scoped configuration sections of the tenant
// config bundle: floor zones, checklist templates, facilities (with areas,
// units, products, add-ons, entitlement rules, subscription plans) and Wi-Fi
// policies. Items carry no ids: outlets are referenced by `outletKey` (the
// lower-cased outlet code) and sibling rows by `*Key` fields. An item whose
// outlet has no match in the target tenant is skipped with a warning.

import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { idr, type OutletId, type TenantId } from "@starter/shared/core";
import type {
  ChecklistItem,
  ChecklistSchedule,
} from "@starter/shared/operations";
import {
  entitlementRules,
  facilities,
  facilityAddons,
  facilityAreas,
  facilityProducts,
  facilitySubscriptionPlans,
  facilityUnits,
  wifiPolicies,
} from "../db/schema/facility.ts";
import { floorZones } from "../db/schema/floor.ts";
import { opsChecklistTemplates } from "../db/schema/operations.ts";
import { ensureBaselineHoursVersion } from "./facility-hours-versions.service.ts";
import { loadTenantKeyMaps } from "./tenant-config-keys.ts";
import {
  ConfigImportError,
  configKey,
  outletKey,
  uniqueKeys,
  type ExportContext,
  type GenericSectionPayload,
  type ImportContext,
  type SectionHandler,
} from "./tenant-config-types.ts";

// ---------------------------------------------------------------- helpers

type ZoneRow = typeof floorZones.$inferSelect;
type FacilityRow = typeof facilities.$inferSelect;
type UnitRow = typeof facilityUnits.$inferSelect;
type ProductRow = typeof facilityProducts.$inferSelect;
type EntitlementRow = typeof entitlementRules.$inferSelect;
type SubscriptionPlanRow = typeof facilitySubscriptionPlans.$inferSelect;
type ChecklistRow = typeof opsChecklistTemplates.$inferSelect;
type WifiRow = typeof wifiPolicies.$inferSelect;

const asTenant = (tenantId: string) => tenantId as TenantId;
const asOutlet = (id: string) => id as OutletId;

const itemsOf = <T>(payload: unknown): T[] =>
  ((payload as GenericSectionPayload | undefined)?.items ?? []) as T[];

const exported = <T>(items: T[]) =>
  items.length ? { version: 1, items } : undefined;

/** Fail the import with a clear message instead of a raw DB check error. */
function ensure(ok: boolean, message: string): asserts ok {
  if (!ok) throw new ConfigImportError(message);
}

const between = (value: number, min: number, max: number) =>
  Number.isInteger(value) && value >= min && value <= max;

/** One aggregated warning per section for items without a target outlet. */
function outletSkips(label: string, warn: (message: string) => void) {
  const keys = new Set<string>();
  let count = 0;
  return {
    skip(key: string) {
      count += 1;
      keys.add(key);
    },
    flush() {
      if (!count) return;
      const listed = [...keys].sort().slice(0, 10).join(", ");
      warn(
        `${label}: skipped ${count} item(s) for outlet(s) missing in the target tenant (${listed}).`,
      );
    },
  };
}

/** Order-independent JSON for comparing jsonb values. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

// ------------------------------------------------------------------ zones

type ZoneItem = {
  key: string;
  outletKey: string;
  name: string;
  paymentMode: ZoneRow["paymentMode"];
  serviceChargeBp: number;
  minimumSpendIdr: number;
  hours: ZoneRow["hours"];
  status: ZoneRow["status"];
  sortOrder: number;
};

const zonesHandler: SectionHandler = {
  section: "zones",
  async exportSection({ tx, tenantId }: ExportContext) {
    const maps = await loadTenantKeyMaps(tx, tenantId);
    const rows = await tx
      .select()
      .from(floorZones)
      .where(eq(floorZones.tenantId, asTenant(tenantId)))
      .orderBy(asc(floorZones.sortOrder), asc(floorZones.name));
    const items: ZoneItem[] = [];
    for (const row of rows) {
      const code = maps.outletCode.get(row.outletId);
      const key = maps.zone.get(row.id);
      if (!code || !key) continue;
      items.push({
        key,
        outletKey: outletKey(code),
        name: row.name,
        paymentMode: row.paymentMode,
        serviceChargeBp: row.serviceChargeBp,
        minimumSpendIdr: Number(row.minimumSpendIdr),
        hours: row.hours,
        status: row.status,
        sortOrder: row.sortOrder,
      });
    }
    return exported(items);
  },

  async importSection({ tx, tenantId, keys, warn }: ImportContext, payload) {
    const skips = outletSkips("zones", warn);
    for (const item of itemsOf<ZoneItem>(payload)) {
      const outletId = keys.outlets.get(item.outletKey);
      if (!outletId) {
        skips.skip(item.outletKey);
        continue;
      }
      ensure(
        between(item.serviceChargeBp, 0, 10000),
        `Zone "${item.name}": serviceChargeBp must be between 0 and 10000.`,
      );
      ensure(
        item.minimumSpendIdr >= 0,
        `Zone "${item.name}": minimumSpendIdr cannot be negative.`,
      );
      const [existing] = await tx
        .select({ id: floorZones.id })
        .from(floorZones)
        .where(
          and(
            eq(floorZones.tenantId, asTenant(tenantId)),
            eq(floorZones.outletId, asOutlet(outletId)),
            eq(floorZones.name, item.name),
          ),
        )
        .limit(1);
      if (existing) {
        keys.zones.set(item.key, existing.id);
        keys.zoneOutlets.set(item.key, outletId);
        continue;
      }
      const [created] = await tx
        .insert(floorZones)
        .values({
          tenantId: asTenant(tenantId),
          outletId: asOutlet(outletId),
          name: item.name,
          paymentMode: item.paymentMode,
          serviceChargeBp: item.serviceChargeBp,
          minimumSpendIdr: idr(item.minimumSpendIdr),
          hours: item.hours,
          status: item.status,
          sortOrder: item.sortOrder,
        })
        .returning({ id: floorZones.id });
      if (!created) throw new ConfigImportError("Zone insert returned no row.");
      keys.zones.set(item.key, created.id);
      keys.zoneOutlets.set(item.key, outletId);
    }
    skips.flush();
  },
};

// ------------------------------------------------------------- checklists

type ChecklistItemConfig = {
  label: string;
  instruction: string | null;
  requiredEvidence: ChecklistItem["requiredEvidence"];
};

type ChecklistItemBundle = {
  key: string;
  outletKey: string;
  name: string;
  type: ChecklistRow["type"];
  items: ChecklistItemConfig[];
  schedule: { zoneKey: string | null; dueTime: string };
  roleKey: string | null;
};

const checklistsHandler: SectionHandler = {
  section: "checklists",
  async exportSection({ tx, tenantId }: ExportContext) {
    const maps = await loadTenantKeyMaps(tx, tenantId);
    const zoneKeys = maps.zone;
    const roleKeys = maps.role;
    const rows = await tx
      .select()
      .from(opsChecklistTemplates)
      .where(eq(opsChecklistTemplates.tenantId, asTenant(tenantId)))
      .orderBy(
        asc(opsChecklistTemplates.name),
        asc(opsChecklistTemplates.type),
      );
    const unique = uniqueKeys();
    const items: ChecklistItemBundle[] = [];
    for (const row of rows) {
      const code = maps.outletCode.get(row.outletId);
      if (!code) continue;
      const oKey = outletKey(code);
      // Item ids, shift template and station refs are tenant rows: dropped.
      items.push({
        key: unique(configKey(oKey, "chk", row.name)),
        outletKey: oKey,
        name: row.name,
        type: row.type,
        items: row.items.map((item) => ({
          label: item.label,
          instruction: item.instruction,
          requiredEvidence: item.requiredEvidence,
        })),
        schedule: {
          zoneKey: row.schedule.zoneId
            ? (zoneKeys.get(row.schedule.zoneId) ?? null)
            : null,
          dueTime: row.schedule.dueTime,
        },
        roleKey: row.roleId ? (roleKeys.get(row.roleId) ?? null) : null,
      });
    }
    return exported(items);
  },

  async importSection({ tx, tenantId, keys, warn }: ImportContext, payload) {
    const skips = outletSkips("checklists", warn);
    for (const item of itemsOf<ChecklistItemBundle>(payload)) {
      const outletId = keys.outlets.get(item.outletKey);
      if (!outletId) {
        skips.skip(item.outletKey);
        continue;
      }
      ensure(
        between(item.items.length, 1, 100),
        `Checklist "${item.name}": it needs between 1 and 100 items.`,
      );
      const [existing] = await tx
        .select({ id: opsChecklistTemplates.id })
        .from(opsChecklistTemplates)
        .where(
          and(
            eq(opsChecklistTemplates.tenantId, asTenant(tenantId)),
            eq(opsChecklistTemplates.outletId, asOutlet(outletId)),
            eq(opsChecklistTemplates.name, item.name),
            eq(opsChecklistTemplates.type, item.type),
          ),
        )
        .limit(1);
      if (existing) continue;
      let roleId: string | null = null;
      if (item.roleKey) {
        roleId = keys.roles.get(item.roleKey) ?? null;
        if (!roleId)
          warn(
            `checklist ${item.name}: role ${item.roleKey} not imported, open to any role.`,
          );
      }
      const zoneId = item.schedule.zoneKey
        ? keys.needInOutlet("zones", item.schedule.zoneKey, outletId)
        : null;
      await tx.insert(opsChecklistTemplates).values({
        tenantId: asTenant(tenantId),
        outletId: asOutlet(outletId),
        name: item.name,
        type: item.type,
        items: item.items.map((entry) => ({
          id: randomUUID(),
          label: entry.label,
          instruction: entry.instruction,
          requiredEvidence: entry.requiredEvidence,
        })) as ChecklistItem[],
        schedule: {
          shiftTemplateId: null,
          stationId: null,
          zoneId,
          dueTime: item.schedule.dueTime,
        } as ChecklistSchedule,
        roleId,
      });
    }
    skips.flush();
  },
};

// ------------------------------------------------------------- facilities

type FacilityKind =
  | {
      kind: "facility";
      key: string;
      outletKey: string;
      name: string;
      type: FacilityRow["type"];
      sessionMinutes: number;
      cleaningMinutes: number;
      arrivalGraceMinutes: number;
      operatingHours: FacilityRow["operatingHours"];
      overtimePolicy: FacilityRow["overtimePolicy"];
      cancellationPolicy: FacilityRow["cancellationPolicy"];
    }
  | {
      kind: "area";
      key: string;
      facilityKey: string;
      name: string;
      sortOrder: number;
    }
  | {
      kind: "unit";
      key: string;
      facilityKey: string;
      areaKey: string;
      code: string;
      status: UnitRow["status"];
      sortOrder: number;
    }
  | {
      kind: "product";
      key: string;
      facilityKey: string;
      name: string;
      type: ProductRow["type"];
      priceIdr: number;
      sessions: number;
      isActive: boolean;
      taxRuleKey: string | null;
      maxPerDay: number | null;
    }
  | {
      kind: "addon";
      key: string;
      facilityKey: string;
      name: string;
      priceIdr: number;
      isEnabled: boolean;
      sortOrder: number;
    }
  | {
      kind: "entitlement";
      key: string;
      facilityKey: string;
      type: EntitlementRow["type"];
      condition: EntitlementRow["condition"];
      sessions: number;
      validity: EntitlementRow["validity"];
      isEnabled: boolean;
    }
  | {
      kind: "subscription_plan";
      key: string;
      facilityKey: string;
      name: string;
      priceIdr: number;
      quotaPerPeriod: number;
      interval: SubscriptionPlanRow["interval"];
      maxPerDay: number | null;
      isActive: boolean;
    };

type Of<K extends FacilityKind["kind"]> = Extract<FacilityKind, { kind: K }>;

const facilitiesHandler: SectionHandler = {
  section: "facilities",
  async exportSection({ tx, tenantId }: ExportContext) {
    const tid = asTenant(tenantId);
    const maps = await loadTenantKeyMaps(tx, tenantId);
    const codes = maps.outletCode;
    const facilityRows = await tx
      .select()
      .from(facilities)
      .where(eq(facilities.tenantId, tid))
      .orderBy(asc(facilities.createdAt), asc(facilities.id));
    const facilityMap = new Map<string, { key: string; row: FacilityRow }>();
    for (const row of facilityRows) {
      const key = maps.facility.get(row.id);
      if (key) facilityMap.set(row.id, { key, row });
    }
    if (!facilityMap.size) return undefined;
    const unique = uniqueKeys();
    const items: FacilityKind[] = [];

    for (const { key, row } of facilityMap.values()) {
      items.push({
        kind: "facility",
        key,
        outletKey: outletKey(codes.get(row.outletId) ?? ""),
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

    const areaRows = await tx
      .select()
      .from(facilityAreas)
      .where(eq(facilityAreas.tenantId, tid))
      .orderBy(asc(facilityAreas.sortOrder), asc(facilityAreas.name));
    const areaKeys = new Map<string, string>();
    for (const row of areaRows) {
      const facility = facilityMap.get(row.facilityId);
      if (!facility) continue;
      const key = unique(configKey(facility.key, "area", row.name));
      areaKeys.set(row.id, key);
      items.push({
        kind: "area",
        key,
        facilityKey: facility.key,
        name: row.name,
        sortOrder: row.sortOrder,
      });
    }

    // Lock and panic device refs are tenant hardware: dropped. Operational
    // unit states (in use, cleaning) do not travel: only maintenance does.
    const unitRows = await tx
      .select()
      .from(facilityUnits)
      .where(eq(facilityUnits.tenantId, tid))
      .orderBy(asc(facilityUnits.sortOrder), asc(facilityUnits.code));
    for (const row of unitRows) {
      const facility = facilityMap.get(row.facilityId);
      const areaKey = areaKeys.get(row.areaId);
      if (!facility || !areaKey) continue;
      items.push({
        kind: "unit",
        key: unique(configKey(facility.key, "unit", row.code)),
        facilityKey: facility.key,
        areaKey,
        code: row.code,
        status: row.status === "maintenance" ? "maintenance" : "available",
        sortOrder: row.sortOrder,
      });
    }

    // Any version of a rule maps to the key of the tax_rules section; a rule
    // without a published version is not exported, so its key finds no match
    // on import (the product falls back to the default tax with a warning).
    const taxKeys = maps.taxRule;

    const productRows = await tx
      .select()
      .from(facilityProducts)
      .where(eq(facilityProducts.tenantId, tid))
      .orderBy(asc(facilityProducts.type), asc(facilityProducts.name));
    for (const row of productRows) {
      const facility = facilityMap.get(row.facilityId);
      if (!facility) continue;
      items.push({
        kind: "product",
        key: unique(configKey(facility.key, "prod", row.name)),
        facilityKey: facility.key,
        name: row.name,
        type: row.type,
        priceIdr: Number(row.priceIdr),
        sessions: row.sessions,
        isActive: row.isActive,
        taxRuleKey: row.taxRuleId ? (taxKeys.get(row.taxRuleId) ?? null) : null,
        maxPerDay: row.maxPerDay,
      });
    }

    // The inventory item an add-on consumes is a tenant row: dropped.
    const addonRows = await tx
      .select()
      .from(facilityAddons)
      .where(eq(facilityAddons.tenantId, tid))
      .orderBy(asc(facilityAddons.sortOrder), asc(facilityAddons.name));
    for (const row of addonRows) {
      const facility = facilityMap.get(row.facilityId);
      if (!facility) continue;
      items.push({
        kind: "addon",
        key: unique(configKey(facility.key, "addon", row.name)),
        facilityKey: facility.key,
        name: row.name,
        priceIdr: Number(row.priceIdr),
        isEnabled: row.isEnabled,
        sortOrder: row.sortOrder,
      });
    }

    // `package` rules point at a menu item: not portable, not exported.
    const ruleRows = await tx
      .select()
      .from(entitlementRules)
      .where(eq(entitlementRules.tenantId, tid))
      .orderBy(asc(entitlementRules.type), asc(entitlementRules.createdAt));
    for (const row of ruleRows) {
      const facility = facilityMap.get(row.facilityId);
      if (!facility || row.type === "package") continue;
      items.push({
        kind: "entitlement",
        key: unique(configKey(facility.key, "ent", row.type)),
        facilityKey: facility.key,
        type: row.type,
        condition: row.condition,
        sessions: row.sessions,
        validity: row.validity,
        isEnabled: row.isEnabled,
      });
    }

    // The billing provider plan id is an external reference: dropped.
    const planRows = await tx
      .select()
      .from(facilitySubscriptionPlans)
      .where(eq(facilitySubscriptionPlans.tenantId, tid))
      .orderBy(asc(facilitySubscriptionPlans.name));
    for (const row of planRows) {
      const facility = facilityMap.get(row.facilityId);
      if (!facility) continue;
      items.push({
        kind: "subscription_plan",
        key: unique(configKey(facility.key, "plan", row.name)),
        facilityKey: facility.key,
        name: row.name,
        priceIdr: Number(row.priceIdr),
        quotaPerPeriod: row.quotaPerPeriod,
        interval: row.interval,
        maxPerDay: row.maxPerDay,
        isActive: row.isActive,
      });
    }

    return exported(items);
  },

  async importSection({ tx, tenantId, keys, warn }: ImportContext, payload) {
    const tid = asTenant(tenantId);
    const all = itemsOf<FacilityKind>(payload);
    const byKind = <K extends FacilityKind["kind"]>(kind: K) =>
      all.filter((item): item is Of<K> => item.kind === kind);
    const skips = outletSkips("facilities", warn);
    // Facility key → target facility id/outlet; skipped keys drop their children.
    const placed = new Map<string, { id: string; outletId: string }>();
    // Target facility id → the first source facility key mapped onto it.
    const claimed = new Map<string, string>();
    const skippedFacilities = new Set<string>();

    for (const item of byKind("facility")) {
      const outletId = keys.outlets.get(item.outletKey);
      if (!outletId) {
        skips.skip(item.outletKey);
        skippedFacilities.add(item.key);
        continue;
      }
      ensure(
        between(item.sessionMinutes, 1, 480) &&
          between(item.cleaningMinutes, 0, 240) &&
          between(item.arrivalGraceMinutes, 0, 1440) &&
          item.sessionMinutes + item.cleaningMinutes <= 720,
        `Facility "${item.name}": sessionMinutes must be 1-480, cleaningMinutes 0-240, arrivalGraceMinutes 0-1440 and session plus cleaning at most 720.`,
      );
      const [existing] = await tx
        .select({ id: facilities.id })
        .from(facilities)
        .where(
          and(
            eq(facilities.tenantId, tid),
            eq(facilities.outletId, asOutlet(outletId)),
            eq(facilities.name, item.name),
          ),
        )
        .limit(1);
      let id = existing?.id;
      if (!id) {
        const [created] = await tx
          .insert(facilities)
          .values({
            tenantId: tid,
            outletId: asOutlet(outletId),
            name: item.name,
            type: item.type,
            sessionMinutes: item.sessionMinutes,
            cleaningMinutes: item.cleaningMinutes,
            arrivalGraceMinutes: item.arrivalGraceMinutes,
            operatingHours: item.operatingHours,
            overtimePolicy: item.overtimePolicy,
            cancellationPolicy: item.cancellationPolicy,
          })
          .returning({ id: facilities.id });
        if (!created)
          throw new ConfigImportError("Facility insert returned no row.");
        id = created.id;
        await ensureBaselineHoursVersion(tx, {
          tenantId: tid,
          outletId: asOutlet(outletId),
          facilityId: id,
          operatingHours: item.operatingHours,
        });
      }
      const claimedBy = claimed.get(id);
      if (claimedBy)
        warn(
          `facilities: "${item.key}" and "${claimedBy}" share the name "${item.name}" in one outlet; both map to the same target facility.`,
        );
      else claimed.set(id, item.key);
      keys.facilities.set(item.key, id);
      keys.facilityOutlets.set(item.key, outletId);
      placed.set(item.key, { id, outletId });
    }

    /** Resolve a child's facility; `null` = its outlet was skipped. */
    const facilityOf = (facilityKey: string) => {
      if (skippedFacilities.has(facilityKey)) return null;
      const target = placed.get(facilityKey);
      if (!target)
        throw new ConfigImportError(
          `Unknown facilities reference "${facilityKey}" in the bundle.`,
        );
      return target;
    };

    for (const item of byKind("area")) {
      const facility = facilityOf(item.facilityKey);
      if (!facility) continue;
      ensure(
        item.sortOrder >= 0,
        `Area "${item.name}": sortOrder cannot be negative.`,
      );
      const [existing] = await tx
        .select({ id: facilityAreas.id })
        .from(facilityAreas)
        .where(
          and(
            eq(facilityAreas.tenantId, tid),
            eq(facilityAreas.facilityId, facility.id),
            eq(facilityAreas.name, item.name),
          ),
        )
        .limit(1);
      if (existing) {
        keys.facilityAreas.set(item.key, existing.id);
        continue;
      }
      const [created] = await tx
        .insert(facilityAreas)
        .values({
          tenantId: tid,
          outletId: asOutlet(facility.outletId),
          facilityId: facility.id,
          name: item.name,
          sortOrder: item.sortOrder,
        })
        .returning({ id: facilityAreas.id });
      if (!created)
        throw new ConfigImportError("Facility area insert returned no row.");
      keys.facilityAreas.set(item.key, created.id);
    }

    for (const item of byKind("unit")) {
      const facility = facilityOf(item.facilityKey);
      if (!facility) continue;
      ensure(
        item.sortOrder >= 0,
        `Unit "${item.code}": sortOrder cannot be negative.`,
      );
      const [existing] = await tx
        .select({ id: facilityUnits.id })
        .from(facilityUnits)
        .where(
          and(
            eq(facilityUnits.tenantId, tid),
            eq(facilityUnits.facilityId, facility.id),
            eq(facilityUnits.code, item.code),
          ),
        )
        .limit(1);
      if (existing) continue;
      await tx.insert(facilityUnits).values({
        tenantId: tid,
        outletId: asOutlet(facility.outletId),
        facilityId: facility.id,
        areaId: keys.need("facilityAreas", item.areaKey),
        code: item.code,
        status: item.status,
        sortOrder: item.sortOrder,
      });
    }

    for (const item of byKind("product")) {
      const facility = facilityOf(item.facilityKey);
      if (!facility) continue;
      ensure(
        item.priceIdr >= 0 &&
          between(item.sessions, 1, 100) &&
          (item.maxPerDay === null || between(item.maxPerDay, 1, 10)),
        `Product "${item.name}": priceIdr must be >= 0, sessions 1-100 and maxPerDay empty or 1-10.`,
      );
      const [existing] = await tx
        .select({ id: facilityProducts.id })
        .from(facilityProducts)
        .where(
          and(
            eq(facilityProducts.tenantId, tid),
            eq(facilityProducts.facilityId, facility.id),
            eq(facilityProducts.name, item.name),
            eq(facilityProducts.type, item.type),
          ),
        )
        .limit(1);
      if (existing) continue;
      let taxRuleId: string | null = null;
      if (item.taxRuleKey) {
        taxRuleId = keys.taxRules.get(item.taxRuleKey) ?? null;
        if (!taxRuleId)
          warn(
            `product ${item.name}: tax rule ${item.taxRuleKey} not imported, default tax applies.`,
          );
      }
      await tx.insert(facilityProducts).values({
        tenantId: tid,
        outletId: asOutlet(facility.outletId),
        facilityId: facility.id,
        name: item.name,
        type: item.type,
        priceIdr: idr(item.priceIdr),
        taxRuleId,
        sessions: item.sessions,
        maxPerDay: item.maxPerDay,
        isActive: item.isActive,
      });
    }

    for (const item of byKind("addon")) {
      const facility = facilityOf(item.facilityKey);
      if (!facility) continue;
      ensure(
        item.priceIdr >= 0 && item.sortOrder >= 0,
        `Add-on "${item.name}": priceIdr and sortOrder cannot be negative.`,
      );
      const [existing] = await tx
        .select({ id: facilityAddons.id })
        .from(facilityAddons)
        .where(
          and(
            eq(facilityAddons.tenantId, tid),
            eq(facilityAddons.facilityId, facility.id),
            eq(facilityAddons.name, item.name),
          ),
        )
        .limit(1);
      if (existing) continue;
      await tx.insert(facilityAddons).values({
        tenantId: tid,
        outletId: asOutlet(facility.outletId),
        facilityId: facility.id,
        name: item.name,
        priceIdr: idr(item.priceIdr),
        isEnabled: item.isEnabled,
        sortOrder: item.sortOrder,
      });
    }

    for (const item of byKind("entitlement")) {
      const facility = facilityOf(item.facilityKey);
      if (!facility) continue;
      if (item.type === "package") {
        warn(
          `facilities: skipped entitlement "${item.key}" (package rules need a menu item).`,
        );
        continue;
      }
      ensure(
        between(item.sessions, 1, 100),
        `Entitlement "${item.key}": sessions must be between 1 and 100.`,
      );
      // No natural key: the same type, sessions, condition, validity and state.
      const sameFacility = await tx
        .select()
        .from(entitlementRules)
        .where(
          and(
            eq(entitlementRules.tenantId, tid),
            eq(entitlementRules.facilityId, facility.id),
            eq(entitlementRules.type, item.type),
          ),
        );
      const fingerprint = canonical([
        item.sessions,
        item.condition,
        item.validity,
        item.isEnabled,
      ]);
      if (
        sameFacility.some(
          (row) =>
            canonical([
              row.sessions,
              row.condition,
              row.validity,
              row.isEnabled,
            ]) === fingerprint,
        )
      )
        continue;
      await tx.insert(entitlementRules).values({
        id: randomUUID(),
        tenantId: tid,
        outletId: asOutlet(facility.outletId),
        facilityId: facility.id,
        type: item.type,
        condition: item.condition,
        sessions: item.sessions,
        validity: item.validity,
        isEnabled: item.isEnabled,
      });
    }

    for (const item of byKind("subscription_plan")) {
      const facility = facilityOf(item.facilityKey);
      if (!facility) continue;
      ensure(
        item.priceIdr >= 0 &&
          between(item.quotaPerPeriod, 1, 100) &&
          (item.maxPerDay === null || between(item.maxPerDay, 1, 10)),
        `Subscription plan "${item.name}": priceIdr must be >= 0, quotaPerPeriod 1-100 and maxPerDay empty or 1-10.`,
      );
      const [existing] = await tx
        .select({ id: facilitySubscriptionPlans.id })
        .from(facilitySubscriptionPlans)
        .where(
          and(
            eq(facilitySubscriptionPlans.tenantId, tid),
            eq(facilitySubscriptionPlans.facilityId, facility.id),
            eq(facilitySubscriptionPlans.name, item.name),
          ),
        )
        .limit(1);
      if (existing) continue;
      await tx.insert(facilitySubscriptionPlans).values({
        tenantId: tid,
        outletId: asOutlet(facility.outletId),
        facilityId: facility.id,
        name: item.name,
        priceIdr: idr(item.priceIdr),
        quotaPerPeriod: item.quotaPerPeriod,
        interval: item.interval,
        maxPerDay: item.maxPerDay,
        isActive: item.isActive,
      });
    }

    skips.flush();
  },
};

// --------------------------------------------------------- wifi policies

type WifiItem = {
  key: string;
  outletKey: string;
  zoneKey: string;
  facilityKey: string | null;
  freeMinutes: number;
  peakFreeMinutes: number;
  spendPerExtraHourIdr: number;
  extraMinutes: number;
  maxDevices: number;
  peakSchedule: WifiRow["peakSchedule"];
  baseSpeedKbps: number;
  fullSpeedKbps: number;
  minSpendPerHourIdr: number | null;
  tierBonusMinutes: WifiRow["tierBonusMinutes"];
  // legend-9k0a5: null or absent keeps the column default.
  spendMode?: WifiRow["spendMode"];
};

const wifiPoliciesHandler: SectionHandler = {
  section: "wifi_policies",
  async exportSection({ tx, tenantId }: ExportContext) {
    const maps = await loadTenantKeyMaps(tx, tenantId);
    const rows = await tx
      .select()
      .from(wifiPolicies)
      .where(eq(wifiPolicies.tenantId, asTenant(tenantId)))
      .orderBy(asc(wifiPolicies.createdAt), asc(wifiPolicies.id));
    const unique = uniqueKeys();
    const items: WifiItem[] = [];
    for (const row of rows) {
      const code = maps.outletCode.get(row.outletId);
      const zoneKey = maps.zone.get(row.zoneId);
      // A policy whose zone is gone cannot be re-bound: not exported.
      if (!code || !zoneKey) continue;
      const oKey = outletKey(code);
      items.push({
        key: unique(configKey(oKey, "wifi", zoneKey)),
        outletKey: oKey,
        zoneKey,
        facilityKey: row.facilityId
          ? (maps.facility.get(row.facilityId) ?? null)
          : null,
        freeMinutes: row.freeMinutes,
        peakFreeMinutes: row.peakFreeMinutes,
        spendPerExtraHourIdr: Number(row.spendPerExtraHourIdr),
        extraMinutes: row.extraMinutes,
        maxDevices: row.maxDevices,
        peakSchedule: row.peakSchedule,
        baseSpeedKbps: row.baseSpeedKbps,
        fullSpeedKbps: row.fullSpeedKbps,
        minSpendPerHourIdr:
          row.minSpendPerHourIdr === null
            ? null
            : Number(row.minSpendPerHourIdr),
        tierBonusMinutes: row.tierBonusMinutes,
        spendMode: row.spendMode,
      });
    }
    return exported(items);
  },

  async importSection({ tx, tenantId, keys, warn }: ImportContext, payload) {
    const tid = asTenant(tenantId);
    const skips = outletSkips("wifi_policies", warn);
    for (const item of itemsOf<WifiItem>(payload)) {
      const outletId = keys.outlets.get(item.outletKey);
      if (!outletId) {
        skips.skip(item.outletKey);
        continue;
      }
      ensure(
        item.freeMinutes >= 0 &&
          item.peakFreeMinutes >= 0 &&
          item.spendPerExtraHourIdr >= 0 &&
          between(item.extraMinutes, 1, 1440) &&
          between(item.maxDevices, 1, 20) &&
          item.baseSpeedKbps >= 1 &&
          item.fullSpeedKbps >= 1 &&
          (item.minSpendPerHourIdr === null || item.minSpendPerHourIdr >= 0),
        `Wi-Fi policy "${item.key}": a value is outside the allowed range (minutes >= 0, extraMinutes 1-1440, maxDevices 1-20, speeds >= 1, amounts >= 0).`,
      );
      const zoneId = keys.needInOutlet("zones", item.zoneKey, outletId);
      const facilityId = item.facilityKey
        ? keys.needInOutlet("facilities", item.facilityKey, outletId)
        : null;
      const [existing] = await tx
        .select({ id: wifiPolicies.id })
        .from(wifiPolicies)
        .where(
          and(
            eq(wifiPolicies.tenantId, tid),
            eq(wifiPolicies.outletId, asOutlet(outletId)),
            eq(wifiPolicies.zoneId, zoneId),
          ),
        )
        .limit(1);
      if (existing) continue;
      await tx.insert(wifiPolicies).values({
        id: randomUUID(),
        tenantId: tid,
        outletId: asOutlet(outletId),
        zoneId,
        facilityId,
        freeMinutes: item.freeMinutes,
        peakFreeMinutes: item.peakFreeMinutes,
        spendPerExtraHourIdr: idr(item.spendPerExtraHourIdr),
        extraMinutes: item.extraMinutes,
        maxDevices: item.maxDevices,
        peakSchedule: item.peakSchedule,
        baseSpeedKbps: item.baseSpeedKbps,
        fullSpeedKbps: item.fullSpeedKbps,
        minSpendPerHourIdr:
          item.minSpendPerHourIdr === null
            ? null
            : idr(item.minSpendPerHourIdr),
        tierBonusMinutes: item.tierBonusMinutes,
        spendMode: item.spendMode ?? undefined,
      });
    }
    skips.flush();
  },
};

/** Import order is set by the orchestrator, not by this array. */
export const outletSectionHandlers: SectionHandler[] = [
  zonesHandler,
  checklistsHandler,
  facilitiesHandler,
  wifiPoliciesHandler,
];
