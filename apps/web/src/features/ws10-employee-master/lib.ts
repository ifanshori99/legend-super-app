// Pure helpers of the employee master back office (PRD v1.7 §3 F24, F26,
// HR-03): date and quantity formatting, the directory filters and metrics, and
// the org tree composed from `org_units` + `positions` + `employees` (the
// contract has no org-structure endpoint; the screen composes it). No React,
// no fetching, so every rule here is testable on its own.
import { businessDateOf } from "@starter/shared/core";
import type { BusinessDate } from "@starter/shared/core";
import {
  isContractExpiryReminderDue,
  type Employee,
  type EmployeeDocument,
  type EmployeeStatus,
  type EmploymentContract,
  type OrgUnit,
  type Position,
  type PositionGrade,
} from "@starter/shared/hris";
import type { Outlet } from "@starter/shared/platform";

/** The back office lists whole catalogs; screens filter and page in memory. */
export const LIST_LIMIT = 100;

/**
 * PRD F24 "pengingat sebelum kontrak habis": the directory tile reports the
 * next 30 days, the fixed window the tile names. The per-contract badge uses
 * the contract's own `reminderDaysBefore`, which the tenant configures.
 */
export const CONTRACT_ALERT_DAYS = 30;

export const HRIS_TIME_ZONE = "Asia/Jakarta";

/** A value the screen has no data for; never a fake 0 or an empty cell. */
export const DASH = "—";

/** One page of a cursor list, as the contract returns it (D-CORE-5). */
export type AnyPage = {
  data: unknown[];
  meta: { limit: number; nextCursor: string | null };
};

/**
 * Safety stop: 50 pages x 100 rows (PAGE_LIMIT_MAX). A catalog larger than
 * this is a data problem worth surfacing, not something to loop over forever.
 */
export const MAX_CATALOG_PAGES = 50;

/**
 * Fetches page after page until `meta.nextCursor` is null and returns one page
 * holding every row, so screens that filter in memory never see a silently
 * truncated catalog. Throws past `maxPages` instead of looping forever.
 */
export async function collectAllPages<T, P extends AnyPage>(
  fetchPage: (cursor: string | undefined) => Promise<P>,
  maxPages: number = MAX_CATALOG_PAGES,
): Promise<P> {
  let cursor: string | undefined;
  let merged: P | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const next = await fetchPage(cursor);
    merged =
      merged === undefined
        ? next
        : { ...next, data: [...merged.data, ...next.data] };
    if (next.meta.nextCursor === null) return merged;
    cursor = next.meta.nextCursor;
  }
  throw new Error(`List has more than ${maxPages} pages; narrow the query.`);
}

/** Today as a business date in the outlet time zone (D-CORE-6). */
export function businessDateToday(
  now: Date = new Date(),
  timeZone: string = HRIS_TIME_ZONE,
): BusinessDate {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
  }).format(now) as BusinessDate;
}

/**
 * A business date for display: calendar day, never an instant, so the same
 * string renders on the SSR server and in the browser.
 */
export function formatBusinessDate(value: string, locale = "id-ID"): string {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** An instant (ISO with offset) as its business-time-zone calendar day. */
export function formatInstantDate(iso: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: HRIS_TIME_ZONE,
  }).format(new Date(iso));
}

/** Whole days from `from` to `to`; negative when `to` is in the past. */
export function daysBetween(from: string, to: string): number {
  const day = 86_400_000;
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
      day,
  );
}

/**
 * Decimal4 text for display: trailing zeros dropped and id-ID separators
 * ("1.0000" → "1", "1234.5000" → "1.234,5"). No float round-trip, so a long
 * value never loses digits.
 */
export function formatDecimalText(value: string): string {
  const [rawWhole = "0", rawFraction = ""] = value.split(".");
  const negative = rawWhole.startsWith("-");
  const whole = negative ? rawWhole.slice(1) : rawWhole;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const fraction = rawFraction.replace(/0+$/, "");
  return `${negative ? "−" : ""}${grouped}${fraction ? `,${fraction}` : ""}`;
}

// ---- Catalogue labels ----------------------------------------------------

export function employeeName(
  employees: readonly Employee[],
  employeeId: string | null,
): string | null {
  if (employeeId === null) return null;
  return employees.find((row) => row.id === employeeId)?.fullName ?? null;
}

export function positionName(
  positions: readonly Position[],
  positionId: string | null,
): string | null {
  if (positionId === null) return null;
  return positions.find((row) => row.id === positionId)?.name ?? null;
}

export function orgUnitName(
  units: readonly OrgUnit[],
  unitId: string | null,
): string | null {
  if (unitId === null) return null;
  return units.find((row) => row.id === unitId)?.name ?? null;
}

export function outletName(
  outlets: readonly Outlet[],
  outletId: string,
): string | null {
  return outlets.find((row) => row.id === outletId)?.name ?? null;
}

export function gradeName(
  grades: readonly PositionGrade[],
  gradeId: string | null,
): string | null {
  if (gradeId === null) return null;
  return grades.find((row) => row.id === gradeId)?.name ?? null;
}

// ---- Directory -----------------------------------------------------------

export const ALL_FILTER = "all";

export type EmployeeFilters = {
  search?: string;
  /** `"all"` (or omitted) keeps every status. */
  status?: EmployeeStatus | typeof ALL_FILTER;
  /** `"all"` (or omitted) keeps every outlet. */
  outletId?: string;
};

export function filterEmployees(
  employees: readonly Employee[],
  filters: EmployeeFilters,
): Employee[] {
  const search = filters.search?.trim().toLocaleLowerCase("id-ID") ?? "";
  return employees
    .filter(
      (employee) =>
        filters.status === undefined ||
        filters.status === ALL_FILTER ||
        employee.status === filters.status,
    )
    .filter(
      (employee) =>
        filters.outletId === undefined ||
        filters.outletId === ALL_FILTER ||
        employee.homeOutletId === filters.outletId,
    )
    .filter(
      (employee) =>
        search === "" ||
        employee.fullName.toLocaleLowerCase("id-ID").includes(search) ||
        employee.employeeNo.toLocaleLowerCase("id-ID").includes(search),
    )
    .sort((left, right) =>
      left.fullName.localeCompare(right.fullName, "id-ID"),
    );
}

export type DirectoryMetrics = {
  active: number;
  onboarding: number;
  contractsDue: number;
  offboarding: number;
};

/**
 * True when an active contract's end date falls inside the next `days` days
 * (PRD F24 reminder). A past end date is not "due"; it is already over.
 */
export function contractEndsWithin(
  contract: EmploymentContract,
  today: string,
  days: number = CONTRACT_ALERT_DAYS,
): boolean {
  if (contract.status !== "active" || contract.endDate === null) return false;
  const left = daysBetween(today, contract.endDate);
  return left >= 0 && left <= days;
}

/** True when the contract's own reminder window is open (F24, `reminderDaysBefore`). */
export function contractReminderDue(
  contract: EmploymentContract,
  today: string,
): boolean {
  return isContractExpiryReminderDue(contract, today);
}

/** Days until an end date; null for a permanent contract. */
export function contractDaysLeft(
  contract: EmploymentContract,
  today: string,
): number | null {
  if (contract.endDate === null) return null;
  return daysBetween(today, contract.endDate);
}

/**
 * Directory metrics. `offboarding` counts the exit states of
 * `employees.status` (PRD F24 "Resign atau pemutusan"); the checklist itself
 * belongs to the lifecycle bead.
 */
export function directoryMetrics(
  employees: readonly Employee[],
  contracts: readonly EmploymentContract[],
  today: string,
): DirectoryMetrics {
  return {
    active: employees.filter((employee) => employee.status === "active").length,
    onboarding: employees.filter((employee) => employee.status === "onboarding")
      .length,
    contractsDue: contracts.filter((contract) =>
      contractEndsWithin(contract, today),
    ).length,
    offboarding: employees.filter(
      (employee) =>
        employee.status === "resigned" || employee.status === "terminated",
    ).length,
  };
}

/** Page count for an in-memory list. */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** One page of an in-memory list, clamped to the last page that exists. */
export function listPage<T>(
  rows: readonly T[],
  page: number,
  pageSize: number,
): { rows: T[]; page: number; totalPages: number } {
  const totalPages = pageCount(rows.length, pageSize);
  const safePage = Math.min(Math.max(1, page), totalPages);
  return {
    rows: rows.slice((safePage - 1) * pageSize, safePage * pageSize),
    page: safePage,
    totalPages,
  };
}

/** Loading/empty/error screenshots: ?mock=<scenario> must skip SSR loaders. */
export function isMockScenarioRequest(searchStr: string): boolean {
  const scenario = new URLSearchParams(searchStr).get("mock");
  return scenario !== null && scenario !== "normal";
}

// ---- Organisation --------------------------------------------------------

export type OrgNode = {
  unit: OrgUnit;
  /** Positions attached to this unit, sorted by name. */
  positions: Position[];
  /** Employees placed directly in this unit. */
  headcount: number;
  children: OrgNode[];
};

/**
 * Composes the unit tree (`org_units.parent_id`) with each unit's positions and
 * its direct headcount. Cycles and unknown parents cannot loop: a unit is
 * visited once, and only units reachable from a root are rendered.
 */
export function buildOrgTree(
  units: readonly OrgUnit[],
  positions: readonly Position[],
  employees: readonly Employee[],
): OrgNode[] {
  const childrenOf = new Map<string, OrgUnit[]>();
  for (const unit of units) {
    if (unit.parentId === null) continue;
    const siblings = childrenOf.get(unit.parentId) ?? [];
    siblings.push(unit);
    childrenOf.set(unit.parentId, siblings);
  }
  const positionsOf = new Map<string, Position[]>();
  for (const position of positions) {
    if (position.orgUnitId === null) continue;
    const rows = positionsOf.get(position.orgUnitId) ?? [];
    rows.push(position);
    positionsOf.set(position.orgUnitId, rows);
  }
  const headcountOf = new Map<string, number>();
  for (const employee of employees) {
    if (employee.orgUnitId === null) continue;
    headcountOf.set(
      employee.orgUnitId,
      (headcountOf.get(employee.orgUnitId) ?? 0) + 1,
    );
  }

  const seen = new Set<string>();
  function nodeFor(unit: OrgUnit): OrgNode {
    seen.add(unit.id);
    const children = (childrenOf.get(unit.id) ?? [])
      .filter((child) => !seen.has(child.id))
      .sort((left, right) => left.name.localeCompare(right.name, "id-ID"))
      .map(nodeFor);
    return {
      unit,
      positions: (positionsOf.get(unit.id) ?? [])
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name, "id-ID")),
      headcount: headcountOf.get(unit.id) ?? 0,
      children,
    };
  }

  const roots = units
    .filter(
      (unit) =>
        unit.parentId === null ||
        !units.some((candidate) => candidate.id === unit.parentId),
    )
    .sort((left, right) => left.name.localeCompare(right.name, "id-ID"))
    .filter((unit) => !seen.has(unit.id));

  return roots.map(nodeFor);
}

/**
 * Every position in the tenants catalogue with its unit/grade label and how
 * many employees hold it, sorted by unit then position. Positions without a
 * unit stay listed under "Tanpa unit" so none silently disappears.
 */
export type PositionRow = {
  position: Position;
  unit: OrgUnit | null;
  grade: PositionGrade | null;
  headcount: number;
};

export function positionRows(
  positions: readonly Position[],
  units: readonly OrgUnit[],
  grades: readonly PositionGrade[],
  employees: readonly Employee[],
): PositionRow[] {
  const headcounts = new Map<string, number>();
  for (const employee of employees) {
    if (employee.positionId === null) continue;
    headcounts.set(
      employee.positionId,
      (headcounts.get(employee.positionId) ?? 0) + 1,
    );
  }
  return positions
    .map((position) => ({
      position,
      unit: units.find((unit) => unit.id === position.orgUnitId) ?? null,
      grade: grades.find((grade) => grade.id === position.gradeId) ?? null,
      headcount: headcounts.get(position.id) ?? 0,
    }))
    .sort(
      (left, right) =>
        (left.unit?.name ?? "").localeCompare(
          right.unit?.name ?? "",
          "id-ID",
        ) || left.position.name.localeCompare(right.position.name, "id-ID"),
    );
}

/** Documents whose expiry date has passed (KTP, certificates: PRD §6 H). */
export function documentExpired(
  document: EmployeeDocument,
  today: string,
): boolean {
  return document.expiresOn !== null && document.expiresOn < today;
}

/** A document is verified only when the contract carries both actor and time. */
export function documentVerified(document: EmployeeDocument): boolean {
  return document.verifiedBy !== null && document.verifiedAt !== null;
}
