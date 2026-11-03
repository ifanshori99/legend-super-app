// Pure helpers for the Panel Platform operations screens (bead legend-y6s;
// PRD v1.7 §3 F4 "Feature Flag & Paket", "Kuota & Plafon"; TEN-05). No React
// and no `@/` alias, so tests/legend-y6s.test.mjs loads this file with plain
// Node ESM. Rules come from the shared contract (limits.ts / modules.ts);
// nothing here invents a business rule.
import type { AuditEvent } from "@starter/shared/audit";
import {
  COST_CAP_WARNING_BASIS_POINTS,
  INTEGRATION_PROVIDERS,
  LEGEND_MIN_ACTIVE_EMPLOYEES,
  MODULE_KEYS,
  integrationCategoryOf,
  modulesOutsidePackage,
  tenantLimitsSchema,
  type CostCapState,
  type IntegrationProvider,
  type ModuleKey,
  type PlatformPackage,
  type Tenant,
  type TenantLimits,
  type TenantUsage,
} from "@starter/shared/platform";

// ----------------------------------------------------------------- limits

export const LIMIT_FIELDS = [
  { key: "maxOutlets", kind: "count", usage: "outlets" },
  { key: "maxActiveEmployees", kind: "count", usage: "activeEmployees" },
  { key: "maxDevices", kind: "count", usage: "devices" },
  { key: "aiRequestsPerMonth", kind: "count", usage: "aiRequests" },
  { key: "whatsappCostCapIdr", kind: "idr", usage: "whatsappCostIdr" },
  { key: "aiCostCapIdr", kind: "idr", usage: "aiCostIdr" },
  { key: "emailCostCapIdr", kind: "idr", usage: "emailCostIdr" },
] as const satisfies readonly {
  key: keyof TenantLimits;
  kind: "count" | "idr";
  usage: keyof TenantUsage;
}[];
export type LimitKey = (typeof LIMIT_FIELDS)[number]["key"];
export type LimitsDraft = Record<LimitKey, string>;
export type LimitError = "required" | "invalid" | "range";

export function draftFromLimits(limits: TenantLimits): LimitsDraft {
  const draft = {} as LimitsDraft;
  for (const field of LIMIT_FIELDS)
    draft[field.key] = String(limits[field.key]);
  return draft;
}

/** "1.500.000", "1 500 000" and "1500000" are the same amount. */
function parseWhole(raw: string): number | "required" | "invalid" {
  const text = raw.replace(/[.\s]/g, "");
  if (text === "") return "required";
  if (!/^\d{1,15}$/.test(text)) return "invalid";
  return Number(text);
}

export type LimitsParse = {
  ok: boolean;
  limits: TenantLimits | null;
  errors: Partial<Record<LimitKey, LimitError>>;
};

/** Validates the form draft with the contract's own `tenantLimitsSchema`. */
export function parseLimitsDraft(draft: LimitsDraft): LimitsParse {
  const errors: Partial<Record<LimitKey, LimitError>> = {};
  const numbers: Record<string, number> = {};
  for (const field of LIMIT_FIELDS) {
    const value = parseWhole(draft[field.key]);
    if (typeof value === "number") numbers[field.key] = value;
    else errors[field.key] = value;
  }
  if (Object.keys(errors).length > 0)
    return { ok: false, limits: null, errors };
  const result = tenantLimitsSchema.safeParse(numbers);
  if (result.success) return { ok: true, limits: result.data, errors };
  for (const issue of result.error.issues) {
    const key = issue.path[0];
    if (LIMIT_FIELDS.some((field) => field.key === key))
      errors[key as LimitKey] = "range";
  }
  return { ok: false, limits: null, errors };
}

export type LimitWarning = "belowUsage" | "belowDefault";

/**
 * Non-blocking hints. A quota set under current usage never removes rows, it
 * only refuses the next create (QUOTA_EXCEEDED); a cap under spend stops the
 * feature (R18). Legend needs at least 30 active employees by default (D27).
 */
export function limitWarnings(
  limits: TenantLimits,
  usage: TenantUsage | null,
): Partial<Record<LimitKey, LimitWarning>> {
  const out: Partial<Record<LimitKey, LimitWarning>> = {};
  if (usage)
    for (const field of LIMIT_FIELDS)
      if (usage[field.usage] > limits[field.key]) out[field.key] = "belowUsage";
  if (limits.maxActiveEmployees < LEGEND_MIN_ACTIVE_EMPLOYEES)
    out.maxActiveEmployees ??= "belowDefault";
  return out;
}

export function limitsChanged(a: TenantLimits, b: TenantLimits): LimitKey[] {
  return LIMIT_FIELDS.filter((field) => a[field.key] !== b[field.key]).map(
    (field) => field.key,
  );
}

// --------------------------------------------------------------- usage bars

export type BarState = CostCapState;

/** Whole percent of the limit used, clamped to 0..100. A zero limit is 100
 * when anything is used and 0 otherwise. Integer arithmetic only. */
export function usagePercent(used: number, limit: number): number {
  if (limit <= 0) return used > 0 ? 100 : 0;
  return Math.min(100, Math.floor((used * 100) / limit));
}

/** Same thresholds as cost caps (R18): warning at 80%, stopped at 100%. */
export function quotaState(used: number, limit: number): BarState {
  if (limit <= 0) return used > 0 ? "stopped" : "ok";
  if (used >= limit) return "stopped";
  return BigInt(used) * 10_000n >=
    BigInt(limit) * BigInt(COST_CAP_WARNING_BASIS_POINTS)
    ? "warning"
    : "ok";
}

// -------------------------------------------------------- modules & gateways

export function nextModules(
  current: readonly ModuleKey[],
  key: ModuleKey,
  on: boolean,
): ModuleKey[] {
  const set = new Set(current);
  if (on) set.add(key);
  else set.delete(key);
  return MODULE_KEYS.filter((module) => set.has(module));
}

export function nextProviders(
  current: readonly IntegrationProvider[],
  key: IntegrationProvider,
  on: boolean,
): IntegrationProvider[] {
  const set = new Set(current);
  if (on) set.add(key);
  else set.delete(key);
  return INTEGRATION_PROVIDERS.filter((provider) => set.has(provider));
}

export function diffList<T extends string>(
  before: readonly T[],
  after: readonly T[],
): { added: T[]; removed: T[] } {
  return {
    added: after.filter((item) => !before.includes(item)),
    removed: before.filter((item) => !after.includes(item)),
  };
}

/** Modules switched on that the chosen package does not include
 * (MODULE_NOT_IN_PACKAGE blocks the save). */
export function blockedModules(
  modules: readonly ModuleKey[],
  pkg: Pick<PlatformPackage, "modules"> | undefined,
): ModuleKey[] {
  return pkg ? modulesOutsidePackage(modules, pkg) : [];
}

export const PROVIDER_CATEGORIES = [
  "payment_gateway",
  "messaging",
  "delivery_channel",
  "email",
  "edc",
  "lock",
  "wifi",
  "llm",
] as const;
export type ProviderCategory = (typeof PROVIDER_CATEGORIES)[number];

export function providersByCategory(): {
  category: ProviderCategory;
  providers: IntegrationProvider[];
}[] {
  return PROVIDER_CATEGORIES.map((category) => ({
    category,
    providers: INTEGRATION_PROVIDERS.filter(
      (provider) => integrationCategoryOf[provider] === category,
    ),
  })).filter((group) => group.providers.length > 0);
}

// ------------------------------------------------------------------ health

export type TenantCounts = Record<Tenant["status"], number> & { total: number };

export function tenantCounts(tenants: readonly Tenant[]): TenantCounts {
  const counts: TenantCounts = {
    active: 0,
    suspended: 0,
    archived: 0,
    total: tenants.length,
  };
  for (const tenant of tenants) counts[tenant.status] += 1;
  return counts;
}

export type AttentionItem = {
  tenantId: string;
  kind: "quota" | "cost_cap";
  key: string;
  state: "warning" | "stopped";
  percent: number;
};

type UsageViewLike = {
  quotas: { quota: string; limit: number; used: number }[];
  costCaps: {
    cap: string;
    state: CostCapState;
    capIdr: number;
    spentIdr: number;
  }[];
};

/** Quotas at 80%+ and cost caps in warning/stopped. A cap of 0 means the
 * feature is off on purpose (PRD §2), so it is not an alert. */
export function attentionItems(
  tenantId: string,
  view: UsageViewLike,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const row of view.quotas) {
    const state = quotaState(row.used, row.limit);
    if (state !== "ok" && !(row.limit === 0 && row.used === 0))
      items.push({
        tenantId,
        kind: "quota",
        key: row.quota,
        state,
        percent: usagePercent(row.used, row.limit),
      });
  }
  for (const row of view.costCaps)
    if (row.capIdr > 0 && row.state !== "ok")
      items.push({
        tenantId,
        kind: "cost_cap",
        key: row.cap,
        state: row.state,
        percent: usagePercent(row.spentIdr, row.capIdr),
      });
  return items;
}

// ------------------------------------------------------------------- audit

export const JAKARTA_OFFSET = "+07:00";

/** `YYYY-MM-DD` day pickers mean whole days in Asia/Jakarta (PRD: tanggal
 * bisnis di zona waktu outlet). Returns UTC ISO instants for the query. */
export function jakartaDayRange(
  from: string,
  to: string,
): { from?: string; to?: string } {
  const out: { from?: string; to?: string } = {};
  const valid = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day);
  if (valid(from))
    out.from = new Date(`${from}T00:00:00.000${JAKARTA_OFFSET}`).toISOString();
  if (valid(to))
    out.to = new Date(`${to}T23:59:59.999${JAKARTA_OFFSET}`).toISOString();
  return out;
}

export function auditMatches(
  event: AuditEvent,
  query: {
    tenantId?: string;
    actorType?: string;
    action?: string;
    from?: string;
    to?: string;
  },
): boolean {
  if (query.tenantId && event.tenantId !== query.tenantId) return false;
  if (query.actorType && event.actorType !== query.actorType) return false;
  const action = query.action?.trim().toLowerCase();
  if (action && !event.action.startsWith(action)) return false;
  const at = Date.parse(event.createdAt);
  if (query.from && at < Date.parse(query.from)) return false;
  if (query.to && at > Date.parse(query.to)) return false;
  return true;
}

export const shortId = (id: string | null) => (id ? id.slice(0, 8) : "");

export type ChangeRow = { field: string; before: string; after: string };

function show(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Field-by-field before/after rows; a non-object value is one row with an
 * empty field name. Values are already masked by the contract. */
export function changeRows(changes: AuditEvent["maskedChanges"]): ChangeRow[] {
  const { before, after } = changes;
  if (isRecord(before) || isRecord(after)) {
    const left = isRecord(before) ? before : {};
    const right = isRecord(after) ? after : {};
    const fields = [...new Set([...Object.keys(left), ...Object.keys(right)])];
    return fields.map((field) => ({
      field,
      before: show(left[field]),
      after: show(right[field]),
    }));
  }
  if (before === null && after === null) return [];
  return [{ field: "", before: show(before), after: show(after) }];
}

const whenFormat = new Intl.DateTimeFormat("id-ID", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Jakarta",
});
/** Date and time in the head office zone (Asia/Jakarta), e.g. "3 Nov 2026 10.00". */
export function formatWhen(iso: string): string {
  return whenFormat.format(new Date(iso));
}
