// TEN-09: finance sections of a tenant config bundle (chart of accounts, tax
// rules + calculation options, service-charge rules). Exports carry keys only
// (no ids, audit columns or timestamps); imports are idempotent and run inside
// the orchestrator's single transaction (tenant-config.service.ts).

import { and, asc, desc, eq, isNull } from "drizzle-orm";
import {
  REPORT_GROUPS,
  accountMappingIssues,
  CASH_ACCOUNT_SHARED_CODE,
  type AccountMapping,
  type AccountType,
  type PostingAccountRole,
  type ReportGroup,
} from "@starter/shared/accounting";
import {
  DEFAULT_BUSINESS_DAY_CLOCK,
  businessDateOf,
  createUlid,
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
import { recordAudit } from "./core-audit.ts";
import {
  TRADING_GUARD_HINT,
  tenantHasStartedTrading,
} from "./tenant-config-trading-guard.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";
import {
  DEFAULT_EFFECTIVE_FROM,
  DEFAULT_SERVICE_CHARGE_CODE,
  DEFAULT_SERVICE_CHARGE_ITEM_CLASSES,
  DEFAULT_SERVICE_CHARGE_NAME,
  DEFAULT_SERVICE_CHARGE_ORDER_TYPES,
  DEFAULT_SERVICE_CHARGE_RATE_BP,
  DEFAULT_SETTINGS,
} from "./tax-provisioning.service.ts";
import {
  lockServiceChargeConfig,
  lockTaxConfig,
} from "./tenant-config-locks.ts";
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
type ServiceChargeRow = typeof serviceChargeRules.$inferSelect;

// ---- shared helpers -------------------------------------------------------

function itemsOf<T>(payload: unknown): T[] {
  const items = (payload as GenericSectionPayload | undefined)?.items;
  return Array.isArray(items) ? (items as unknown as T[]) : [];
}

/** Reject an item that would violate a DB check constraint (clear 422). */
function ensure(ok: boolean, what: string, message: string): void {
  if (!ok) throw new ConfigImportError(`Invalid ${what}: ${message}.`);
}

// ---- provisioning defaults (legend-z1qk8) ---------------------------------
// A new tenant is provisioned with default tax settings and a tenant-wide
// SC-DINE-IN service charge. While such a row is still EXACTLY the default (the
// owner never touched it) the template overwrites it; once the owner changed it
// (or published a newer version) the import leaves it and says so. Only
// tenant-wide rows count: an outlet row is always the owner's.

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Audit of an in-place default overwrite: only the fields that changed, from
// and to. Names and other free text are left out (the masker redacts them).
const OVERWRITE_AUDIT_ACTION = "tenant_config.import_default_overwrite";
const OVERWRITE_AUDIT_SAFE_FIELDS = [
  "source",
  "calculationOrder",
  "pricesIncludeTax",
  "serviceRoundingMode",
  "taxRoundingMode",
  "inclusiveBaseRoundingMode",
  "billRounding",
  "incrementIdr",
  "mode",
  "packageAllocation",
  "rateBp",
  "zoneId",
  "orderTypes",
  "itemClasses",
  "isActive",
] as const;

async function auditDefaultOverwrite(
  input: ImportContext,
  objectType: "tax_settings" | "service_charge_rule",
  objectId: string,
  fields: Record<string, { from: unknown; to: unknown }>,
): Promise<void> {
  const changed = Object.entries(fields).filter(
    ([, { from, to }]) => !sameJson(from, to),
  );
  if (changed.length === 0) return;
  const before: Record<string, unknown> = { source: "config_import" };
  const after: Record<string, unknown> = { source: "config_import" };
  for (const [field, { from, to }] of changed) {
    before[field] = from ?? null;
    after[field] = to ?? null;
  }
  const { tx, ctx, now } = input;
  await recordAudit(
    tx as Parameters<typeof recordAudit>[0],
    ctx,
    {
      id: createUlid(now.getTime()),
      tenantId: input.tenantId,
      outletId: null,
      actorType: "user",
      actorId: input.actorUserId,
      deviceId: null,
      action: OVERWRITE_AUDIT_ACTION,
      objectType,
      objectId,
      reason: null,
      maskedChanges: { before, after },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    OVERWRITE_AUDIT_SAFE_FIELDS,
  );
}

const billRoundingOf = (
  value: { incrementIdr: number; mode: string } | null | undefined,
) => (value ? { incrementIdr: value.incrementIdr, mode: value.mode } : null);

function isDefaultTaxSettings(rows: TaxSettingsRow[]): boolean {
  const [row] = rows;
  return (
    rows.length === 1 &&
    row !== undefined &&
    row.outletId === null &&
    row.version === 1 &&
    row.status === "published" &&
    row.effectiveFrom === DEFAULT_EFFECTIVE_FROM &&
    row.calculationOrder === DEFAULT_SETTINGS.calculationOrder &&
    row.pricesIncludeTax === DEFAULT_SETTINGS.pricesIncludeTax &&
    row.serviceRoundingMode === DEFAULT_SETTINGS.serviceRoundingMode &&
    row.taxRoundingMode === DEFAULT_SETTINGS.taxRoundingMode &&
    row.inclusiveBaseRoundingMode ===
      DEFAULT_SETTINGS.inclusiveBaseRoundingMode &&
    row.packageAllocation === DEFAULT_SETTINGS.packageAllocation &&
    sameJson(
      billRoundingOf(row.billRounding),
      billRoundingOf(DEFAULT_SETTINGS.billRounding),
    )
  );
}

function taxSettingsMatchItem(
  row: TaxSettingsRow,
  item: TaxSettingsItem,
): boolean {
  return (
    row.calculationOrder === item.calculationOrder &&
    row.pricesIncludeTax === item.pricesIncludeTax &&
    row.serviceRoundingMode === item.serviceRoundingMode &&
    row.taxRoundingMode === item.taxRoundingMode &&
    row.inclusiveBaseRoundingMode === item.inclusiveBaseRoundingMode &&
    row.packageAllocation === item.packageAllocation &&
    sameJson(
      billRoundingOf(row.billRounding),
      billRoundingOf(item.billRounding),
    )
  );
}

function isDefaultServiceCharge(rows: ServiceChargeRow[]): boolean {
  const [row] = rows;
  return (
    rows.length === 1 &&
    row !== undefined &&
    row.outletId === null &&
    row.code === DEFAULT_SERVICE_CHARGE_CODE &&
    row.name === DEFAULT_SERVICE_CHARGE_NAME &&
    row.rateBp === DEFAULT_SERVICE_CHARGE_RATE_BP &&
    row.zoneId === null &&
    row.isActive &&
    row.version === 1 &&
    row.status === "published" &&
    row.effectiveFrom === DEFAULT_EFFECTIVE_FROM &&
    sameJson(row.orderTypes, DEFAULT_SERVICE_CHARGE_ORDER_TYPES) &&
    sameJson(row.itemClasses, DEFAULT_SERVICE_CHARGE_ITEM_CLASSES)
  );
}

/** `itemZoneId`: the item's zone resolved in the target tenant (null: none). */
function serviceChargeMatchesItem(
  row: ServiceChargeRow,
  item: ServiceChargeItem,
  itemZoneId: string | null | undefined,
): boolean {
  return (
    row.name === item.name &&
    row.rateBp === item.rateBp &&
    itemZoneId !== undefined &&
    row.zoneId === itemZoneId &&
    row.isActive === item.isActive &&
    sameJson(row.orderTypes, item.orderTypes) &&
    sameJson(row.itemClasses, item.itemClasses)
  );
}

const ROUNDING_MODES = ["half_up", "half_even", "down", "floor", "ceil"];
const isRateBp = (value: unknown) =>
  Number.isInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= 10000;

/** Highest-version published row (else the highest version): what is in force. */
function latestPublished<T extends { version: number; status: string }>(
  rows: T[],
): T {
  const byVersion = [...rows].sort((a, b) => b.version - a.version);
  return byVersion.find((row) => row.status === "published") ?? byVersion[0]!;
}

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
      .select({
        role: accountMappings.role,
        accountId: accountMappings.accountId,
      })
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
    const values = missing.map((item) => {
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
    });
    // The merged set (existing + imported) must pass the same validation as
    // the mapping endpoint, e.g. no cash role sharing an account (legend-1118).
    const chart = await tx
      .select()
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.tenantId, tenantId),
          eq(chartOfAccounts.legalEntityId, entity.id),
        ),
      );
    // Only the cash-sharing rule gates the import: the rest of the endpoint's
    // validation (e.g. header accounts) is not applied to bundles today and
    // would refuse charts the import has always accepted.
    // The ids are branded in the shared schema; the rows here come from this
    // tenant's own queries and bundle, so the cast only adds the brand.
    const issues = accountMappingIssues(
      [
        ...mapped.map((row) => ({
          ...row,
          tenantId,
          legalEntityId: entity.id,
        })),
        ...values,
      ] as AccountMapping[],
      chart.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        legalEntityId: row.legalEntityId,
        code: row.code,
        name: row.name,
        type: row.type,
        reportGroup: row.reportGroup,
        parentId: row.parentId,
        isActive: row.isActive,
      })) as unknown as Parameters<typeof accountMappingIssues>[1],
    ).filter((issue) => issue.startsWith(`${CASH_ACCOUNT_SHARED_CODE}:`));
    if (issues.length > 0)
      throw new ConfigImportError(
        `Account mapping of entity ${entity.id} is invalid: ${issues.join("; ")}`,
      );
    await tx.insert(accountMappings).values(values);
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
  await lockTaxConfig(tx, tenantId);
  const clocks = await targetOutletClocks(tx, tenantId);
  // Checked once per import, and only when a default is about to be replaced.
  let started: boolean | undefined;
  const hasStarted = async () =>
    (started ??= await tenantHasStartedTrading(tx, tenantId));
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
      const rows = await tx
        .select()
        .from(taxSettings)
        .where(
          and(
            eq(taxSettings.tenantId, tenantId),
            outletId === null
              ? isNull(taxSettings.outletId)
              : eq(taxSettings.outletId, outletId),
          ),
        );
      if (rows.length > 0) {
        if (!isDefaultTaxSettings(rows)) {
          if (
            outletId === null &&
            !taxSettingsMatchItem(latestPublished(rows), item)
          )
            input.warn(
              "Skipped tax settings: the tenant's tax settings were changed after provisioning, so the template's were not applied.",
            );
          continue;
        }
        if (await hasStarted()) {
          if (!taxSettingsMatchItem(rows[0]!, item))
            input.warn(
              `Pengaturan pajak tidak diganti karena tenant sudah punya transaksi atau perangkat edge terdaftar; ${TRADING_GUARD_HINT}.`,
            );
          continue;
        }
        // Still the provisioning default: the template replaces it in place
        // (version 1, effective from the default floor, so older business
        // dates keep resolving).
        const current = rows[0]!;
        await tx
          .update(taxSettings)
          .set({
            calculationOrder: item.calculationOrder,
            pricesIncludeTax: item.pricesIncludeTax,
            serviceRoundingMode: item.serviceRoundingMode,
            taxRoundingMode: item.taxRoundingMode,
            inclusiveBaseRoundingMode: item.inclusiveBaseRoundingMode,
            billRounding: item.billRounding,
            packageAllocation: item.packageAllocation,
            publishedAt: now,
            publishedBy: actorUserId as UserId,
          })
          .where(eq(taxSettings.id, current.id));
        await auditDefaultOverwrite(input, "tax_settings", current.id, {
          calculationOrder: {
            from: current.calculationOrder,
            to: item.calculationOrder,
          },
          pricesIncludeTax: {
            from: current.pricesIncludeTax,
            to: item.pricesIncludeTax,
          },
          serviceRoundingMode: {
            from: current.serviceRoundingMode,
            to: item.serviceRoundingMode,
          },
          taxRoundingMode: {
            from: current.taxRoundingMode,
            to: item.taxRoundingMode,
          },
          inclusiveBaseRoundingMode: {
            from: current.inclusiveBaseRoundingMode,
            to: item.inclusiveBaseRoundingMode,
          },
          billRounding: {
            from: billRoundingOf(current.billRounding),
            to: billRoundingOf(item.billRounding),
          },
          packageAllocation: {
            from: current.packageAllocation,
            to: item.packageAllocation,
          },
        });
        continue;
      }
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
  await lockServiceChargeConfig(tx, tenantId);
  const clocks = await targetOutletClocks(tx, tenantId);
  // Checked once per import, and only when a default is about to be replaced.
  let started: boolean | undefined;
  const hasStarted = async () =>
    (started ??= await tenantHasStartedTrading(tx, tenantId));

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
    const rows = await tx
      .select()
      .from(serviceChargeRules)
      .where(
        and(
          eq(serviceChargeRules.tenantId, tenantId),
          eq(serviceChargeRules.code, item.code),
          outletId === null
            ? isNull(serviceChargeRules.outletId)
            : eq(serviceChargeRules.outletId, outletId),
        ),
      );
    // Only the tenant-wide provisioning default may be overwritten; any other
    // existing rule (including every outlet rule) is the owner's.
    const isDefaultRow =
      outletId === null &&
      item.code === DEFAULT_SERVICE_CHARGE_CODE &&
      isDefaultServiceCharge(rows);
    // Even a default row stays once the tenant has started trading.
    const blockedByTrading = isDefaultRow && (await hasStarted());
    const overwritable = isDefaultRow && !blockedByTrading;
    if (blockedByTrading) {
      if (
        !serviceChargeMatchesItem(
          rows[0]!,
          item,
          item.zoneKey === null ? null : keys.zones.get(item.zoneKey),
        )
      )
        input.warn(
          `Service charge ${item.code} tidak diganti karena tenant sudah punya transaksi atau perangkat edge terdaftar; ${TRADING_GUARD_HINT}.`,
        );
      continue;
    }
    if (rows.length > 0 && !overwritable) {
      if (
        outletId === null &&
        item.code === DEFAULT_SERVICE_CHARGE_CODE &&
        !serviceChargeMatchesItem(
          latestPublished(rows),
          item,
          item.zoneKey === null ? null : keys.zones.get(item.zoneKey),
        )
      )
        input.warn(
          `Skipped ${what}: it was changed after provisioning, so the template's version was not applied.`,
        );
      continue;
    }
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
    if (overwritable) {
      // Still the provisioning default: replaced in place (version 1, effective
      // from the default floor, so older business dates keep resolving).
      const current = rows[0]!;
      await tx
        .update(serviceChargeRules)
        .set({
          name: item.name,
          rateBp: item.rateBp,
          zoneId,
          orderTypes: item.orderTypes,
          itemClasses: item.itemClasses,
          isActive: item.isActive,
          publishedAt: now,
          publishedBy: actorUserId as UserId,
        })
        .where(eq(serviceChargeRules.id, current.id));
      await auditDefaultOverwrite(input, "service_charge_rule", current.id, {
        rateBp: { from: current.rateBp, to: item.rateBp },
        zoneId: { from: current.zoneId, to: zoneId },
        orderTypes: { from: current.orderTypes, to: item.orderTypes },
        itemClasses: { from: current.itemClasses, to: item.itemClasses },
        isActive: { from: current.isActive, to: item.isActive },
      });
      continue;
    }
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
