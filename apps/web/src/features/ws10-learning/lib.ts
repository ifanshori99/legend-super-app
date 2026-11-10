// Pure helpers of the WS-10 learning back office (bead legend-r0wz; PRD v1.7
// §3 F32): formatting, the derived KPI/SOP/training views that the contract
// does not model as entities, and the mock-scenario check. No React, no
// fetching.
import {
  type KpiDirection,
  type KpiReview,
  type KpiSource,
  type SopAcknowledgement,
  type SopDocument,
  type TrainingCompletion,
} from "@starter/shared/hris";

/** The back office lists whole catalogs; screens filter and page in memory. */
export const LIST_LIMIT = 100;

/** Outlet wall-clock zone (D-CORE-6), so SSR and the browser agree. */
const TIME_ZONE = "Asia/Jakarta";

const BUSINESS_DATE = new Intl.DateTimeFormat("id-ID", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const DATE_TIME = new Intl.DateTimeFormat("id-ID", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: TIME_ZONE,
});

const PERIOD = new Intl.DateTimeFormat("id-ID", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** "2026-10-31" → "31 Okt 2026". */
export function formatBusinessDate(date: string): string {
  return BUSINESS_DATE.format(new Date(`${date}T00:00:00.000Z`));
}

/** ISO timestamp in the outlet's zone, e.g. "26 Sep 2026, 09.00". */
export function formatDateTime(iso: string): string {
  return DATE_TIME.format(new Date(iso));
}

/** "2026-10" → "Oktober 2026". */
export function formatPeriod(period: string): string {
  return PERIOD.format(new Date(`${period}-01T00:00:00.000Z`));
}

/** The business month of a review period, e.g. "2026-10". */
export function periodOf(review: Pick<KpiReview, "periodStart">): string {
  return review.periodStart.slice(0, 7);
}

/**
 * Decimal4 text for display in the outlet's words: trailing zeros dropped and
 * id-ID separators ("300.0000" → "300", "4.5000" → "4,5"). No float
 * round-trip, so a long value never loses digits.
 */
export function formatDecimal(value: string): string {
  const [rawWhole = "0", rawFraction = ""] = value.split(".");
  const negative = rawWhole.startsWith("-");
  const whole = negative ? rawWhole.slice(1) : rawWhole;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const fraction = rawFraction.replace(/0+$/, "");
  return `${negative ? "−" : ""}${grouped}${fraction ? `,${fraction}` : ""}`;
}

/** A Decimal4 value with its unit, e.g. "300 detik". */
export function formatWithUnit(value: string, unit: string): string {
  return `${formatDecimal(value)} ${unit}`;
}

/**
 * The review's headline score: the rounded mean of its indicator scores.
 * Indicators not scored yet (null) are skipped; none scored gives 0.
 */
export function reviewAverageScore(review: Pick<KpiReview, "scores">): number {
  const scored = review.scores.flatMap((score) =>
    score.score === null ? [] : [score.score],
  );
  if (scored.length === 0) return 0;
  const total = scored.reduce((sum, value) => sum + value, 0);
  return Math.round(total / scored.length);
}

/**
 * Sources that contributed to a review. Null when the definitions are not
 * available (no endpoint serves them yet), so the screen can say so instead
 * of guessing.
 */
export function reviewSources(
  review: Pick<KpiReview, "scores">,
  definitions: readonly { id: string; source: KpiSource }[] | null,
): KpiSource[] | null {
  if (definitions === null) return null;
  const byId = new Map(
    definitions.map((definition) => [definition.id, definition]),
  );
  const sources = new Set<KpiSource>();
  for (const score of review.scores) {
    const definition = byId.get(score.kpiDefinitionId);
    if (definition) sources.add(definition.source);
  }
  return [...sources].sort((left, right) => left.localeCompare(right));
}

/**
 * How close the actual value is to the target, 0–100 for the bar. A
 * qualitative KPI (no target) returns null: there is nothing to compare.
 */
export function achievementPercent(
  direction: KpiDirection,
  target: string | null,
  actual: string | null,
): number | null {
  if (target === null || actual === null) return null;
  const targetValue = Number(target);
  const actualValue = Number(actual);
  if (!Number.isFinite(targetValue) || !Number.isFinite(actualValue))
    return null;
  const clamp = (value: number) =>
    Math.max(0, Math.min(100, Math.round(value)));
  if (direction === "higher_is_better") {
    if (targetValue <= 0) return actualValue > 0 ? 100 : 0;
    return clamp((actualValue / targetValue) * 100);
  }
  if (actualValue <= 0) return 100;
  if (targetValue <= 0) return 0;
  return clamp((targetValue / actualValue) * 100);
}

// ---- SOP -----------------------------------------------------------------

export type SopGroup = {
  key: string;
  title: string;
  positionId: string | null;
  /** Oldest first, so the last row is the version in force. */
  versions: SopDocument[];
};

/** One row per document family (title + scope), with its version history. */
export function groupSopDocuments(
  documents: readonly SopDocument[],
): SopGroup[] {
  const groups = new Map<string, SopGroup>();
  for (const document of documents) {
    const key = `${document.title}\u0000${document.positionId ?? ""}`;
    const group = groups.get(key);
    if (group) group.versions.push(document);
    else
      groups.set(key, {
        key,
        title: document.title,
        positionId: document.positionId,
        versions: [document],
      });
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      versions: [...group.versions].sort(
        (left, right) => left.version - right.version,
      ),
    }))
    .sort((left, right) => left.title.localeCompare(right.title, "id-ID"));
}

export function latestSopVersion(group: SopGroup): SopDocument {
  const latest = group.versions.at(-1);
  if (!latest) throw new RangeError("An SOP group always has one version");
  return latest;
}

/** Employees who confirmed this exact version, counted once each. */
export function acknowledgementCount(
  acknowledgements: readonly SopAcknowledgement[] | null,
  sopDocumentId: string,
  version: number,
): number | null {
  if (acknowledgements === null) return null;
  const employees = new Set(
    acknowledgements
      .filter(
        (acknowledgement) =>
          acknowledgement.sopDocumentId === sopDocumentId &&
          acknowledgement.documentVersion === version,
      )
      .map((acknowledgement) => acknowledgement.employeeId.toLowerCase()),
  );
  return employees.size;
}

/** True when this employee confirmed the exact version on screen. */
export function hasAcknowledged(
  acknowledgements: readonly SopAcknowledgement[] | null,
  sopDocumentId: string,
  version: number,
  employeeId: string | undefined,
): boolean {
  if (acknowledgements === null || employeeId === undefined) return false;
  return acknowledgements.some(
    (acknowledgement) =>
      acknowledgement.sopDocumentId === sopDocumentId &&
      acknowledgement.documentVersion === version &&
      acknowledgement.employeeId.toLowerCase() === employeeId.toLowerCase(),
  );
}

// ---- Training ------------------------------------------------------------

/** The employee's latest attempt at a training, or null. */
export function latestCompletion(
  completions: readonly TrainingCompletion[] | null,
  trainingId: string,
  employeeId: string | undefined,
): TrainingCompletion | null {
  if (completions === null || employeeId === undefined) return null;
  return (
    completions
      .filter(
        (completion) =>
          completion.trainingId === trainingId &&
          completion.employeeId.toLowerCase() === employeeId.toLowerCase(),
      )
      .sort(
        (left, right) =>
          Date.parse(right.completedAt) - Date.parse(left.completedAt),
      )
      .at(0) ?? null
  );
}

/**
 * Adds whole months to a business date, clamping to the last day of the
 * target month. Used only to show the certification expiry the contract
 * derives from `validityMonths` (PRD F29).
 */
export function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined)
    throw new RangeError(`Not a business date: ${date}`);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

// ---- Shared --------------------------------------------------------------

/** Loading/empty/error screenshots: ?mock=<scenario> must skip SSR loaders. */
export function isMockScenarioRequest(searchStr: string): boolean {
  const scenario = new URLSearchParams(searchStr).get("mock");
  return scenario !== null && scenario !== "normal";
}
