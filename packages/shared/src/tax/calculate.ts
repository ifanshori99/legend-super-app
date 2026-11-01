// Pure tax and service-charge engine (PRD §3.14, F11, ORD-03, ORD-06). The
// API runs it on the server for every order; the FE may run it only for a
// preview the server recalculates. Browser- and Node-safe, bigint arithmetic.
//
// Steps, in the PRD order discount -> service charge -> tax:
//  1. Mixed packages are split into components (settings.packageAllocation).
//  2. Line discounts stay on their line; the order discount is spread pro rata
//     to each line's net amount (allocateIdr: exact, deterministic).
//  3. Each component resolves its tax rule (item > category > class, outlet >
//     tenant-wide) and its service-charge rule (zone/order type).
//  4. Lines are grouped per (tax rule, service rule); service and tax are
//     computed once per group, then allocated back to lines, so per-line
//     rounding never drifts from the bill total.
//  5. Optional cash rounding of the total (never part of the tax base).
// Every rounding step names its mode from the tenant's settings.

import {
  allocateIdr,
  applyBasisPoints,
  divideRounded,
  idr,
  roundToIncrement,
} from "../core/index.ts";
import type { Idr } from "../core/index.ts";
import { TaxError } from "./errors.ts";
import type {
  ItemTaxClass,
  RuleVersionStatus,
  ServiceChargeRule,
  TaxCalculationInput,
  TaxCalculationResult,
  TaxedLine,
  TaxRule,
  TaxSettings,
  TaxSummary,
} from "./schemas.ts";

export type TaxConfig = {
  /** All versions of the tenant's rules (caller loads them under RLS). */
  taxRules: readonly TaxRule[];
  serviceChargeRules: readonly ServiceChargeRule[];
  settings: readonly TaxSettings[];
};

type VersionRow = {
  outletId: string | null;
  status: RuleVersionStatus;
  effectiveFrom: string;
  version: number;
};

function later(a: VersionRow, b: VersionRow): boolean {
  return a.effectiveFrom === b.effectiveFrom
    ? a.version > b.version
    : a.effectiveFrom > b.effectiveFrom;
}

/**
 * Versions in force for an outlet on a business date: per code, the latest
 * published version with effectiveFrom <= date; an outlet version of a code
 * replaces the tenant-wide one; tombstones (isActive false) drop the code.
 */
export function effectiveRuleVersions<
  T extends VersionRow & { code: string; isActive: boolean },
>(rows: readonly T[], outletId: string, date: string): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    if (row.status !== "published" || row.effectiveFrom > date) continue;
    if (row.outletId !== null && row.outletId !== outletId) continue;
    const key = `${row.outletId === null ? "*" : "outlet"}|${row.code}`;
    const current = latest.get(key);
    if (!current || later(row, current)) latest.set(key, row);
  }
  const result: T[] = [];
  for (const [key, row] of latest) {
    if (key.startsWith("*|") && latest.has(`outlet|${row.code}`)) continue;
    if (row.isActive) result.push(row);
  }
  return result;
}

/** Settings in force: outlet versions beat tenant-wide ones. */
export function resolveTaxSettings(
  settings: readonly TaxSettings[],
  outletId: string,
  date: string,
): TaxSettings {
  let outletBest: TaxSettings | undefined;
  let tenantBest: TaxSettings | undefined;
  for (const row of settings) {
    if (row.status !== "published" || row.effectiveFrom > date) continue;
    if (row.outletId === outletId) {
      if (!outletBest || later(row, outletBest)) outletBest = row;
    } else if (row.outletId === null) {
      if (!tenantBest || later(row, tenantBest)) tenantBest = row;
    }
  }
  const found = outletBest ?? tenantBest;
  if (!found) throw new TaxError("TAX_SETTINGS_NOT_FOUND");
  return found;
}

type LineKey = {
  itemId: string;
  categoryId: string | null;
  itemClass: ItemTaxClass;
};
type Context = Pick<
  TaxCalculationInput,
  "outletId" | "channel" | "zoneId" | "regionCode"
>;

function pickMostSpecific<T>(
  candidates: { row: T; rank: number[] }[],
): T | null {
  if (candidates.length === 0) return null;
  const compare = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  };
  candidates.sort((a, b) => compare(b.rank, a.rank));
  if (
    candidates.length > 1 &&
    compare(candidates[0].rank, candidates[1].rank) === 0
  )
    throw new TaxError("TAX_RULE_AMBIGUOUS");
  return candidates[0].row;
}

/** Tax rule for one line among rules already in force. Fails closed. */
export function resolveTaxRule(
  rules: readonly TaxRule[],
  context: Context,
  line: LineKey,
): TaxRule {
  const candidates: { row: TaxRule; rank: number[] }[] = [];
  for (const rule of rules) {
    if (rule.channels.length > 0 && !rule.channels.includes(context.channel))
      continue;
    if (rule.regionCode !== null && rule.regionCode !== context.regionCode)
      continue;
    const level = rule.appliesTo.itemIds.includes(line.itemId)
      ? 3
      : line.categoryId !== null &&
          rule.appliesTo.categoryIds.includes(line.categoryId)
        ? 2
        : rule.appliesTo.itemClasses.includes(line.itemClass)
          ? 1
          : 0;
    if (level === 0) continue;
    candidates.push({
      row: rule,
      rank: [
        level,
        rule.outletId !== null ? 1 : 0,
        rule.channels.length > 0 ? 1 : 0,
        rule.regionCode !== null ? 1 : 0,
      ],
    });
  }
  const found = pickMostSpecific(candidates);
  if (!found) throw new TaxError("TAX_RULE_NOT_FOUND");
  return found;
}

/** Service-charge rule for one line, or null when none applies (no charge). */
export function resolveServiceChargeRule(
  rules: readonly ServiceChargeRule[],
  context: Context,
  itemClass: ItemTaxClass,
): ServiceChargeRule | null {
  const candidates: { row: ServiceChargeRule; rank: number[] }[] = [];
  for (const rule of rules) {
    if (!rule.itemClasses.includes(itemClass)) continue;
    if (rule.zoneId !== null && rule.zoneId !== context.zoneId) continue;
    if (
      rule.orderTypes.length > 0 &&
      !rule.orderTypes.includes(context.channel)
    )
      continue;
    candidates.push({
      row: rule,
      rank: [
        rule.zoneId !== null ? 1 : 0,
        rule.orderTypes.length > 0 ? 1 : 0,
        rule.outletId !== null ? 1 : 0,
      ],
    });
  }
  return pickMostSpecific(candidates);
}

type Row = LineKey & {
  lineId: string;
  componentId: string | null;
  grossIdr: Idr;
  discountIdr: Idr;
};

function packageWeights(
  line: TaxCalculationInput["lines"][number],
  method: TaxSettings["packageAllocation"],
): number[] {
  const weights = line.components.map((c) =>
    method === "fixed_bp" ? c.allocationBp : c.standalonePriceIdr,
  );
  if (weights.some((w) => w === null))
    throw new TaxError("TAX_PACKAGE_ALLOCATION_INVALID");
  const values = weights as number[];
  const sum = values.reduce((a, b) => a + b, 0);
  if (method === "fixed_bp" ? sum !== 10_000 : sum <= 0)
    throw new TaxError("TAX_PACKAGE_ALLOCATION_INVALID");
  return values;
}

const BP = 10_000n;

/** Service and tax for one group of lines sharing rule and service rate. */
function computeGroup(
  net: bigint,
  serviceBp: number,
  rule: TaxRule,
  settings: TaxSettings,
): { base: bigint; service: bigint; tax: bigint; taxBase: bigint } {
  const s = BigInt(serviceBp);
  const t = BigInt(rule.rateBp);
  if (!rule.priceIncludesTax) {
    const service = BigInt(
      applyBasisPoints(
        idr(Number(net)),
        serviceBp,
        settings.serviceRoundingMode,
      ),
    );
    const taxBase = rule.includeServiceInBase ? net + service : net;
    const tax = BigInt(
      applyBasisPoints(
        idr(Number(taxBase)),
        rule.rateBp,
        settings.taxRoundingMode,
      ),
    );
    return { base: net, service, tax, taxBase };
  }
  // Price is all-in: net = base x (1 + s) x (1 + t)  when service is in the
  // tax base, else net = base x (1 + s + t). Back out the base, then the
  // service charge; tax takes the remainder so the parts sum to net exactly.
  const denominator = rule.includeServiceInBase
    ? (BP + s) * (BP + t)
    : BP * (BP + s + t);
  const base = divideRounded(
    net * BP * BP,
    denominator,
    settings.inclusiveBaseRoundingMode,
  );
  let service: bigint;
  let tax: bigint;
  if (t === 0n) {
    service = net - base;
    tax = 0n;
  } else {
    service = BigInt(
      applyBasisPoints(
        idr(Number(base)),
        serviceBp,
        settings.serviceRoundingMode,
      ),
    );
    tax = net - base - service;
    if (tax < 0n) {
      // Only reachable for a few rupiah; keep every part non-negative.
      service += tax;
      tax = 0n;
    }
  }
  const taxBase = rule.includeServiceInBase ? base + service : base;
  return { base, service, tax, taxBase };
}

function weightsOf(values: readonly bigint[]): number[] {
  return values.map((v) => Number(v));
}

/** Calculates a bill. Throws TaxError on any config gap (fail closed). */
export function calculateTax(
  input: TaxCalculationInput,
  config: TaxConfig,
): TaxCalculationResult {
  const settings = resolveTaxSettings(
    config.settings,
    input.outletId,
    input.businessDate,
  );
  const taxRules = effectiveRuleVersions(
    config.taxRules,
    input.outletId,
    input.businessDate,
  );
  const serviceRules = effectiveRuleVersions(
    config.serviceChargeRules,
    input.outletId,
    input.businessDate,
  );

  // 1. Expand packages into components.
  const rows: Row[] = [];
  for (const line of input.lines) {
    if (line.components.length === 0) {
      rows.push({
        lineId: line.lineId,
        componentId: null,
        itemId: line.itemId,
        categoryId: line.categoryId,
        itemClass: line.itemClass,
        grossIdr: line.grossIdr,
        discountIdr: line.discountIdr,
      });
      continue;
    }
    const weights = packageWeights(line, settings.packageAllocation);
    const gross = allocateIdr(line.grossIdr, weights);
    const discount = allocateIdr(line.discountIdr, weights);
    line.components.forEach((component, index) =>
      rows.push({
        lineId: line.lineId,
        componentId: component.componentId,
        itemId: component.itemId,
        categoryId: component.categoryId,
        itemClass: component.itemClass,
        grossIdr: gross[index],
        discountIdr: discount[index],
      }),
    );
  }

  // 2. Spread the order discount pro rata to net amounts.
  if (input.orderDiscountIdr > 0) {
    const shares = allocateIdr(
      input.orderDiscountIdr,
      rows.map((r) => r.grossIdr - r.discountIdr),
    );
    rows.forEach((row, index) => {
      row.discountIdr = idr(row.discountIdr + shares[index]);
    });
  }

  // 3. Resolve rules and group.
  type Group = {
    rule: TaxRule;
    serviceRule: ServiceChargeRule | null;
    indexes: number[];
  };
  const groups = new Map<string, Group>();
  const resolved = rows.map((row, index) => {
    const rule = resolveTaxRule(taxRules, input, row);
    const serviceRule = resolveServiceChargeRule(
      serviceRules,
      input,
      row.itemClass,
    );
    const key = `${rule.id}|${serviceRule?.id ?? "-"}`;
    const group = groups.get(key) ?? { rule, serviceRule, indexes: [] };
    group.indexes.push(index);
    groups.set(key, group);
    return { rule, serviceRule };
  });

  // 4. Compute per group, allocate back to lines.
  const base = rows.map(() => 0n);
  const service = rows.map(() => 0n);
  const tax = rows.map(() => 0n);
  const summaries = new Map<
    string,
    { rule: TaxRule; taxBase: bigint; tax: bigint }
  >();
  for (const group of groups.values()) {
    const nets = group.indexes.map((i) =>
      BigInt(rows[i].grossIdr - rows[i].discountIdr),
    );
    const net = nets.reduce((a, b) => a + b, 0n);
    const parts = computeGroup(
      net,
      group.serviceRule?.rateBp ?? 0,
      group.rule,
      settings,
    );
    if (net > 0n) {
      const weights = weightsOf(nets);
      const split = (amount: bigint) =>
        allocateIdr(idr(Number(amount)), weights);
      const [b, s, t] = [
        split(parts.base),
        split(parts.service),
        split(parts.tax),
      ];
      group.indexes.forEach((rowIndex, k) => {
        base[rowIndex] = BigInt(b[k]);
        service[rowIndex] = BigInt(s[k]);
        tax[rowIndex] = BigInt(t[k]);
      });
    }
    const summary = summaries.get(group.rule.id) ?? {
      rule: group.rule,
      taxBase: 0n,
      tax: 0n,
    };
    summary.taxBase += parts.taxBase;
    summary.tax += parts.tax;
    summaries.set(group.rule.id, summary);
  }

  const lines: TaxedLine[] = rows.map((row, i) => ({
    lineId: row.lineId,
    componentId: row.componentId,
    itemId: row.itemId,
    itemClass: row.itemClass,
    taxRuleId: resolved[i].rule.id,
    serviceChargeRuleId: resolved[i].serviceRule?.id ?? null,
    grossIdr: row.grossIdr,
    discountIdr: row.discountIdr,
    baseIdr: idr(Number(base[i])),
    serviceChargeIdr: idr(Number(service[i])),
    taxIdr: idr(Number(tax[i])),
    totalIdr: idr(Number(base[i] + service[i] + tax[i])),
  }));
  const taxes: TaxSummary[] = [...summaries.values()].map((s) => ({
    taxRuleId: s.rule.id,
    code: s.rule.code,
    version: s.rule.version,
    taxType: s.rule.taxType,
    rateBp: s.rule.rateBp,
    priceIncludesTax: s.rule.priceIncludesTax,
    taxBaseIdr: idr(Number(s.taxBase)),
    taxIdr: idr(Number(s.tax)),
  }));

  const sum = (values: readonly bigint[]) => values.reduce((a, b) => a + b, 0n);
  const subtotal = idr(Number(sum(base) + sum(service) + sum(tax)));
  // 5. Cash rounding, outside the tax base.
  const rounded = settings.billRounding
    ? roundToIncrement(
        subtotal,
        settings.billRounding.incrementIdr,
        settings.billRounding.mode,
      )
    : { amount: subtotal, adjustment: idr(0) };

  return {
    settingsId: settings.id,
    lines,
    taxes,
    grossIdr: idr(rows.reduce((a, r) => a + r.grossIdr, 0)),
    discountIdr: idr(rows.reduce((a, r) => a + r.discountIdr, 0)),
    baseIdr: idr(Number(sum(base))),
    serviceChargeIdr: idr(Number(sum(service))),
    taxIdr: idr(Number(sum(tax))),
    roundingIdr: rounded.adjustment,
    totalIdr: rounded.amount,
  };
}
