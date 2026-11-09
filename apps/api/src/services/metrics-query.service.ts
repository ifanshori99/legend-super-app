// Metric query runtime (PRD v1.7 §5 "Lapisan metrik baku", DASH-01/02, SH-01,
// SH-02; bead legend-cdta). One path answers dashboards, reports, the report
// builder, Tanya AI and MCP: the registry (`reportMetricByCode`) says what a
// code means, this service says what its value is.
//
// Rules:
// - I1: money metrics are sums of posted journal lines (journal_entries holds
//   posted entries only; reversals are their own entries and net out), picked
//   by statement section or posting role (metrics-gl-sources.ts). Orders and
//   payments are never read for a money figure. A money metric without a
//   ledger source answers null ("no data"), never a number from elsewhere.
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
// - Non-money metrics wait for `metrics_daily` (not built yet): they answer
//   null points with the right finality label.

import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  businessDateOf,
  DEFAULT_BUSINESS_DAY_CLOCK,
  divideRounded,
  formatDecimal4,
  idr,
  outletIdsForQuery,
  type BusinessDate,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { AccessError } from "@starter/shared/access";
import {
  compareMetricValues,
  METRIC_ENTITY_LEVEL_OUTLET,
  metricDefinitionRefSchema,
  metricQueryResponseSchema,
  metricValueFinality,
  type MetricAccountingPeriod,
  type MetricBucket,
  type MetricDefinition,
  type MetricDefinitionRef,
  type MetricDimensionValue,
  type MetricFinality,
  type MetricOfficiality,
  type MetricPoint,
  type MetricQueryRequest,
  type MetricQueryResponse,
  type MetricSeries,
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
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import {
  GL_METRIC_SOURCES,
  glComponentsOf,
  type GlComponent,
  type GlMetricSource,
} from "./metrics-gl-sources";

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

/** The ledger source of a definition, when its unit matches the source kind. */
function glSourceOf(definition: MetricDefinition): GlMetricSource | null {
  const source = GL_METRIC_SOURCES[definition.code];
  if (!source) return null;
  if (source.kind === "amount" && definition.unit !== "idr") return null;
  if (source.kind === "ratio" && definition.unit !== "percent") return null;
  return source;
}

function officialityOf(definition: MetricDefinition): MetricOfficiality {
  return glSourceOf(definition) ? "closed_period_only" : definition.officiality;
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

function assertDimensions(
  definitions: readonly MetricDefinition[],
  request: MetricQueryRequest,
  viewer: MetricViewer,
) {
  const keys = [
    ...(request.groupBy ? [request.groupBy] : []),
    ...(request.filters ?? []).map((filter) => filter.key),
  ];
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
  for (const definition of definitions) {
    for (const key of keys)
      if (!definition.dimensions.includes(key))
        throw unsupportedDimension(definition.code, key);
    if (!glSourceOf(definition)) continue;
    // The ledger only carries the outlet of a line.
    if (request.groupBy && request.groupBy !== "outlet")
      throw unsupportedDimension(definition.code, request.groupBy);
    for (const filter of request.filters ?? [])
      throw unsupportedDimension(definition.code, filter.key);
  }
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

/** accountId → sign, per component; first matching term wins. */
type ComponentAccounts = Map<string, 1 | -1>;

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
      for (const id of ids) if (!accounts.has(id)) accounts.set(id, term.sign);
    }
    result.set(component, accounts);
  }
  return result;
}

type LedgerRow = {
  accountId: string;
  date: string;
  outletId: string | null;
  /** credit − debit, whole rupiah. */
  net: bigint;
};

async function ledgerRows(
  tx: Tx,
  tenantId: string,
  accountIds: readonly string[],
  range: Range,
  outletFilter: ReturnType<typeof outletIdsForQuery>,
): Promise<LedgerRow[]> {
  if (accountIds.length === 0) return [];
  const rows = await tx
    .select({
      accountId: journalLines.accountId,
      date: journalEntries.entryDate,
      outletId: journalLines.outletId,
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
    .where(
      and(
        eq(journalLines.tenantId, tenantId),
        inArray(journalLines.accountId, [...accountIds]),
        gte(journalEntries.entryDate, range.start),
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
    );
  return rows.map((row) => ({
    accountId: row.accountId,
    date: row.date,
    outletId: row.outletId,
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

const outletKeyOf = (outletId: string | null) => outletId ?? ENTITY_LEVEL;

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
    private readonly ranges: readonly Range[],
    currentCount: number,
  ) {
    const byAccount = new Map<
      string,
      { component: GlComponent; sign: 1 | -1 }[]
    >();
    for (const [component, map] of accounts) {
      this.sums.set(
        component,
        ranges.map(() => new Map()),
      );
      for (const [accountId, sign] of map) {
        const list = byAccount.get(accountId) ?? [];
        list.push({ component, sign });
        byAccount.set(accountId, list);
      }
    }
    for (const row of rows) {
      const targets = byAccount.get(row.accountId);
      if (!targets) continue;
      const bucket = this.rangeIndexOf(row.date, currentCount);
      if (bucket < 0) continue;
      for (const { component, sign } of targets) {
        const byOutlet = this.sums.get(component)![bucket]!;
        const amount = sign === 1 ? row.net : -row.net;
        for (const key of [outletKeyOf(row.outletId), ALL_OUTLETS]) {
          const sum = byOutlet.get(key);
          if (sum) sum.value += amount;
          else byOutlet.set(key, { value: amount, hasData: true });
        }
      }
    }
  }

  private rangeIndexOf(date: string, currentCount: number): number {
    let low = 0;
    let high = currentCount - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const range = this.ranges[mid]!;
      if (date < range.start) high = mid - 1;
      else if (date > range.end) low = mid + 1;
      else return mid;
    }
    for (let at = currentCount; at < this.ranges.length; at++) {
      const range = this.ranges[at]!;
      if (date >= range.start && date <= range.end) return at;
    }
    return -1;
  }

  sum(component: GlComponent, range: number, outletKey: string): Sum {
    return this.sums.get(component)?.[range]?.get(outletKey) ?? NO_DATA;
  }

  /** Outlet keys (entity level included) with data for a component's buckets. */
  outletKeys(component: GlComponent, rangeCount: number): Set<string> {
    const keys = new Set<string>();
    const perRange = this.sums.get(component) ?? [];
    for (let at = 0; at < rangeCount; at++)
      for (const key of perRange[at]?.keys() ?? [])
        if (key !== ALL_OUTLETS) keys.add(key);
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
  if (source.kind === "amount") {
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

export type QueryMetricsOptions = {
  viewer: MetricViewer;
  /** Clock for "today" (tests); defaults to the current instant. */
  now?: Date;
};

/**
 * Answers a metric query for the caller's scoped context. The context's
 * outlet scope is the TEN-03 boundary; the request never carries a tenant.
 */
export async function queryMetrics(
  context: ScopedTenantContext,
  request: MetricQueryRequest,
  options: QueryMetricsOptions,
): Promise<MetricQueryResponse> {
  const now = options.now ?? new Date();
  const definitions = resolveDefinitions(request.metricCodes);
  assertDimensions(definitions, request, options.viewer);
  const outletFilter = outletIdsForQuery(
    context.outletScope,
    request.outletIds,
  );
  const tenantId = context.tenant.tenantId;
  const today = businessDateOf(now, DEFAULT_BUSINESS_DAY_CLOCK);
  const range: Range = {
    start: request.period.startDate,
    end: request.period.endDate,
  };
  const buckets = bucketsOf(range, request.bucket);
  if (monthsBetween(range.start, range.end).length > MAX_POINTS)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Periode terlalu panjang; pilih rentang yang lebih pendek.",
    );
  const previous = request.comparePrevious ? previousMetricRange(range) : null;

  return withTenantSnapshot(context, async (tx) => {
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
    const periodStatus = range.end < today ? "closed" : "open";
    const accountingPeriodClosed =
      periodStatus === "closed" &&
      monthsBetween(range.start, range.end).every((month) => closed.has(month));

    // SH-02: refuse before reading any value, so no estimate can leak.
    if (request.requireFinal)
      for (const definition of definitions)
        if (finalityOf(range, officialityOf(definition)) !== "final")
          throw new HttpError(
            409,
            "PERIOD_NOT_CLOSED",
            "Angka resmi hanya tersedia untuk periode yang sudah ditutup.",
          );

    const sources = new Map(
      definitions.map((definition) => [definition, glSourceOf(definition)]),
    );
    const components = [...sources.values()].flatMap((source) =>
      source ? glComponentsOf(source) : [],
    );
    const accounts = await componentAccounts(tx, tenantId, components);
    const accountIds = [
      ...new Set([...accounts.values()].flatMap((map) => [...map.keys()])),
    ];
    const rows = await ledgerRows(
      tx,
      tenantId,
      accountIds,
      { start: previous?.start ?? range.start, end: range.end },
      outletFilter,
    );
    const index = new LedgerIndex(
      accounts,
      rows,
      previous ? [...buckets, previous] : buckets,
      buckets.length,
    );
    const previousIndex = buckets.length;
    // Entity-level lines get their own series only when they are in the query
    // at all: a tenant-wide reader without an outlet filter.
    const entityLevelVisible = outletFilter.kind === "all";

    const series: MetricSeries[] = [];
    for (const definition of definitions) {
      const source = sources.get(definition) ?? null;
      const ref = definitionRef(definition);
      const officiality = officialityOf(definition);
      if (!source) {
        // No ledger source and no metrics_daily yet: honest "no data".
        if (!request.groupBy)
          series.push({
            metricCode: definition.code,
            definition: ref,
            dimension: null,
            points: buckets.map((bucket) => ({
              bucketStart: bucket.start,
              bucketEnd: bucket.end,
              value: null,
              finality: finalityOf(bucket, officiality),
              comparison: null,
            })),
          });
        continue;
      }
      // groupBy outlet: one series per outlet with lines, sorted, then the
      // entity-level lines (outlet null) as "Tingkat badan usaha", so the
      // series add up to the total (DASH-02).
      let groups: {
        dimension: MetricDimensionValue | null;
        outletKey: string;
      }[] = [{ dimension: null, outletKey: ALL_OUTLETS }];
      if (request.groupBy === "outlet") {
        const keys = new Set<string>();
        for (const component of glComponentsOf(source))
          for (const key of index.outletKeys(component, buckets.length))
            keys.add(key);
        groups = [...keys]
          .filter((key) => key !== ENTITY_LEVEL)
          .sort()
          .map((outletId) => ({
            dimension: { key: "outlet", value: outletId },
            outletKey: outletId,
          }));
        if (entityLevelVisible && keys.has(ENTITY_LEVEL))
          groups.push({
            dimension: { key: "outlet", value: METRIC_ENTITY_LEVEL_OUTLET },
            outletKey: ENTITY_LEVEL,
          });
      }
      for (const group of groups) {
        const points: MetricPoint[] = buckets.map((bucket, at) => {
          const value = evaluate(source, index, at, group.outletKey);
          let comparison = null;
          if (previous && request.bucket === "total" && value !== null) {
            const before = evaluate(
              source,
              index,
              previousIndex,
              group.outletKey,
            );
            if (before !== null)
              comparison = compareMetricValues(value, before);
          }
          return {
            bucketStart: bucket.start,
            bucketEnd: bucket.end,
            value,
            finality: finalityOf(bucket, officiality),
            comparison,
          };
        });
        series.push({
          metricCode: definition.code,
          definition: ref,
          dimension: group.dimension,
          points,
        });
      }
    }

    const latest = rows.reduce<string | null>(
      (max, row) =>
        row.date >= range.start && (max === null || row.date > max)
          ? row.date
          : max,
      null,
    );
    return metricQueryResponseSchema.parse({
      data: {
        period: {
          startDate: range.start,
          endDate: range.end,
          bucket: request.bucket,
          status: periodStatus,
          accountingPeriodClosed,
        },
        outletFilter,
        definitions: definitions.map(definitionRef),
        series,
      },
      meta: {
        generatedAt: now.toISOString(),
        dataThrough: latest ?? (range.end < today ? range.end : today),
        accountingPeriods: books.periods,
      },
    });
  });
}
