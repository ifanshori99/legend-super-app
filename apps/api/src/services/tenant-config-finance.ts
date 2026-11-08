// TEN-09: finance sections of a tenant config bundle (chart of accounts, tax
// rules + calculation options, service-charge rules). Exports carry keys only
// (no ids, audit columns or timestamps); imports are idempotent and run inside
// the orchestrator's single transaction (tenant-config.service.ts).

import { and, asc, desc, eq, isNull } from "drizzle-orm";
import {
  REPORT_GROUPS,
  type AccountType,
  type PostingAccountRole,
  type ReportGroup,
} from "@starter/shared/accounting";
import {
  DEFAULT_BUSINESS_DAY_CLOCK,
  businessDateOf,
  type BusinessDayClock,
  type OutletId,
  type TenantId,
  type UserId,
} from "@starter/shared/core";
import type { ItemTaxClass, TaxChannel } from "@starter/shared/tax";
import {
  accountMappings,
  chartOfAccounts,
  legalEntities,
  outlets,
  serviceChargeRules,
  taxRules,
  taxSettings,
} from "../db/schema/index.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";
import { loadTenantKeyMaps } from "./tenant-config-keys.ts";
import {
  ConfigImportError,
  accountConfigKey,
  configKey,
  outletKey,
  taxRuleConfigKey,
  uniqueKeys,
  type ConfigTx,
  type ExportContext,
  type GenericSectionPayload,
  type ImportContext,
  type SectionHandler,
} from "./tenant-config-types.ts";

type TaxSettingsRow = typeof taxSettings.$inferSelect;
type TaxRuleRow = typeof taxRules.$inferSelect;

// ---- shared helpers -------------------------------------------------------

function itemsOf<T>(payload: unknown): T[] {
  const items = (payload as GenericSectionPayload | undefined)?.items;
  return Array.isArray(items) ? (items as unknown as T[]) : [];
}

/** Reject an item that would violate a DB check constraint (clear 422). */
function ensure(ok: boolean, what: string, message: string): void {
  if (!ok) throw new ConfigImportError(`Invalid ${what}: ${message}.`);
}

const ROUNDING_MODES = ["half_up", "half_even", "down", "floor", "ceil"];
const isRateBp = (value: unknown) =>
  Number.isInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= 10000;

/** First row per (outlet | tenant-wide, code) of rows sorted version desc. */
function latestPerKey<
  T extends { outletId: string | null; code: string; version: number },
>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const id = `${row.outletId ?? ""}|${row.code}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

/** Business date "today" in the outlet's clock (tenant-wide: Asia/Jakarta). */
function clockFor(
  outletId: string | null,
  clocks: Map<string, BusinessDayClock>,
): BusinessDayClock {
  return (outletId && clocks.get(outletId)) || DEFAULT_BUSINESS_DAY_CLOCK;
}

async function targetOutletClocks(
  tx: ConfigTx,
  tenantId: string,
): Promise<Map<string, BusinessDayClock>> {
  const rows = await tx
    .select({
      id: outlets.id,
      timezone: outlets.timezone,
      businessDayCutoff: outlets.businessDayCutoff,
    })
    .from(outlets)
    .where(eq(outlets.tenantId, tenantId));
  return new Map(rows.map((row) => [row.id, outletBusinessDayClock(row)]));
}

/**
 * Resolve the target outlet of an item (`null` outletKey = tenant-wide).
 * `undefined` = the bundle outlet has no target outlet: caller skips.
 */
function resolveOutlet(
  input: ImportContext,
  item: { outletKey: string | null },
  what: string,
): OutletId | null | undefined {
  if (item.outletKey === null) return null;
  const id = input.keys.outlets.get(item.outletKey);
  if (!id)
    input.warn(
      `Skipped ${what}: no outlet with code "${item.outletKey}" in the target tenant.`,
    );
  return id as OutletId | undefined;
}

// ---- chart_of_accounts ----------------------------------------------------

type AccountItem = {
  key: string;
  kind: "account";
  code: string;
  name: string;
  type: AccountType;
  reportGroup: ReportGroup;
  parentKey: string | null;
  isActive: boolean;
};
type MappingItem = {
  key: string;
  kind: "mapping";
  role: PostingAccountRole;
  accountKey: string;
};

async function exportChartOfAccounts(
  input: ExportContext,
): Promise<GenericSectionPayload | undefined> {
  const { tx, tenantId } = input;
  // Item shapes carry no legal entity: export the oldest one's chart.
  const [entity] = await tx
    .select({ id: legalEntities.id })
    .from(legalEntities)
    .where(eq(legalEntities.tenantId, tenantId))
    .orderBy(asc(legalEntities.createdAt), asc(legalEntities.id))
    .limit(1);
  if (!entity) return undefined;

  const accounts = await tx
    .select()
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.tenantId, tenantId),
        eq(chartOfAccounts.legalEntityId, entity.id),
      ),
    )
    .orderBy(asc(chartOfAccounts.code));
  if (accounts.length === 0) return undefined;
  // Codes are sorted, so `1-100` / `1.100` (same slug) get stable distinct keys.
  const accountKey = uniqueKeys();
  const keyById = new Map(
    accounts.map((row) => [row.id, accountKey(accountConfigKey(row.code))]),
  );

  const items: Array<AccountItem | MappingItem> = accounts.map((row) => ({
    key: keyById.get(row.id)!,
    kind: "account",
    code: row.code,
    name: row.name,
    type: row.type,
    reportGroup: row.reportGroup,
    parentKey: (row.parentId && keyById.get(row.parentId)) || null,
    isActive: row.isActive,
  }));

  const mappings = await tx
    .select()
    .from(accountMappings)
    .where(
      and(
        eq(accountMappings.tenantId, tenantId),
        eq(accountMappings.legalEntityId, entity.id),
      ),
    )
    .orderBy(asc(accountMappings.role));
  for (const row of mappings) {
    const accountKeyOfRole = keyById.get(row.accountId);
    if (!accountKeyOfRole) continue;
    items.push({
      key: configKey("map", row.role),
      kind: "mapping",
      role: row.role,
      accountKey: accountKeyOfRole,
    });
  }
  return { version: 1, items };
}

async function importChartOfAccounts(
  input: ImportContext,
  payload: unknown,
): Promise<void> {
  const items = itemsOf<AccountItem | MappingItem>(payload);
  const accounts = items.filter(
    (item): item is AccountItem => item.kind === "account",
  );
  const mappings = items.filter(
    (item): item is MappingItem => item.kind === "mapping",
  );
  if (accounts.length === 0 && mappings.length === 0) return;

  const { tx, tenantId, keys } = input;
  const entities = await tx
    .select({ id: legalEntities.id })
    .from(legalEntities)
    .where(eq(legalEntities.tenantId, tenantId))
    .orderBy(asc(legalEntities.createdAt), asc(legalEntities.id));
  if (entities.length === 0) {
    input.warn(
      "Skipped chart_of_accounts: the target tenant has no legal entity.",
    );
    return;
  }

  const byKey = new Map(accounts.map((item) => [item.key, item]));
  for (const item of accounts) {
    const what = `account "${item.code}"`;
    ensure(
      /^[0-9]{1,10}([.-][0-9]{1,10}){0,4}$/.test(item.code),
      what,
      "code must be digits separated by . or -",
    );
    ensure(
      REPORT_GROUPS[item.reportGroup] === item.type,
      what,
      `report group "${item.reportGroup}" does not match type "${item.type}"`,
    );
    ensure(
      item.parentKey !== item.key,
      what,
      "an account cannot be its own parent",
    );
  }
  // Depth = number of ancestors; parents are inserted level by level.
  const depthOf = new Map<string, number>();
  for (const item of accounts) {
    let depth = 0;
    const trail = new Set<string>();
    for (let cur = item; cur.parentKey !== null; depth++) {
      if (trail.has(cur.key))
        throw new ConfigImportError(
          `Chart of accounts has a parent cycle at "${cur.key}".`,
        );
      trail.add(cur.key);
      const parent = byKey.get(cur.parentKey);
      if (!parent)
        throw new ConfigImportError(
          `Unknown parent account reference "${cur.parentKey}" in the bundle.`,
        );
      cur = parent;
    }
    depthOf.set(item.key, depth);
  }
  const maxDepth = Math.max(-1, ...depthOf.values());

  let first = true;
  for (const entity of entities) {
    const existing = await tx
      .select({ id: chartOfAccounts.id, code: chartOfAccounts.code })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.tenantId, tenantId),
          eq(chartOfAccounts.legalEntityId, entity.id),
        ),
      );
    const idByCode = new Map(existing.map((row) => [row.code, row.id]));

    // Level by level so a child sees its parent's new id.
    for (let level = 0; level <= maxDepth; level++) {
      const batch = accounts.filter(
        (item) => depthOf.get(item.key) === level && !idByCode.has(item.code),
      );
      if (batch.length === 0) continue;
      const inserted = await tx
        .insert(chartOfAccounts)
        .values(
          batch.map((item) => ({
            tenantId,
            legalEntityId: entity.id,
            code: item.code,
            name: item.name,
            type: item.type,
            reportGroup: item.reportGroup,
            parentId:
              item.parentKey === null
                ? null
                : (idByCode.get(byKey.get(item.parentKey)!.code) ?? null),
            isActive: item.isActive,
          })),
        )
        .returning({ id: chartOfAccounts.id, code: chartOfAccounts.code });
      for (const row of inserted) idByCode.set(row.code, row.id);
    }

    if (first) {
      // Later sections resolve account keys against the first entity's copy.
      for (const item of accounts) {
        const id = idByCode.get(item.code);
        if (id) keys.accounts.set(item.key, id);
      }
    }
    first = false;

    const mapped = await tx
      .select({ role: accountMappings.role })
      .from(accountMappings)
      .where(
        and(
          eq(accountMappings.tenantId, tenantId),
          eq(accountMappings.legalEntityId, entity.id),
        ),
      );
    const haveRole = new Set<string>(mapped.map((row) => row.role));
    const missing = mappings.filter((item) => !haveRole.has(item.role));
    if (missing.length === 0) continue;
    await tx.insert(accountMappings).values(
      missing.map((item) => {
        const account = byKey.get(item.accountKey);
        const accountId = account && idByCode.get(account.code);
        if (!accountId)
          throw new ConfigImportError(
            `Unknown account reference "${item.accountKey}" in mapping "${item.role}".`,
          );
        return {
          tenantId,
          legalEntityId: entity.id,
          role: item.role,
          accountId,
        };
      }),
    );
  }
}

// ---- tax_rules ------------------------------------------------------------

type TaxRuleItem = {
  key: string;
  kind: "rule";
  outletKey: string | null;
  code: string;
  name: string;
  taxType: TaxRuleRow["taxType"];
  rateBp: number;
  regionCode: string | null;
  channels: TaxChannel[];
  appliesTo: { itemClasses: ItemTaxClass[] } & Record<string, unknown>;
  priceIncludesTax: boolean;
  includeServiceInBase: boolean;
  isActive: boolean;
};
type TaxSettingsItem = {
  key: string;
  kind: "settings";
  outletKey: string | null;
  calculationOrder: TaxSettingsRow["calculationOrder"];
  pricesIncludeTax: boolean;
  serviceRoundingMode: TaxSettingsRow["serviceRoundingMode"];
  taxRoundingMode: TaxSettingsRow["taxRoundingMode"];
  inclusiveBaseRoundingMode: TaxSettingsRow["inclusiveBaseRoundingMode"];
  billRounding: TaxSettingsRow["billRounding"];
  packageAllocation: TaxSettingsRow["packageAllocation"];
};

async function exportTaxRules(
  input: ExportContext,
): Promise<GenericSectionPayload | undefined> {
  const { tx } = input;
  const tenantId = input.tenantId as TenantId;
  const { outletCode: codes, taxRule: ruleKeyById } = await loadTenantKeyMaps(
    tx,
    tenantId,
  );
  const items: Array<TaxRuleItem | TaxSettingsItem> = [];

  const rules = latestPerKey(
    await tx
      .select()
      .from(taxRules)
      .where(
        and(eq(taxRules.tenantId, tenantId), eq(taxRules.status, "published")),
      )
      .orderBy(desc(taxRules.version)),
  );
  for (const row of rules) {
    const code = row.outletId ? codes.get(row.outletId) : null;
    if (row.outletId && !code) continue;
    // Menu item / category ids never travel; a rule that applies only to
    // those has nothing portable left (the contract needs one class).
    if (row.appliesTo.itemClasses.length === 0) continue;
    const key = ruleKeyById.get(row.id);
    if (!key) continue;
    items.push({
      key,
      kind: "rule",
      outletKey: code ? outletKey(code) : null,
      code: row.code,
      name: row.name,
      taxType: row.taxType,
      rateBp: row.rateBp,
      regionCode: row.regionCode,
      channels: row.channels,
      // Category / menu-item targets are menu data and do not travel.
      appliesTo: { itemClasses: row.appliesTo.itemClasses },
      priceIncludesTax: row.priceIncludesTax,
      includeServiceInBase: row.includeServiceInBase,
      isActive: row.isActive,
    });
  }

  const seenSettings = new Set<string>();
  const settings = await tx
    .select()
    .from(taxSettings)
    .where(
      and(
        eq(taxSettings.tenantId, tenantId),
        eq(taxSettings.status, "published"),
      ),
    )
    .orderBy(desc(taxSettings.version));
  for (const row of settings) {
    const scope = row.outletId ?? "";
    if (seenSettings.has(scope)) continue;
    seenSettings.add(scope);
    const code = row.outletId ? codes.get(row.outletId) : null;
    if (row.outletId && !code) continue;
    items.push({
      key: configKey("settings", code ? outletKey(code) : "tenant"),
      kind: "settings",
      outletKey: code ? outletKey(code) : null,
      calculationOrder: row.calculationOrder,
      pricesIncludeTax: row.pricesIncludeTax,
      serviceRoundingMode: row.serviceRoundingMode,
      taxRoundingMode: row.taxRoundingMode,
      inclusiveBaseRoundingMode: row.inclusiveBaseRoundingMode,
      billRounding: row.billRounding,
      packageAllocation: row.packageAllocation,
    });
  }
  return items.length > 0 ? { version: 1, items } : undefined;
}

async function importTaxRules(
  input: ImportContext,
  payload: unknown,
): Promise<void> {
  const items = itemsOf<TaxRuleItem | TaxSettingsItem>(payload);
  if (items.length === 0) return;
  const { tx, keys, actorUserId, now } = input;
  const tenantId = input.tenantId as TenantId;
  const clocks = await targetOutletClocks(tx, tenantId);
  const today = (outletId: string | null) =>
    businessDateOf(now, clockFor(outletId, clocks));

  for (const item of items) {
    if (item.kind === "rule") {
      const outletId = resolveOutlet(input, item, `tax rule "${item.key}"`);
      if (outletId === undefined) continue;
      const what = `tax rule "${item.code}"`;
      ensure(
        ["pbjt", "ppn", "other"].includes(item.taxType),
        what,
        `unknown tax type "${item.taxType}"`,
      );
      ensure(isRateBp(item.rateBp), what, "rateBp must be an integer 0..10000");
      ensure(Array.isArray(item.channels), what, "channels must be a list");
      ensure(
        Array.isArray(item.appliesTo?.itemClasses) &&
          item.appliesTo.itemClasses.length > 0,
        what,
        "appliesTo.itemClasses needs at least one class",
      );
      const [existing] = await tx
        .select({ id: taxRules.id })
        .from(taxRules)
        .where(
          and(
            eq(taxRules.tenantId, tenantId),
            eq(taxRules.code, item.code),
            outletId === null
              ? isNull(taxRules.outletId)
              : eq(taxRules.outletId, outletId),
          ),
        )
        .orderBy(desc(taxRules.version))
        .limit(1);
      if (existing) {
        keys.taxRules.set(item.key, existing.id);
        continue;
      }
      const [row] = await tx
        .insert(taxRules)
        .values({
          tenantId,
          outletId,
          code: item.code,
          name: item.name,
          taxType: item.taxType,
          rateBp: item.rateBp,
          regionCode: item.regionCode,
          channels: item.channels,
          appliesTo: {
            itemClasses: item.appliesTo.itemClasses,
            categoryIds: [],
            itemIds: [],
          },
          priceIncludesTax: item.priceIncludesTax,
          includeServiceInBase: item.includeServiceInBase,
          isActive: item.isActive,
          version: 1,
          effectiveFrom: today(outletId),
          status: "published",
          publishedAt: now,
          publishedBy: actorUserId as UserId,
        })
        .returning({ id: taxRules.id });
      keys.taxRules.set(item.key, row!.id);
    } else {
      const outletId = resolveOutlet(input, item, `tax settings "${item.key}"`);
      if (outletId === undefined) continue;
      const what = `tax settings "${item.key}"`;
      ensure(
        item.calculationOrder === "discount_service_tax",
        what,
        `unknown calculation order "${item.calculationOrder}"`,
      );
      for (const mode of [
        item.serviceRoundingMode,
        item.taxRoundingMode,
        item.inclusiveBaseRoundingMode,
      ])
        ensure(
          ROUNDING_MODES.includes(mode),
          what,
          `unknown rounding mode "${mode}"`,
        );
      ensure(
        ["fixed_bp", "standalone_price_ratio"].includes(item.packageAllocation),
        what,
        `unknown package allocation "${item.packageAllocation}"`,
      );
      ensure(
        item.billRounding === null ||
          item.billRounding === undefined ||
          (typeof item.billRounding === "object" &&
            !Array.isArray(item.billRounding)),
        what,
        "billRounding must be an object or null",
      );
      const [existing] = await tx
        .select({ id: taxSettings.id })
        .from(taxSettings)
        .where(
          and(
            eq(taxSettings.tenantId, tenantId),
            outletId === null
              ? isNull(taxSettings.outletId)
              : eq(taxSettings.outletId, outletId),
          ),
        )
        .limit(1);
      if (existing) continue;
      await tx.insert(taxSettings).values({
        tenantId,
        outletId,
        calculationOrder: item.calculationOrder,
        pricesIncludeTax: item.pricesIncludeTax,
        serviceRoundingMode: item.serviceRoundingMode,
        taxRoundingMode: item.taxRoundingMode,
        inclusiveBaseRoundingMode: item.inclusiveBaseRoundingMode,
        billRounding: item.billRounding,
        packageAllocation: item.packageAllocation,
        version: 1,
        effectiveFrom: today(outletId),
        status: "published",
        publishedAt: now,
        publishedBy: actorUserId as UserId,
      });
    }
  }
}

// ---- service_charge_rules -------------------------------------------------

type ServiceChargeItem = {
  key: string;
  outletKey: string | null;
  code: string;
  name: string;
  rateBp: number;
  zoneKey: string | null;
  orderTypes: TaxChannel[];
  itemClasses: ItemTaxClass[];
  isActive: boolean;
};

async function exportServiceChargeRules(
  input: ExportContext,
): Promise<GenericSectionPayload | undefined> {
  const { tx } = input;
  const tenantId = input.tenantId as TenantId;
  const {
    outletCode: codes,
    zone: zoneKeyById,
    zoneOutlet,
  } = await loadTenantKeyMaps(tx, tenantId);

  const rules = latestPerKey(
    await tx
      .select()
      .from(serviceChargeRules)
      .where(
        and(
          eq(serviceChargeRules.tenantId, tenantId),
          eq(serviceChargeRules.status, "published"),
        ),
      )
      .orderBy(desc(serviceChargeRules.version)),
  );
  // Collision-safe keys, assigned in a stable (outlet, code) order.
  const ruleKey = uniqueKeys();
  const sorted = rules
    .map((row) => ({
      row,
      code: row.outletId ? (codes.get(row.outletId) ?? null) : null,
    }))
    .sort((a, b) =>
      `${a.code ?? ""}\u0000${a.row.code}`.localeCompare(
        `${b.code ?? ""}\u0000${b.row.code}`,
      ),
    );
  const items: ServiceChargeItem[] = [];
  for (const { row, code } of sorted) {
    if (row.outletId && !code) continue;
    // `zone_id` has no foreign key: a dangling zone would widen the rule to
    // every zone if exported as null, so such a rule is left out. So is an
    // outlet rule whose zone sits in another outlet (import refuses it).
    const zoneKey = row.zoneId ? zoneKeyById.get(row.zoneId) : null;
    if (row.zoneId && !zoneKey) continue;
    if (
      row.zoneId &&
      row.outletId &&
      zoneOutlet.get(row.zoneId) !== row.outletId
    )
      continue;
    const key = ruleKey(taxRuleConfigKey(code, row.code));
    items.push({
      key,
      outletKey: code ? outletKey(code) : null,
      code: row.code,
      name: row.name,
      rateBp: row.rateBp,
      zoneKey: zoneKey ?? null,
      orderTypes: row.orderTypes,
      itemClasses: row.itemClasses,
      isActive: row.isActive,
    });
  }
  return items.length > 0 ? { version: 1, items } : undefined;
}

async function importServiceChargeRules(
  input: ImportContext,
  payload: unknown,
): Promise<void> {
  const items = itemsOf<ServiceChargeItem>(payload);
  if (items.length === 0) return;
  const { tx, keys, actorUserId, now } = input;
  const tenantId = input.tenantId as TenantId;
  const clocks = await targetOutletClocks(tx, tenantId);

  for (const item of items) {
    const outletId = resolveOutlet(
      input,
      item,
      `service charge rule "${item.key}"`,
    );
    if (outletId === undefined) continue;
    const what = `service charge rule "${item.code}"`;
    ensure(isRateBp(item.rateBp), what, "rateBp must be an integer 0..10000");
    ensure(Array.isArray(item.orderTypes), what, "orderTypes must be a list");
    ensure(
      Array.isArray(item.itemClasses) && item.itemClasses.length > 0,
      what,
      "itemClasses needs at least one class",
    );
    const [existing] = await tx
      .select({ id: serviceChargeRules.id })
      .from(serviceChargeRules)
      .where(
        and(
          eq(serviceChargeRules.tenantId, tenantId),
          eq(serviceChargeRules.code, item.code),
          outletId === null
            ? isNull(serviceChargeRules.outletId)
            : eq(serviceChargeRules.outletId, outletId),
        ),
      )
      .limit(1);
    if (existing) continue;
    // A zone-scoped rule must not widen to every zone: skip when the zone is
    // not in the target (outlet missing there, or a tenant-wide rule).
    if (item.zoneKey !== null && !keys.zones.has(item.zoneKey)) {
      input.warn(
        `Skipped ${what}: zone "${item.zoneKey}" does not exist in the target tenant.`,
      );
      continue;
    }
    // An outlet rule may only bind to a zone of its own outlet. A tenant-wide
    // rule keeps its zone: tax.service.ts does not tie a rule's zone to its
    // outlet either (the zone id alone narrows the rule).
    const zoneId =
      item.zoneKey === null
        ? null
        : outletId === null
          ? keys.need("zones", item.zoneKey)
          : keys.needInOutlet("zones", item.zoneKey, outletId);
    await tx.insert(serviceChargeRules).values({
      tenantId,
      outletId,
      code: item.code,
      name: item.name,
      rateBp: item.rateBp,
      zoneId,
      orderTypes: item.orderTypes,
      itemClasses: item.itemClasses,
      isActive: item.isActive,
      version: 1,
      effectiveFrom: businessDateOf(now, clockFor(outletId, clocks)),
      status: "published",
      publishedAt: now,
      publishedBy: actorUserId as UserId,
    });
  }
}

// ---- exports --------------------------------------------------------------

export const financeSectionHandlers: SectionHandler[] = [
  {
    section: "chart_of_accounts",
    exportSection: exportChartOfAccounts,
    importSection: importChartOfAccounts,
  },
  {
    section: "tax_rules",
    exportSection: exportTaxRules,
    importSection: importTaxRules,
  },
  {
    section: "service_charge_rules",
    exportSection: exportServiceChargeRules,
    importSection: importServiceChargeRules,
  },
];
