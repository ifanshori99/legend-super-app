// Metric query runtime (PRD v1.7 §5 "Lapisan metrik baku", DASH-01/02, SH-01,
// SH-02; bead legend-cdta). One path answers dashboards, reports, the report
// builder, Tanya AI and MCP: the registry (`reportMetricByCode`) says what a
// code means, this service says what its value is.
//
// Rules:
// - I1 (narrowed by DECISIONS 2026-11-10 point 1): a money total the ledger
//   posts is a sum of posted journal lines (journal_entries holds posted
//   entries only; reversals are their own entries and net out), picked by
//   statement section or posting role (metrics-gl-sources.ts), and never comes
//   from operational rows. A split the ledger cannot carry (channel, menu,
//   ...) reads `metrics_daily` rows and is followed by one residual row
//   (METRIC_LEDGER_ADJUSTMENT) so the rows add up to the ledger total.
// - I2 / SH-02: a ledger figure is `final` only when its bucket is over AND
//   every month it touches is closed with a balance snapshot at the period's
//   current version, for every legal entity with books in that month (a
//   `fiscal_periods` row, opened by its first posting, or a journal entry);
//   otherwise it is an `estimate`. An entity whose books start later does not
//   hold earlier months open; a month nobody keeps books for stays an
//   estimate. If an entity later back-posts into a final month, its new period
//   row turns the month back into an estimate and `accountingVersion` moves.
//   Book state and ledger rows are read in one REPEATABLE READ READ ONLY
//   transaction, so a close or reopen cannot land between them. Ledger figures are treated as `closed_period_only` even when
//   the registry says `live`, because adjusting entries move them until the
//   books close. `requireFinal` refuses (PERIOD_NOT_CLOSED) before any value
//   is read, so a refusal never carries an estimate.
// - TEN-03: the requested outlets are intersected with the caller's scope
//   (outletIdsForQuery). journal_lines.outlet_id has no outlet RLS (nullable),
//   so the filter is applied here; entity-level lines (outlet null: payroll,
//   depreciation) count only for a tenant-wide query, where `groupBy=outlet`
//   puts them in their own "Tingkat badan usaha" series.
// - SH-01: an aggregate-only viewer (shareholder) may not split or filter by
//   a person (employee, customer, member).
// - The registry (`metric-sources/`) gives every code one source: `gl`,
//   `daily` (summed `metrics_daily` rows, null without rows), `derived` (a
//   ratio of two codes per bucket) or `unavailable` (null points and an
//   `availability` entry, "belum tersedia", never a zero). `evaluateMetrics`
//   is the only path from codes to values (DECISIONS 2026-11-10 point 2).
// - Finality of stored values (design §2.4): final only when the read-time
//   rule says final, every stored row behind the value is final and every
//   business day of the bucket has a stored total row of the code (a missing
//   day keeps it an estimate). Split and residual rows take the finality of
//   the ledger total of their bucket, under the same day rule.

import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { alias } from "drizzle-orm/pg-core";
import {
  businessDateOf,
  DEFAULT_BUSINESS_DAY_CLOCK,
  divideRounded,
  formatDecimal4,
  idr,
  outletIdsForQuery,
  parseDecimal4,
  type BusinessDate,
  type OutletQueryFilter,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { AccessError } from "@starter/shared/access";
import {
  compareMetricValues,
  METRIC_ENTITY_LEVEL_OUTLET,
  METRIC_LEDGER_ADJUSTMENT,
  METRIC_UNAVAILABLE_MESSAGES,
  metricDefinitionRefSchema,
  metricQueryResponseSchema,
  metricValueFinality,
  type MetricAccountingPeriod,
  type MetricAvailability,
  type MetricBucket,
  type MetricDefinition,
  type MetricDefinitionRef,
  type MetricDimensionFilter,
  type MetricDimensionKey,
  type MetricDimensionValue,
  type MetricFinality,
  type MetricOfficiality,
  type MetricPeriod,
  type MetricPoint,
  type MetricQueryRequest,
  type MetricQueryResponse,
  type MetricSeries,
  type MetricUnavailableReason,
  type MetricUnit,
  type MetricValue,
} from "@starter/shared/metrics";
import { reportMetricByCode } from "@starter/shared/dashboard";
import { db } from "../db";
import type * as schema from "../db/schema";
import {
  chartOfAccounts,
  fiscalPeriods,
  fiscalPeriodSnapshots,
  journalEntries,
  journalLines,
  metricsDaily,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import {
  glComponentsOf,
  type GlComponent,
  type GlMetricSource,
} from "./metrics-gl-sources";
import {
  metricSourceOf,
  metricSplitOf,
  type CurrentMetricReader,
  type DailyMetricReader,
  type MetricSource,
  type MetricSplitSource,
} from "./metric-sources";

/** `full`: report.financial.view / operational roles; `aggregate`: shareholder. */
export type MetricViewer = "full" | "aggregate";

/** Splits that identify a person; never shown to an aggregate-only viewer. */
export const METRIC_IDENTITY_DIMENSIONS = [
  "employee",
  "customer",
  "member",
] as const;

const MAX_POINTS = 2000;

// ---- Calendar helpers (business dates are YYYY-MM-DD) -----------------------

const DAY_MS = 86_400_000;
const toTime = (date: string) => Date.parse(`${date}T00:00:00Z`);
const fromTime = (time: number) =>
  new Date(time).toISOString().slice(0, 10) as BusinessDate;
const addDays = (date: string, days: number) =>
  fromTime(toTime(date) + days * DAY_MS);

function addMonths(date: string, months: number): BusinessDate {
  const [year, month] = date.split("-").map(Number) as [number, number];
  const index = year * 12 + (month - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01` as BusinessDate;
}

const monthOf = (date: string) => date.slice(0, 7);
const isMonthStart = (date: string) => date.endsWith("-01");
const isMonthEnd = (date: string) =>
  monthOf(addDays(date, 1)) !== monthOf(date);

function monthsBetween(start: string, end: string): string[] {
  const months: string[] = [];
  for (let at = addMonths(start, 0); at <= end; at = addMonths(at, 1))
    months.push(monthOf(at));
  return months;
}

function bucketStartOf(date: string, bucket: MetricBucket): BusinessDate {
  switch (bucket) {
    case "day":
    case "total":
      return date as BusinessDate;
    case "week": {
      const weekday = new Date(toTime(date)).getUTCDay();
      return addDays(date, -((weekday + 6) % 7));
    }
    case "month":
      return addMonths(date, 0);
    case "quarter": {
      const month = Number(date.slice(5, 7));
      return addMonths(date, -((month - 1) % 3));
    }
    case "year":
      return `${date.slice(0, 4)}-01-01` as BusinessDate;
  }
}

function nextBucketStart(start: string, bucket: MetricBucket): BusinessDate {
  switch (bucket) {
    case "day":
    case "total":
      return addDays(start, 1);
    case "week":
      return addDays(start, 7);
    case "month":
      return addMonths(start, 1);
    case "quarter":
      return addMonths(start, 3);
    case "year":
      return addMonths(start, 12);
  }
}

type Range = { start: BusinessDate; end: BusinessDate };

function bucketsOf(range: Range, bucket: MetricBucket): Range[] {
  if (bucket === "total") return [range];
  const buckets: Range[] = [];
  for (
    let at = bucketStartOf(range.start, bucket);
    at <= range.end;
    at = nextBucketStart(at, bucket)
  ) {
    const last = addDays(nextBucketStart(at, bucket), -1);
    buckets.push({
      start: at < range.start ? range.start : at,
      end: last > range.end ? range.end : last,
    });
    if (buckets.length > MAX_POINTS)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Periode terlalu panjang untuk pembagian ini; pilih bucket yang lebih besar.",
      );
  }
  return buckets;
}

/**
 * The period a comparison reads: the same number of whole months before a
 * whole-month range (July → June), otherwise the same number of days directly
 * before it.
 */
export function previousMetricRange(range: Range): Range {
  if (isMonthStart(range.start) && isMonthEnd(range.end)) {
    const months = monthsBetween(range.start, range.end).length;
    return {
      start: addMonths(range.start, -months),
      end: addDays(range.start, -1),
    };
  }
  const days = (toTime(range.end) - toTime(range.start)) / DAY_MS + 1;
  return { start: addDays(range.start, -days), end: addDays(range.start, -1) };
}

// ---- Registry ---------------------------------------------------------------

function resolveDefinitions(codes: readonly string[]): MetricDefinition[] {
  return [...new Set(codes)].map((code) => {
    const definition = reportMetricByCode.get(code);
    if (!definition)
      throw new HttpError(
        404,
        "METRIC_NOT_FOUND",
        `Metrik "${code}" tidak terdaftar.`,
      );
    if (definition.status !== "active")
      throw new HttpError(
        409,
        "METRIC_DEFINITION_INACTIVE",
        `Metrik "${code}" tidak aktif.`,
      );
    return definition;
  });
}

function definitionRef(definition: MetricDefinition): MetricDefinitionRef {
  return metricDefinitionRefSchema.parse({
    id: definition.id,
    code: definition.code,
    version: definition.version,
    name: definition.name,
    ownerModule: definition.ownerModule,
    formula: definition.formula,
    unit: definition.unit,
    aggregation: definition.aggregation,
    dimensions: definition.dimensions,
    grain: definition.grain,
    officiality: definition.officiality,
    sourceReport: definition.sourceReport,
  });
}

function unsupportedDimension(code: string, key: string): HttpError {
  return new HttpError(
    400,
    "METRIC_DIMENSION_NOT_SUPPORTED",
    `Metrik "${code}" tidak bisa dibagi atau difilter per "${key}".`,
  );
}

/**
 * SH-01 and the registry: an aggregate-only viewer never splits or filters by
 * a person, and a key the definition does not declare at all is a 400. A
 * declared split no source reads yet is `dimension_not_supported` instead.
 */
function assertDimensions(
  definitions: readonly MetricDefinition[],
  keys: readonly string[],
  viewer: MetricViewer,
) {
  if (
    viewer === "aggregate" &&
    keys.some((key) =>
      (METRIC_IDENTITY_DIMENSIONS as readonly string[]).includes(key),
    )
  )
    throw new AccessError(
      "PERMISSION_DENIED",
      "Pemegang saham hanya melihat angka agregat, tanpa rincian per orang.",
    );
  for (const definition of definitions)
    for (const key of keys)
      if (!definition.dimensions.includes(key))
        throw unsupportedDimension(definition.code, key);
}

// ---- Ledger reads -----------------------------------------------------------

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

/**
 * `withTenant` inside one REPEATABLE READ READ ONLY transaction: every read of
 * a query (book state, accounts, ledger rows) sees the same snapshot, so a
 * close, reopen or posting committing meanwhile cannot mix two states.
 * withTenant runs as a savepoint of the outer transaction and keeps all of its
 * role and tenant checks; its `set_config(..., true)` lasts until the outer
 * transaction ends.
 */
export function withTenantSnapshot<T>(
  context: ScopedTenantContext,
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(
    (outer) =>
      withTenant(
        outer as unknown as NodePgDatabase<typeof schema>,
        context,
        run,
      ),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

type BookState = {
  /** Months whose books are closed by every entity with books in them. */
  closed: Set<string>;
  periods: MetricAccountingPeriod[];
};

/**
 * Book state per month. An entity must have closed a month (with a snapshot
 * at the period's current version) only when it has books in that month: a
 * `fiscal_periods` row or a journal entry dated in it.
 */
async function bookState(
  tx: Tx,
  tenantId: string,
  months: readonly string[],
): Promise<BookState> {
  if (months.length === 0) return { closed: new Set(), periods: [] };
  const first = `${months[0]}-01`;
  const last = addDays(addMonths(`${months.at(-1)}-01`, 1), -1);
  const periodRows = await tx
    .select({
      entity: fiscalPeriods.legalEntityId,
      period: fiscalPeriods.period,
      version: fiscalPeriods.version,
      closed: sql<boolean>`(${fiscalPeriods.status} = 'closed' AND ${fiscalPeriodSnapshots.id} IS NOT NULL)`,
    })
    .from(fiscalPeriods)
    .leftJoin(
      fiscalPeriodSnapshots,
      and(
        eq(fiscalPeriodSnapshots.tenantId, fiscalPeriods.tenantId),
        eq(fiscalPeriodSnapshots.fiscalPeriodId, fiscalPeriods.id),
        eq(fiscalPeriodSnapshots.version, fiscalPeriods.version),
      ),
    )
    .where(
      and(
        eq(fiscalPeriods.tenantId, tenantId),
        inArray(fiscalPeriods.period, [...months]),
      ),
    );
  // Defensive: posting opens the period row, but a journal entry without one
  // still means the entity has books in that month.
  const journalRows = await tx
    .selectDistinct({
      entity: journalEntries.legalEntityId,
      period: sql<string>`to_char(${journalEntries.entryDate}, 'YYYY-MM')`,
    })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        gte(journalEntries.entryDate, first),
        lte(journalEntries.entryDate, last),
      ),
    );
  const books = new Map<string, Map<string, boolean>>();
  const versions = new Map<string, number>();
  const bookOf = (period: string) => {
    let entities = books.get(period);
    if (!entities) books.set(period, (entities = new Map()));
    return entities;
  };
  for (const row of periodRows) {
    bookOf(row.period).set(row.entity, row.closed === true);
    versions.set(row.period, (versions.get(row.period) ?? 0) + row.version);
  }
  for (const row of journalRows) {
    const entities = bookOf(row.period);
    if (!entities.has(row.entity)) entities.set(row.entity, false);
  }
  const closed = new Set<string>();
  const periods = months.map((month) => {
    const entities = [...(books.get(month)?.values() ?? [])];
    const isClosed = entities.length > 0 && entities.every(Boolean);
    if (isClosed) closed.add(month);
    return {
      period: month,
      accountingVersion: versions.get(month) ?? 0,
      closed: isClosed,
    };
  });
  return { closed, periods };
}

/**
 * accountId → sign and journal sources (null: every source), per component;
 * first matching term wins.
 */
type ComponentAccounts = Map<
  string,
  { sign: 1 | -1; sources: ReadonlySet<string> | null }
>;

async function componentAccounts(
  tx: Tx,
  tenantId: string,
  components: readonly GlComponent[],
): Promise<Map<GlComponent, ComponentAccounts>> {
  const groups = new Set<string>();
  const roles = new Set<string>();
  for (const component of components)
    for (const term of component) {
      for (const group of term.reportGroups ?? []) groups.add(group);
      for (const role of term.roles ?? []) roles.add(role);
    }
  const byGroup =
    groups.size === 0
      ? []
      : await tx
          .select({
            id: chartOfAccounts.id,
            group: chartOfAccounts.reportGroup,
          })
          .from(chartOfAccounts)
          .where(
            and(
              eq(chartOfAccounts.tenantId, tenantId),
              inArray(chartOfAccounts.reportGroup, [...groups] as never[]),
            ),
          );
  // A mapped account and all of its descendants (parent_id chain).
  const byRole =
    roles.size === 0
      ? []
      : (
          await tx.execute<{ id: string; role: string }>(sql`
            WITH RECURSIVE mapped (id, role) AS (
              SELECT m.account_id, m.role::text
                FROM account_mappings m
               WHERE m.tenant_id = ${tenantId}
                 AND m.role::text IN (${sql.join(
                   [...roles].map((role) => sql`${role}`),
                   sql`, `,
                 )})
              UNION
              SELECT c.id, mapped.role
                FROM chart_of_accounts c
                JOIN mapped ON c.parent_id = mapped.id
               WHERE c.tenant_id = ${tenantId}
            )
            SELECT id::text AS id, role FROM mapped
          `)
        ).rows;
  const result = new Map<GlComponent, ComponentAccounts>();
  for (const component of components) {
    const accounts: ComponentAccounts = new Map();
    for (const term of component) {
      const ids = [
        ...byGroup
          .filter((row) => term.reportGroups?.includes(row.group))
          .map((row) => row.id),
        ...byRole
          .filter((row) =>
            (term.roles as readonly string[] | undefined)?.includes(row.role),
          )
          .map((row) => row.id),
      ];
      const sources = term.sourceTypes ? new Set(term.sourceTypes) : null;
      for (const id of ids)
        if (!accounts.has(id)) accounts.set(id, { sign: term.sign, sources });
    }
    result.set(component, accounts);
  }
  return result;
}

type LedgerRow = {
  accountId: string;
  date: string;
  outletId: string | null;
  /** Legal entity of the journal entry (also for lines without an outlet). */
  legalEntityId: string;
  /** Journal source; a reversal carries the source of the entry it reverses. */
  sourceType: string;
  /** credit − debit, whole rupiah. */
  net: bigint;
};

const reversedEntries = alias(journalEntries, "reversed_entries");

async function ledgerRows(
  tx: Tx,
  tenantId: string,
  accountIds: readonly string[],
  /** start null: every line up to `end` (balances). */
  range: { start: string | null; end: string },
  outletFilter: ReturnType<typeof outletIdsForQuery>,
): Promise<LedgerRow[]> {
  if (accountIds.length === 0) return [];
  const sourceType = sql<string>`coalesce(${reversedEntries.sourceType}, ${journalEntries.sourceType})`;
  const rows = await tx
    .select({
      accountId: journalLines.accountId,
      date: journalEntries.entryDate,
      outletId: journalLines.outletId,
      legalEntityId: journalEntries.legalEntityId,
      sourceType,
      net: sql<string>`(sum(${journalLines.creditIdr}) - sum(${journalLines.debitIdr}))::text`,
    })
    .from(journalLines)
    .innerJoin(
      journalEntries,
      and(
        eq(journalEntries.tenantId, journalLines.tenantId),
        eq(journalEntries.id, journalLines.entryId),
      ),
    )
    .leftJoin(
      reversedEntries,
      and(
        eq(reversedEntries.tenantId, journalEntries.tenantId),
        eq(reversedEntries.id, journalEntries.reversalOf),
      ),
    )
    .where(
      and(
        eq(journalLines.tenantId, tenantId),
        inArray(journalLines.accountId, [...accountIds]),
        range.start === null
          ? undefined
          : gte(journalEntries.entryDate, range.start),
        lte(journalEntries.entryDate, range.end),
        outletFilter.kind === "outlets"
          ? inArray(journalLines.outletId, [...outletFilter.outletIds])
          : undefined,
      ),
    )
    .groupBy(
      journalLines.accountId,
      journalEntries.entryDate,
      journalLines.outletId,
      journalEntries.legalEntityId,
      sourceType,
    );
  return rows.map((row) => ({
    accountId: row.accountId,
    date: row.date,
    outletId: row.outletId,
    legalEntityId: row.legalEntityId,
    sourceType: row.sourceType,
    net: BigInt(row.net),
  }));
}

// ---- Evaluation -------------------------------------------------------------

type Sum = { value: bigint; hasData: boolean };

const NO_DATA: Sum = { value: 0n, hasData: false };
/** Index key of every outlet together. */
const ALL_OUTLETS = "*";
/** Index key of entity-level lines (outlet null). */
const ENTITY_LEVEL = "";

/** Split key the ledger answers from journal_entries.legal_entity_id. */
export const LEGAL_ENTITY_DIMENSION = "legal_entity";
const outletKeyOf = (outletId: string | null) => outletId ?? ENTITY_LEVEL;
/**
 * Index key of one legal entity (all its outlets and entity-level lines). The
 * prefix cannot collide with an outlet id, so outlet reads skip these keys.
 */
const LEGAL_ENTITY_PREFIX = "legal_entity:";
const legalEntityKeyOf = (legalEntityId: string) =>
  `${LEGAL_ENTITY_PREFIX}${legalEntityId}`;

/**
 * The range a date falls in: binary search over the current buckets (date
 * order), then the comparison range if any; -1 outside all of them.
 */
function rangeIndexOf(
  ranges: readonly Range[],
  currentCount: number,
  date: string,
): number {
  let low = 0;
  let high = currentCount - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid]!;
    if (date < range.start) high = mid - 1;
    else if (date > range.end) low = mid + 1;
    else return mid;
  }
  for (let at = currentCount; at < ranges.length; at++) {
    const range = ranges[at]!;
    if (date >= range.start && date <= range.end) return at;
  }
  return -1;
}

/**
 * Signed sums per (component, bucket, outlet), built in one pass over the
 * ledger rows: each row lands in its bucket by binary search and adds to every
 * component that reads its account. Evaluating a point is then a lookup, not
 * a scan of all rows per bucket and per group.
 */
class LedgerIndex {
  /** component → bucket index → outlet key → sum. */
  private readonly sums = new Map<GlComponent, Map<string, Sum>[]>();

  constructor(
    accounts: ReadonlyMap<GlComponent, ComponentAccounts>,
    rows: readonly LedgerRow[],
    /** Current buckets, in date order, then the comparison range if any. */
    ranges: readonly Range[],
    currentCount: number,
    /** Balance components and their lines up to the last range end. */
    balance: {
      components: ReadonlySet<GlComponent>;
      rows: readonly LedgerRow[];
    } = { components: new Set(), rows: [] },
  ) {
    type Target = {
      component: GlComponent;
      sign: 1 | -1;
      sources: ReadonlySet<string> | null;
    };
    const byAccount = new Map<string, Target[]>();
    const balanceByAccount = new Map<string, Target[]>();
    for (const [component, map] of accounts) {
      this.sums.set(
        component,
        ranges.map(() => new Map()),
      );
      const target = balance.components.has(component)
        ? balanceByAccount
        : byAccount;
      for (const [accountId, { sign, sources }] of map) {
        const list = target.get(accountId) ?? [];
        list.push({ component, sign, sources });
        target.set(accountId, list);
      }
    }
    const add = (
      component: GlComponent,
      bucket: number,
      row: LedgerRow,
      sign: 1 | -1,
    ) => {
      const byOutlet = this.sums.get(component)![bucket]!;
      const amount = sign === 1 ? row.net : -row.net;
      for (const key of [
        outletKeyOf(row.outletId),
        ALL_OUTLETS,
        legalEntityKeyOf(row.legalEntityId),
      ]) {
        const sum = byOutlet.get(key);
        if (sum) sum.value += amount;
        else byOutlet.set(key, { value: amount, hasData: true });
      }
    };
    for (const row of rows) {
      const targets = byAccount.get(row.accountId);
      if (!targets) continue;
      const bucket = rangeIndexOf(ranges, currentCount, row.date);
      if (bucket < 0) continue;
      for (const { component, sign, sources } of targets)
        if (!sources || sources.has(row.sourceType))
          add(component, bucket, row, sign);
    }
    // A balance line counts in every range that ends on or after its date.
    for (const row of balance.rows) {
      const targets = balanceByAccount.get(row.accountId);
      if (!targets) continue;
      ranges.forEach((range, bucket) => {
        if (row.date > range.end) return;
        for (const { component, sign, sources } of targets)
          if (!sources || sources.has(row.sourceType))
            add(component, bucket, row, sign);
      });
    }
  }

  sum(component: GlComponent, range: number, outletKey: string): Sum {
    return this.sums.get(component)?.[range]?.get(outletKey) ?? NO_DATA;
  }

  /** Outlet keys (entity level included) with data for a component's buckets. */
  outletKeys(component: GlComponent, rangeCount: number): Set<string> {
    const keys = new Set<string>();
    for (let at = 0; at < rangeCount; at++)
      for (const key of this.outletKeysAt(component, at)) keys.add(key);
    return keys;
  }

  /** Outlet keys (entity level included) with data in one bucket. */
  outletKeysAt(component: GlComponent, range: number): string[] {
    const byOutlet = this.sums.get(component)?.[range];
    return [...(byOutlet?.keys() ?? [])].filter(
      (key) => key !== ALL_OUTLETS && !key.startsWith(LEGAL_ENTITY_PREFIX),
    );
  }

  /** Legal entity keys with data for a component's buckets. */
  legalEntityKeys(component: GlComponent, rangeCount: number): Set<string> {
    const keys = new Set<string>();
    for (let at = 0; at < rangeCount; at++)
      for (const key of this.sums.get(component)?.[at]?.keys() ?? [])
        if (key.startsWith(LEGAL_ENTITY_PREFIX)) keys.add(key);
    return keys;
  }
}

function idrValue(amount: bigint): MetricValue {
  if (
    amount > BigInt(Number.MAX_SAFE_INTEGER) ||
    amount < BigInt(Number.MIN_SAFE_INTEGER)
  )
    throw new RangeError("Rupiah metric exceeds the safe integer range");
  return { unit: "idr", valueIdr: idr(Number(amount)) };
}

function evaluate(
  source: GlMetricSource,
  index: LedgerIndex,
  range: number,
  outletKey: string,
): MetricValue | null {
  if (source.kind !== "ratio") {
    const sum = index.sum(source.component, range, outletKey);
    return sum.hasData ? idrValue(sum.value) : null;
  }
  const denominator = index.sum(source.denominator, range, outletKey);
  if (!denominator.hasData || denominator.value === 0n) return null;
  // A numerator without lines is "no data", not 0 % (e.g. labor cost for an
  // outlet-scoped reader: payroll posts at entity level).
  const numerator = index.sum(source.numerator, range, outletKey);
  if (!numerator.hasData) return null;
  // numerator / denominator × 100 as Decimal4 (× 10^4): × 1_000_000.
  return {
    unit: "percent",
    value: formatDecimal4(
      divideRounded(numerator.value * 1_000_000n, denominator.value, "half_up"),
    ),
  };
}

// ---- Native values ----------------------------------------------------------

const DECIMAL4_SCALE = 10_000n;

/** A value in its unit's native integer scale (Decimal4 × 10^4). */
function nativeOf(value: MetricValue): bigint {
  switch (value.unit) {
    case "idr":
      return BigInt(value.valueIdr);
    case "count":
    case "seconds":
      return BigInt(value.value);
    case "percent":
    case "decimal":
      return parseDecimal4(value.value);
  }
}

/** Denominator that turns a native value into its real number. */
const nativeScaleOf = (unit: MetricUnit) =>
  unit === "percent" || unit === "decimal" ? DECIMAL4_SCALE : 1n;

function safeNumber(native: bigint): number {
  if (
    native > BigInt(Number.MAX_SAFE_INTEGER) ||
    native < BigInt(Number.MIN_SAFE_INTEGER)
  )
    throw new RangeError("Metric value exceeds the safe integer range");
  return Number(native);
}

function valueOf(unit: MetricUnit, native: bigint): MetricValue {
  switch (unit) {
    case "idr":
      return idrValue(native);
    case "count":
    case "seconds":
      return { unit, value: safeNumber(native) };
    case "percent":
    case "decimal":
      return { unit, value: formatDecimal4(native) };
  }
}

/** numerator / denominator × scale in `unit`; null for no data or a zero denominator. */
function ratioValue(
  numerator: MetricValue | null,
  denominator: MetricValue | null,
  scale: 1 | 100,
  unit: MetricUnit,
): MetricValue | null {
  if (numerator === null || denominator === null) return null;
  const den = nativeOf(denominator);
  if (den === 0n) return null;
  return valueOf(
    unit,
    divideRounded(
      nativeOf(numerator) *
        nativeScaleOf(denominator.unit) *
        BigInt(scale) *
        nativeScaleOf(unit),
      nativeScaleOf(numerator.unit) * den,
      "half_up",
    ),
  );
}

// ---- metrics_daily ----------------------------------------------------------

type DailyRow = {
  code: string;
  outletId: string;
  date: string;
  dimensionKey: string | null;
  dimensionValue: string | null;
  unit: MetricUnit;
  native: bigint;
  final: boolean;
  /** Index into the evaluation ranges (current buckets, then previous). */
  range: number;
};

/** One read of `metrics_daily` for every stored code of the call. */
async function dailyRows(
  tx: Tx,
  tenantId: string,
  codes: readonly string[],
  dimensionKeys: readonly string[],
  range: Range,
  outletFilter: OutletQueryFilter,
): Promise<Omit<DailyRow, "range">[]> {
  if (codes.length === 0) return [];
  const rows = await tx
    .select({
      code: metricsDaily.metricCode,
      outletId: metricsDaily.outletId,
      date: metricsDaily.metricDate,
      dimensionKey: metricsDaily.dimensionKey,
      dimensionValue: metricsDaily.dimensionValue,
      unit: metricsDaily.unit,
      valueInt: metricsDaily.valueInt,
      valueDecimal: metricsDaily.valueDecimal,
      finality: metricsDaily.finality,
    })
    .from(metricsDaily)
    .where(
      and(
        eq(metricsDaily.tenantId, tenantId as TenantId),
        inArray(metricsDaily.metricCode, [...codes]),
        gte(metricsDaily.metricDate, range.start),
        lte(metricsDaily.metricDate, range.end),
        outletFilter.kind === "outlets"
          ? inArray(metricsDaily.outletId, [...outletFilter.outletIds])
          : undefined,
        dimensionKeys.length === 0
          ? isNull(metricsDaily.dimensionKey)
          : or(
              isNull(metricsDaily.dimensionKey),
              inArray(metricsDaily.dimensionKey, [...dimensionKeys]),
            ),
      ),
    );
  return rows.map((row) => {
    const unit = row.unit as MetricUnit;
    return {
      code: row.code,
      outletId: row.outletId,
      date: row.date,
      dimensionKey: row.dimensionKey,
      dimensionValue: row.dimensionValue,
      unit,
      native:
        unit === "percent" || unit === "decimal"
          ? parseDecimal4(row.valueDecimal ?? "0")
          : (row.valueInt ?? 0n),
      final: row.finality === "final",
    };
  });
}

// ---- Engine -----------------------------------------------------------------

/** Where the engine finds sources; tests inject their own. */
export type SourceLookup = {
  sourceOf(code: string): MetricSource;
  splitOf(
    code: string,
    dimension: MetricSplitSource["dimension"],
  ): MetricSplitSource | null;
};

const REGISTRY_SOURCES: SourceLookup = {
  sourceOf: metricSourceOf,
  splitOf: metricSplitOf,
};

export type EvaluateMetricsRequest = {
  metricCodes: readonly string[];
  period: { start: BusinessDate; end: BusinessDate };
  bucket: MetricBucket;
  /** From outletIdsForQuery: the requested outlets within the caller's scope. */
  outletFilter: OutletQueryFilter;
  /** The outlet and at most one other key; deeper answers dimension_not_supported. */
  groupBy: readonly MetricDimensionKey[];
  filters: readonly MetricDimensionFilter[];
  comparePrevious: boolean;
  viewer: MetricViewer;
  /** SH-02: refuse with PERIOD_NOT_CLOSED before any value is read. */
  requireFinal?: boolean;
};

export type EvaluateMetricsOptions = {
  sources?: SourceLookup;
  /**
   * Business date (YYYY-MM-DD) that decides period finality and status.
   * Defaults to today on the default business-day clock; the dashboard passes
   * the outlet-aware today so tile values and `period.status` agree.
   */
  today?: string;
};

/**
 * A series of the engine. `dimensions` lists the split values, the outlet
 * first, then the one other key (empty for the total). `dimension` is the
 * public single split: the only entry, or null for a total or a two-key split.
 */
export type EvaluatedSeries = MetricSeries & {
  dimensions: MetricDimensionValue[];
};

export type EvaluatedMetrics = {
  /** One per distinct requested code, in request order. */
  definitions: MetricDefinitionRef[];
  series: EvaluatedSeries[];
  /** One per definition, same order. */
  availability: MetricAvailability[];
  period: MetricPeriod;
  outletFilter: OutletQueryFilter;
  accountingPeriods: MetricAccountingPeriod[];
  dataThrough: BusinessDate;
};

/** The split and filter a call asks for, or why the engine cannot read it. */
type Shape = {
  byOutlet: boolean;
  /** The query reads some outlets only (filter or the caller's scope). */
  outletFiltered: boolean;
  splitKey: Exclude<MetricDimensionKey, "outlet"> | null;
  filter: { key: string; values: ReadonlySet<string> } | null;
  supported: boolean;
};

function shapeOf(
  groupBy: readonly MetricDimensionKey[],
  filters: readonly MetricDimensionFilter[],
  outletFilter: OutletQueryFilter,
): Shape {
  const splitKeys = groupBy.filter((key) => key !== "outlet");
  const shape: Shape = {
    byOutlet: groupBy.includes("outlet"),
    outletFiltered: outletFilter.kind !== "all",
    splitKey: splitKeys[0] ?? null,
    filter: null,
    supported:
      new Set(groupBy).size === groupBy.length && splitKeys.length <= 1,
  };
  // A stored row carries one dimension, so a filter must be on the split key
  // (or on the only key read). Outlets are filtered by `outletFilter`.
  const filterKeys = new Set(filters.map((filter) => filter.key));
  if (filterKeys.size > 1) return { ...shape, supported: false };
  const [first, ...rest] = filters;
  if (first) {
    if (
      first.key === "outlet" ||
      (shape.splitKey !== null && first.key !== shape.splitKey)
    )
      return { ...shape, supported: false };
    const values = new Set(
      first.values.filter((value) =>
        rest.every((filter) => filter.values.includes(value)),
      ),
    );
    shape.filter = { key: first.key, values };
  }
  return shape;
}

type Plan =
  | { kind: "unavailable"; reason: MetricUnavailableReason; message?: string }
  | { kind: "current"; reader: CurrentMetricReader }
  | { kind: "gl"; gl: GlMetricSource; split: MetricSplitSource | null }
  | {
      kind: "daily";
      reader: DailyMetricReader;
      /** Stored count weighting an average across days (`weightCode`). */
      weightCode: string | null;
    }
  | {
      kind: "derived";
      numerator: string;
      denominator: string;
      scale: 1 | 100;
    }
  | { kind: "share"; of: string; dimension: string };

const NOT_SUPPORTED: Plan = {
  kind: "unavailable",
  reason: "dimension_not_supported",
};

function planOf(
  code: string,
  shape: Shape,
  sources: SourceLookup,
  plans: Map<string, Plan>,
  visiting: Set<string> = new Set(),
): Plan {
  const known = plans.get(code);
  if (known) return known;
  if (visiting.has(code))
    throw new Error(`Metric engine: derived metric "${code}" refers to itself`);
  visiting.add(code);
  const plan = ((): Plan => {
    if (!shape.supported) return NOT_SUPPORTED;
    const source = sources.sourceOf(code);
    switch (source.kind) {
      case "unavailable":
        return {
          kind: "unavailable",
          reason: source.reason,
          ...(source.message ? { message: source.message } : {}),
        };
      case "current": {
        const keys = [
          ...(shape.byOutlet ? ["outlet"] : []),
          shape.splitKey,
          shape.filter?.key,
        ].filter((key): key is string => key != null);
        if (
          keys.some(
            (key) =>
              !(source.reader.dimensions as readonly string[]).includes(key),
          )
        )
          return NOT_SUPPORTED;
        return { kind: "current", reader: source.reader };
      }
      case "gl": {
        // The ledger cannot filter by a non-outlet dimension.
        if (shape.filter) return NOT_SUPPORTED;
        // A balance (tax_payable) is a tenant figure only: its settling
        // journals (the PBJT remittance is a manual or supplier payment
        // entry) may carry no outlet, so an outlet's share of it is unknown.
        if (
          source.gl.kind === "balance" &&
          (shape.byOutlet || shape.outletFiltered)
        )
          return NOT_SUPPORTED;
        if (shape.splitKey === null)
          return { kind: "gl", gl: source.gl, split: null };
        // The ledger carries the legal entity itself (journal_entries): an
        // amount or balance splits by it without operational rows. Entity x
        // outlet is not read; a percent follows the generic split below.
        if (shape.splitKey === LEGAL_ENTITY_DIMENSION) {
          if (shape.byOutlet) return NOT_SUPPORTED;
          if (source.gl.kind !== "ratio")
            return { kind: "gl", gl: source.gl, split: null };
        }
        // A percent split is recomputed from split numerator and denominator
        // (DECISIONS 2026-11-10 point 1): both codes split first, then
        // divided per split value; a side without that split answers
        // dimension_not_supported.
        if (source.gl.kind === "ratio") {
          const from = source.gl.splitFrom;
          if (!from) return NOT_SUPPORTED;
          for (const input of [from.numerator, from.denominator]) {
            const inputPlan = planOf(input, shape, sources, plans, visiting);
            if (inputPlan.kind === "unavailable") return inputPlan;
          }
          return {
            kind: "derived",
            numerator: from.numerator,
            denominator: from.denominator,
            scale: 100,
          };
        }
        if (source.gl.kind !== "amount") return NOT_SUPPORTED;
        const split = sources.splitOf(code, shape.splitKey);
        return split ? { kind: "gl", gl: source.gl, split } : NOT_SUPPORTED;
      }
      case "daily": {
        // Stored ratios never add up across days or outlets: a ratio is a
        // `derived` source.
        if (reportMetricByCode.get(code)?.aggregation === "ratio")
          return { kind: "unavailable", reason: "source_not_built" };
        const keys = [shape.splitKey, shape.filter?.key].filter(
          (key): key is string => key != null,
        );
        if (
          keys.some(
            (key) =>
              !(source.reader.dimensions as readonly string[]).includes(key),
          )
        )
          return NOT_SUPPORTED;
        // The average follows its weight only when the weight cannot be
        // read; a weight that is not a stored daily count cannot weight it.
        const weightCode = source.weightCode ?? null;
        if (weightCode !== null) {
          const weightPlan = planOf(
            weightCode,
            shape,
            sources,
            plans,
            visiting,
          );
          if (weightPlan.kind === "unavailable") return weightPlan;
          if (weightPlan.kind !== "daily") return NOT_SUPPORTED;
        }
        return { kind: "daily", reader: source.reader, weightCode };
      }
      case "share": {
        // Without the split an unsplit value would always read 100 %; a
        // filter would drop the siblings the total needs.
        if (shape.splitKey !== source.dimension || shape.filter)
          return NOT_SUPPORTED;
        const inputPlan = planOf(source.of, shape, sources, plans, visiting);
        if (inputPlan.kind === "unavailable") return inputPlan;
        return { kind: "share", of: source.of, dimension: source.dimension };
      }
      case "derived": {
        for (const input of [source.numerator, source.denominator]) {
          const inputPlan = planOf(input, shape, sources, plans, visiting);
          if (inputPlan.kind === "unavailable") return inputPlan;
        }
        return {
          kind: "derived",
          numerator: source.numerator,
          denominator: source.denominator,
          scale: source.scale,
        };
      }
    }
  })();
  visiting.delete(code);
  plans.set(code, plan);
  return plan;
}

type Cell = { value: MetricValue | null; final: boolean };
/** One split of a metric: its dimension values and one cell per range. */
type Group = { dims: MetricDimensionValue[]; cells: Cell[] };

const EMPTY_CELL: Cell = { value: null, final: true };
const groupKeyOf = (dims: readonly MetricDimensionValue[]) =>
  dims.map((dim) => `${dim.key}=${dim.value}`).join("|");

function definitionOf(code: string): MetricDefinition {
  const definition = reportMetricByCode.get(code);
  if (!definition)
    throw new HttpError(
      404,
      "METRIC_NOT_FOUND",
      `Metrik "${code}" tidak terdaftar.`,
    );
  return definition;
}

/**
 * Evaluates registry metrics inside the caller's snapshot transaction (the
 * single path from codes to values, DECISIONS 2026-11-10 point 2). One ledger
 * read and one `metrics_daily` read per call, whatever the number of codes.
 */
export async function evaluateMetrics(
  tx: Tx,
  context: ScopedTenantContext,
  request: EvaluateMetricsRequest,
  now: Date,
  options: EvaluateMetricsOptions = {},
): Promise<EvaluatedMetrics> {
  const sources = options.sources ?? REGISTRY_SOURCES;
  const definitions = resolveDefinitions(request.metricCodes);
  assertDimensions(
    definitions,
    [...request.groupBy, ...request.filters.map((filter) => filter.key)],
    request.viewer,
  );
  const tenantId = context.tenant.tenantId;
  const today =
    options.today ?? businessDateOf(now, DEFAULT_BUSINESS_DAY_CLOCK);
  const range: Range = request.period;
  const buckets = bucketsOf(range, request.bucket);
  if (monthsBetween(range.start, range.end).length > MAX_POINTS)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Periode terlalu panjang; pilih rentang yang lebih pendek.",
    );
  const previous = request.comparePrevious ? previousMetricRange(range) : null;
  const ranges = previous ? [...buckets, previous] : buckets;
  const currentCount = buckets.length;
  const outletFilter = request.outletFilter;

  const shape = shapeOf(request.groupBy, request.filters, outletFilter);
  const plans = new Map<string, Plan>();
  for (const definition of definitions)
    planOf(definition.code, shape, sources, plans);
  const responseDefinition = (
    definition: MetricDefinition,
  ): MetricDefinitionRef => {
    const ref = definitionRef(definition);
    return plans.get(definition.code)?.kind === "current"
      ? { ...ref, name: `${ref.name} (saat ini)` }
      : ref;
  };
  const officialityOf = (code: string): MetricOfficiality => {
    const plan = plans.get(code);
    if (plan?.kind === "gl") return "closed_period_only";
    if (plan?.kind === "derived") {
      const inputs = [plan.numerator, plan.denominator].map(officialityOf);
      if (inputs.includes("closed_period_only")) return "closed_period_only";
    }
    if (
      plan?.kind === "share" &&
      officialityOf(plan.of) === "closed_period_only"
    )
      return "closed_period_only";
    return definitionOf(code).officiality;
  };

  const books = await bookState(
    tx,
    tenantId,
    monthsBetween(range.start, range.end),
  );
  const closed = books.closed;
  const finalityOf = (
    bucket: Range,
    officiality: MetricOfficiality,
  ): MetricFinality => {
    const periodClosed = bucket.end < today;
    return metricValueFinality({
      officiality,
      periodClosed,
      accountingPeriodClosed:
        periodClosed &&
        monthsBetween(bucket.start, bucket.end).every((month) =>
          closed.has(month),
        ),
    });
  };
  /** The read-time rule of a range; the comparison range is never final. */
  const ruleFinal = (at: number, officiality: MetricOfficiality) =>
    at < currentCount && finalityOf(ranges[at]!, officiality) === "final";
  const periodStatus = range.end < today ? "closed" : "open";
  const accountingPeriodClosed =
    periodStatus === "closed" &&
    monthsBetween(range.start, range.end).every((month) => closed.has(month));

  // SH-02: refuse before reading any value, so no estimate can leak. An
  // unavailable metric has no value to refuse.
  if (request.requireFinal)
    for (const definition of definitions)
      if (
        plans.get(definition.code)?.kind !== "unavailable" &&
        (plans.get(definition.code)?.kind === "current" ||
          finalityOf(range, officialityOf(definition.code)) !== "final")
      )
        throw new HttpError(
          409,
          "PERIOD_NOT_CLOSED",
          "Angka resmi hanya tersedia untuk periode yang sudah ditutup.",
        );

  // Current balances are read once in this same tenant snapshot, never from
  // historical daily rows. Only the last requested bucket carries this value;
  // earlier buckets and period comparisons have no historic balance to show.
  const currentGroups = new Map<string, Group[]>();
  for (const [code, plan] of plans) {
    if (plan.kind !== "current") continue;
    const rows = await plan.reader.compute({ tx, tenantId, outletFilter, now });
    const values = new Map<
      string,
      { dims: MetricDimensionValue[]; native: bigint }
    >();
    if (!shape.byOutlet && shape.splitKey === null)
      values.set("", { dims: [], native: 0n });
    for (const row of rows) {
      if (row.value.unit !== definitionOf(code).unit)
        throw new Error(
          "Current metric reader value unit differs from the definition",
        );
      const dimension = (key: string) =>
        row.dimensions.find((dim) => dim.key === key);
      if (
        shape.filter &&
        !shape.filter.values.has(dimension(shape.filter.key)?.value ?? "")
      )
        continue;
      const dims: MetricDimensionValue[] = [];
      for (const key of [
        ...(shape.byOutlet ? ["outlet"] : []),
        ...(shape.splitKey ? [shape.splitKey] : []),
      ]) {
        const value = dimension(key);
        if (!value)
          throw new Error("Current metric reader omitted a declared dimension");
        dims.push(value);
      }
      const key = groupKeyOf(dims);
      const group = values.get(key) ?? { dims, native: 0n };
      group.native += nativeOf(row.value);
      values.set(key, group);
    }
    currentGroups.set(
      code,
      [...values.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, group]) => ({
          dims: group.dims,
          cells: ranges.map((_, at) => ({
            value:
              at === currentCount - 1
                ? valueOf(definitionOf(code).unit, group.native)
                : null,
            final: false,
          })),
        })),
    );
  }

  // One ledger read for every ledger code (inputs of derived codes included).
  const glPlans = [...plans.values()].flatMap((plan) =>
    plan.kind === "gl" ? [plan] : [],
  );
  const accounts = await componentAccounts(
    tx,
    tenantId,
    glPlans.flatMap((plan) => glComponentsOf(plan.gl)),
  );
  const balanceComponents = new Set(
    glPlans.flatMap((plan) =>
      plan.gl.kind === "balance" ? [plan.gl.component] : [],
    ),
  );
  const accountIdsOf = (balances: boolean) => [
    ...new Set(
      [...accounts.entries()].flatMap(([component, map]) =>
        balanceComponents.has(component) === balances ? [...map.keys()] : [],
      ),
    ),
  ];
  const ledger = await ledgerRows(
    tx,
    tenantId,
    accountIdsOf(false),
    { start: previous?.start ?? range.start, end: range.end },
    outletFilter,
  );
  // Balances read every line up to the period end, not only the period's.
  const balanceLedger = await ledgerRows(
    tx,
    tenantId,
    accountIdsOf(true),
    { start: null, end: range.end },
    outletFilter,
  );
  const index = new LedgerIndex(accounts, ledger, ranges, currentCount, {
    components: balanceComponents,
    rows: balanceLedger,
  });

  // One metrics_daily read for every stored code and ledger split.
  const storedCodes = [...plans.entries()].flatMap(([code, plan]) =>
    plan.kind === "daily" || (plan.kind === "gl" && plan.split) ? [code] : [],
  );
  const dimensionKeys = [
    ...new Set(
      [shape.splitKey, shape.filter?.key].filter(
        (key): key is string => key != null,
      ),
    ),
  ];
  const rowsByCode = new Map<string, DailyRow[]>();
  /** code → outlet key (or every outlet) → per range, days with a total row. */
  const coverage = new Map<string, Map<string, Set<string>[]>>();
  for (const row of await dailyRows(
    tx,
    tenantId,
    storedCodes,
    dimensionKeys,
    { start: previous?.start ?? range.start, end: range.end },
    outletFilter,
  )) {
    const at = rangeIndexOf(ranges, currentCount, row.date);
    if (at < 0) continue;
    const list = rowsByCode.get(row.code) ?? [];
    list.push({ ...row, range: at });
    rowsByCode.set(row.code, list);
    if (row.dimensionKey !== null || at >= currentCount) continue;
    const byOutlet = coverage.get(row.code) ?? new Map<string, Set<string>[]>();
    coverage.set(row.code, byOutlet);
    for (const key of [row.outletId, ALL_OUTLETS]) {
      const perRange = byOutlet.get(key) ?? ranges.map(() => new Set<string>());
      byOutlet.set(key, perRange);
      perRange[at]!.add(row.date);
    }
  }
  /**
   * A stored value or split is final only when every business day of its
   * bucket has a stored total row (dimension null) of the code, for the
   * group's outlet or, without an outlet split, for any outlet in the
   * filter. A missing day may hide activity the sum does not see (the job
   * refreshes only the last days), so it keeps the value an estimate.
   * Entity-level ledger lines have no operational rows to wait for.
   *
   * `ledgerOutlets` (ledger splits): without an outlet split, every outlet
   * that has a total row of the code or a journal line in the query must have
   * its own rows on every day, so the days of different outlets are never
   * pooled into one set and an outlet with lines but no rows is not skipped.
   */
  const covered = (
    code: string,
    outletKey: string,
    at: number,
    ledgerOutlets: readonly ReadonlySet<string>[] | null = null,
  ) => {
    if (outletKey === ENTITY_LEVEL) return true;
    if (at >= currentCount) return false;
    const bucket = ranges[at]!;
    const days = (toTime(bucket.end) - toTime(bucket.start)) / DAY_MS + 1;
    const byOutlet = coverage.get(code);
    if (ledgerOutlets === null || outletKey !== ALL_OUTLETS)
      return (byOutlet?.get(outletKey)?.[at]?.size ?? 0) === days;
    const outlets =
      outletFilter.kind === "outlets"
        ? outletFilter.outletIds
        : [
            ...new Set([
              ...[...(byOutlet?.keys() ?? [])].filter(
                (key) => key !== ALL_OUTLETS,
              ),
              ...[...ledgerOutlets[at]!].filter((key) => key !== ENTITY_LEVEL),
            ]),
          ];
    return (
      outlets.length > 0 &&
      outlets.every(
        (outlet) => (byOutlet?.get(outlet)?.[at]?.size ?? 0) === days,
      )
    );
  };

  // Entity-level lines get their own series only when they are in the query
  // at all: a tenant-wide reader without an outlet filter.
  const entityLevelVisible = outletFilter.kind === "all";
  const outletDim = (outletId: string): MetricDimensionValue => ({
    key: "outlet",
    value: outletId === ENTITY_LEVEL ? METRIC_ENTITY_LEVEL_OUTLET : outletId,
  });

  /** Ledger metric: total or outlet split, plus split rows and residual. */
  const ledgerGroups = (
    code: string,
    plan: Extract<Plan, { kind: "gl" }>,
  ): Group[] => {
    const splitRows = plan.split
      ? (rowsByCode.get(code) ?? []).filter(
          (row) => row.dimensionKey === shape.splitKey && row.unit === "idr",
        )
      : [];
    // groupBy outlet: one group per outlet with lines or split rows, sorted,
    // then the entity-level lines (outlet null) as "Tingkat badan usaha", so
    // the groups add up to the total (DASH-02).
    let outletGroups: { dim: MetricDimensionValue | null; key: string }[] = [
      { dim: null, key: ALL_OUTLETS },
    ];
    // Per range, the outlets with journal lines of the code.
    const ledgerOutlets = ranges.map(
      (_, at) =>
        new Set(
          glComponentsOf(plan.gl).flatMap((component) =>
            index.outletKeysAt(component, at),
          ),
        ),
    );
    if (shape.byOutlet) {
      const keys = new Set<string>();
      for (const component of glComponentsOf(plan.gl))
        for (const key of index.outletKeys(component, currentCount))
          keys.add(key);
      for (const row of splitRows)
        if (row.range < currentCount) keys.add(row.outletId);
      outletGroups = [...keys]
        .filter((key) => key !== ENTITY_LEVEL)
        .sort()
        .map((key) => ({ dim: outletDim(key), key }));
      if (entityLevelVisible && keys.has(ENTITY_LEVEL))
        outletGroups.push({ dim: outletDim(ENTITY_LEVEL), key: ENTITY_LEVEL });
    }
    const groups: Group[] = [];
    if (shape.splitKey === LEGAL_ENTITY_DIMENSION && !plan.split) {
      // One group per legal entity with lines of the code, sorted. Every line
      // (entity-level ones included) belongs to the entity of its journal
      // entry, so the groups add up to the tenant total (DASH-02).
      const keys = new Set<string>();
      for (const component of glComponentsOf(plan.gl))
        for (const key of index.legalEntityKeys(component, currentCount))
          keys.add(key);
      return [...keys].sort().map((key) => ({
        dims: [
          {
            key: LEGAL_ENTITY_DIMENSION,
            value: key.slice(LEGAL_ENTITY_PREFIX.length),
          },
        ],
        cells: ranges.map((_, at) => ({
          value: evaluate(plan.gl, index, at, key),
          final: ruleFinal(at, "closed_period_only"),
        })),
      }));
    }
    for (const outlet of outletGroups) {
      const totals: Cell[] = ranges.map((_, at) => ({
        value: evaluate(plan.gl, index, at, outlet.key),
        final: ruleFinal(at, "closed_period_only"),
      }));
      const head = outlet.dim ? [outlet.dim] : [];
      if (!plan.split || shape.splitKey === null) {
        groups.push({ dims: head, cells: totals });
        continue;
      }
      // Split rows carry the finality of the ledger total of their bucket,
      // and need a stored total row on every day of it; the residual row
      // makes them add up to that total.
      const splitFinal = totals.map(
        (total, at) =>
          total.final && covered(code, outlet.key, at, ledgerOutlets),
      );
      const sums = new Map<string, (bigint | null)[]>();
      for (const row of splitRows) {
        if (outlet.key !== ALL_OUTLETS && row.outletId !== outlet.key) continue;
        const perRange =
          sums.get(row.dimensionValue!) ?? ranges.map(() => null);
        perRange[row.range] = (perRange[row.range] ?? 0n) + row.native;
        sums.set(row.dimensionValue!, perRange);
      }
      const splitKey = shape.splitKey;
      for (const value of [...sums.keys()].sort())
        groups.push({
          dims: [...head, { key: splitKey, value }],
          cells: sums.get(value)!.map((sum, at) => ({
            value: sum === null ? null : idrValue(sum),
            final: splitFinal[at]!,
          })),
        });
      const residual = totals.map((total, at) => {
        const rowSum = [...sums.values()].reduce<bigint | null>(
          (acc, perRange) =>
            perRange[at] == null ? acc : (acc ?? 0n) + perRange[at]!,
          null,
        );
        if (total.value === null && rowSum === null) return null;
        return (total.value ? nativeOf(total.value) : 0n) - (rowSum ?? 0n);
      });
      if (
        residual.some(
          (value, at) => at < currentCount && value !== null && value !== 0n,
        )
      )
        groups.push({
          dims: [...head, { key: splitKey, value: METRIC_LEDGER_ADJUSTMENT }],
          cells: residual.map((value, at) => ({
            value: value === null ? null : idrValue(value),
            final: splitFinal[at]!,
          })),
        });
    }
    return groups;
  };

  /** Stored metric: sum (or latest/average) of metrics_daily rows per group. */
  const storedGroups = (code: string): Group[] => {
    const definition = definitionOf(code);
    const officiality = officialityOf(code);
    const readKey = shape.splitKey ?? shape.filter?.key ?? null;
    type Acc = {
      sum: bigint;
      count: bigint;
      /** Weighted average: Σ(value × weight) and Σ weight. */
      weighted: bigint;
      weight: bigint;
      /** Rows without a stored weight row: the bucket takes the plain mean. */
      unweighted: boolean;
      /** Plain mean of the rows whose volume is not a stored zero. */
      plainSum: bigint;
      plainCount: bigint;
      final: boolean;
      latest: Map<string, { date: string; native: bigint }>;
    };
    // The volume of each stored average row: same day, outlet and split.
    const plan = plans.get(code);
    const weightCode =
      definition.aggregation === "average" && plan?.kind === "daily"
        ? plan.weightCode
        : null;
    const rowKey = (row: DailyRow) =>
      `${row.date}|${row.outletId}|${row.dimensionKey ?? ""}|${row.dimensionValue ?? ""}`;
    const weights =
      weightCode === null
        ? null
        : new Map(
            (rowsByCode.get(weightCode) ?? []).map((row) => [
              rowKey(row),
              row.native,
            ]),
          );
    const byGroup = new Map<
      string,
      {
        dims: MetricDimensionValue[];
        outletKey: string;
        accs: (Acc | null)[];
      }
    >();
    if (!shape.byOutlet && shape.splitKey === null)
      byGroup.set("", {
        dims: [],
        outletKey: ALL_OUTLETS,
        accs: ranges.map(() => null),
      });
    for (const row of rowsByCode.get(code) ?? []) {
      if (row.dimensionKey !== readKey || row.unit !== definition.unit)
        continue;
      if (shape.filter && !shape.filter.values.has(row.dimensionValue ?? ""))
        continue;
      const dims: MetricDimensionValue[] = [];
      if (shape.byOutlet) dims.push(outletDim(row.outletId));
      if (shape.splitKey !== null)
        dims.push({ key: shape.splitKey, value: row.dimensionValue! });
      const key = groupKeyOf(dims);
      let group = byGroup.get(key);
      if (!group) {
        // A split exists only when it has a row in the current period.
        if (row.range >= currentCount) continue;
        byGroup.set(
          key,
          (group = {
            dims,
            outletKey: shape.byOutlet ? row.outletId : ALL_OUTLETS,
            accs: ranges.map(() => null),
          }),
        );
      }
      const acc = (group.accs[row.range] ??= {
        sum: 0n,
        count: 0n,
        weighted: 0n,
        weight: 0n,
        unweighted: false,
        plainSum: 0n,
        plainCount: 0n,
        final: true,
        latest: new Map(),
      });
      acc.sum += row.native;
      acc.count += 1n;
      // A missing weight row (rows stored before the weight was written) is
      // not a zero volume: a stored zero keeps the day out.
      const weight = weights?.get(rowKey(row));
      if (weight === undefined) acc.unweighted = true;
      if (weight === undefined || weight > 0n) {
        acc.plainSum += row.native;
        acc.plainCount += 1n;
      }
      if (weight !== undefined && weight > 0n) {
        acc.weighted += row.native * weight;
        acc.weight += weight;
      }
      acc.final &&= row.final;
      const latestKey = `${row.outletId}|${row.dimensionValue ?? ""}`;
      const latest = acc.latest.get(latestKey);
      if (!latest || latest.date < row.date)
        acc.latest.set(latestKey, { date: row.date, native: row.native });
    }
    const aggregate = (acc: Acc): bigint | null => {
      switch (definition.aggregation) {
        // A balance: the last day of the bucket per outlet and split value.
        case "latest":
          return [...acc.latest.values()].reduce(
            (sum, entry) => sum + entry.native,
            0n,
          );
        // Mean of the stored outlet-days, weighted by their volume when the
        // source declares a weight; no volume at all is no data. A bucket
        // with a day lacking its weight row takes the plain mean instead.
        case "average":
          if (weights === null)
            return divideRounded(acc.sum, acc.count, "half_up");
          if (acc.unweighted)
            return acc.plainCount === 0n
              ? null
              : divideRounded(acc.plainSum, acc.plainCount, "half_up");
          return acc.weight === 0n
            ? null
            : divideRounded(acc.weighted, acc.weight, "half_up");
        default:
          return acc.sum;
      }
    };
    return [...byGroup.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, group]) => ({
        dims: group.dims,
        cells: group.accs.map((acc, at) => {
          const native = acc ? aggregate(acc) : null;
          return {
            // An absent row is no data (null, never zero); a day without a
            // stored total row keeps the bucket an estimate.
            value: native === null ? null : valueOf(definition.unit, native),
            final:
              ruleFinal(at, officiality) &&
              (acc?.final ?? true) &&
              covered(code, group.outletKey, at),
          };
        }),
      }));
  };

  const groupsByCode = new Map<string, Group[]>();
  const groupsOf = (code: string): Group[] => {
    const known = groupsByCode.get(code);
    if (known) return known;
    const plan = plans.get(code)!;
    let groups: Group[];
    switch (plan.kind) {
      case "unavailable":
        groups = [];
        break;
      case "current":
        groups = currentGroups.get(code) ?? [];
        break;
      case "gl":
        groups = ledgerGroups(code, plan);
        break;
      case "daily":
        groups = storedGroups(code);
        break;
      case "share": {
        // Value / sum of the values sharing the other dimensions (the outlet),
        // per bucket; final only when every value of the sum is final.
        const unit = definitionOf(code).unit;
        const officiality = definitionOf(code).officiality;
        const parts = groupsOf(plan.of);
        const familyOf = (group: Group) =>
          groupKeyOf(group.dims.filter((dim) => dim.key !== plan.dimension));
        const totals = new Map<string, Cell[]>();
        for (const group of parts) {
          const family = familyOf(group);
          const cells = totals.get(family) ?? ranges.map(() => EMPTY_CELL);
          totals.set(
            family,
            cells.map((total, at) => {
              const cell = group.cells[at]!;
              return {
                value:
                  cell.value === null
                    ? total.value
                    : valueOf(
                        cell.value.unit,
                        (total.value ? nativeOf(total.value) : 0n) +
                          nativeOf(cell.value),
                      ),
                final: total.final && cell.final,
              };
            }),
          );
        }
        groups = parts.map((group) => {
          const total = totals.get(familyOf(group))!;
          return {
            dims: group.dims,
            cells: group.cells.map((cell, at) => ({
              value: ratioValue(cell.value, total[at]!.value, 100, unit),
              final: total[at]!.final && ruleFinal(at, officiality),
            })),
          };
        });
        break;
      }
      case "derived": {
        // Recomputed per bucket and group from its two inputs; final only
        // when both inputs are final.
        const unit = definitionOf(code).unit;
        const officiality = definitionOf(code).officiality;
        const numerator = new Map(
          groupsOf(plan.numerator).map((group) => [
            groupKeyOf(group.dims),
            group,
          ]),
        );
        const denominator = new Map(
          groupsOf(plan.denominator).map((group) => [
            groupKeyOf(group.dims),
            group,
          ]),
        );
        const keys = [
          ...numerator.keys(),
          ...[...denominator.keys()].filter((key) => !numerator.has(key)),
        ];
        groups = keys.map((key) => {
          const num = numerator.get(key);
          const den = denominator.get(key);
          return {
            dims: (num ?? den)!.dims,
            cells: ranges.map((_, at) => {
              const n = num?.cells[at] ?? EMPTY_CELL;
              const d = den?.cells[at] ?? EMPTY_CELL;
              return {
                value: ratioValue(n.value, d.value, plan.scale, unit),
                final: n.final && d.final && ruleFinal(at, officiality),
              };
            }),
          };
        });
        break;
      }
    }
    groupsByCode.set(code, groups);
    return groups;
  };

  const series: EvaluatedSeries[] = [];
  const availability: MetricAvailability[] = [];
  for (const definition of definitions) {
    const plan = plans.get(definition.code)!;
    const ref = responseDefinition(definition);
    if (plan.kind === "unavailable") {
      availability.push({
        metricCode: definition.code,
        status: "unavailable",
        reason: plan.reason,
        message: plan.message ?? METRIC_UNAVAILABLE_MESSAGES[plan.reason],
      });
      // "Belum tersedia": null points, never a zero.
      if (request.groupBy.length === 0) {
        const officiality = officialityOf(definition.code);
        series.push({
          metricCode: definition.code,
          definition: ref,
          dimension: null,
          dimensions: [],
          points: buckets.map((bucket) => ({
            bucketStart: bucket.start,
            bucketEnd: bucket.end,
            value: null,
            finality: finalityOf(bucket, officiality),
            comparison: null,
          })),
        });
      }
      continue;
    }
    availability.push({ metricCode: definition.code, status: "available" });
    for (const group of groupsOf(definition.code)) {
      const points: MetricPoint[] = buckets.map((bucket, at) => {
        const cell = group.cells[at]!;
        const before = previous ? group.cells[currentCount]! : null;
        return {
          bucketStart: bucket.start,
          bucketEnd: bucket.end,
          value: cell.value,
          finality: cell.final ? "final" : "estimate",
          comparison:
            request.bucket === "total" &&
            cell.value !== null &&
            before?.value != null
              ? compareMetricValues(cell.value, before.value)
              : null,
        };
      });
      series.push({
        metricCode: definition.code,
        definition: ref,
        dimension: group.dims.length === 1 ? group.dims[0]! : null,
        dimensions: group.dims,
        points,
      });
    }
  }

  let latest: string | null = null;
  for (const row of ledger)
    if (row.date >= range.start && (latest === null || row.date > latest))
      latest = row.date;
  for (const rows of rowsByCode.values())
    for (const row of rows)
      if (row.range < currentCount && (latest === null || row.date > latest))
        latest = row.date;
  return {
    definitions: definitions.map(responseDefinition),
    series,
    availability,
    period: {
      startDate: range.start,
      endDate: range.end,
      bucket: request.bucket,
      status: periodStatus,
      accountingPeriodClosed,
    },
    outletFilter,
    accountingPeriods: books.periods,
    dataThrough: (currentGroups.size > 0
      ? today
      : (latest ?? (range.end < today ? range.end : today))) as BusinessDate,
  };
}

/**
 * GET /api/metrics/query predates `dimension_not_supported`: it keeps
 * answering 400 for a ledger metric split by a dimension no split source
 * reads, or filtered at all (the ledger carries the outlet only).
 */
function assertLedgerDimensions(
  definitions: readonly MetricDefinition[],
  request: MetricQueryRequest,
  sources: SourceLookup,
) {
  for (const definition of definitions) {
    if (sources.sourceOf(definition.code).kind !== "gl") continue;
    if (
      request.groupBy &&
      request.groupBy !== "outlet" &&
      request.groupBy !== LEGAL_ENTITY_DIMENSION &&
      !sources.splitOf(definition.code, request.groupBy)
    )
      throw unsupportedDimension(definition.code, request.groupBy);
    for (const filter of request.filters ?? [])
      throw unsupportedDimension(definition.code, filter.key);
  }
}

export type QueryMetricsOptions = {
  viewer: MetricViewer;
  /** Clock for "today" (tests); defaults to the current instant. */
  now?: Date;
};

/**
 * Answers a metric query for the caller's scoped context. The context's
 * outlet scope is the TEN-03 boundary; the request never carries a tenant.
 * A thin wrapper over `evaluateMetrics` in one snapshot transaction.
 */
export async function queryMetrics(
  context: ScopedTenantContext,
  request: MetricQueryRequest,
  options: QueryMetricsOptions,
): Promise<MetricQueryResponse> {
  const now = options.now ?? new Date();
  const definitions = resolveDefinitions(request.metricCodes);
  const groupBy = request.groupBy ? [request.groupBy] : [];
  const filters = request.filters ?? [];
  assertDimensions(
    definitions,
    [...groupBy, ...filters.map((filter) => filter.key)],
    options.viewer,
  );
  assertLedgerDimensions(definitions, request, REGISTRY_SOURCES);
  const outletFilter = outletIdsForQuery(
    context.outletScope,
    request.outletIds,
  );
  const range: Range = {
    start: request.period.startDate,
    end: request.period.endDate,
  };
  // Validated before the transaction, as the period limits always were.
  bucketsOf(range, request.bucket);

  const evaluated = await withTenantSnapshot(context, (tx) =>
    evaluateMetrics(
      tx,
      context,
      {
        metricCodes: request.metricCodes,
        period: range,
        bucket: request.bucket,
        outletFilter,
        groupBy,
        filters,
        comparePrevious: request.comparePrevious,
        viewer: options.viewer,
        requireFinal: request.requireFinal,
      },
      now,
    ),
  );
  return metricQueryResponseSchema.parse({
    data: {
      period: evaluated.period,
      outletFilter: evaluated.outletFilter,
      definitions: evaluated.definitions,
      series: evaluated.series.map((series): MetricSeries => ({
        metricCode: series.metricCode,
        definition: series.definition,
        dimension: series.dimension,
        points: series.points,
      })),
      availability: evaluated.availability,
    },
    meta: {
      generatedAt: now.toISOString(),
      dataThrough: evaluated.dataThrough,
      accountingPeriods: evaluated.accountingPeriods,
    },
  });
}
