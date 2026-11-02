// Read models the WS-10 learning screens need but the HRIS contract does not
// expose yet (bead legend-r0wz; PRD v1.7 §3 F32). Recorded gaps, not invented
// endpoints:
//
// - KPI reviews reference `kpiDefinitionId`, but no endpoint lists KPI
//   definitions, so indicator names, targets and sources have no API source.
// - SOP acknowledgements and announcement receipts are write-only through
//   `acknowledgeSopDocument` / `markAnnouncementRead`; no list endpoint exists.
// - Training completions have no list endpoint either.
//
// In mock mode the demo fixtures answer these reads so every screen is
// reviewable; against the real API the functions return null and the screen
// shows an honest "not available from the API yet" note. Mutations still go
// through the contract endpoints; their response is recorded here so the next
// render (and a sibling screen in the same session) sees it. Vite inlines
// API_MOCK, so a production build drops the fixture import with the dead branch.
import {
  cafeLegendHrisFixtures,
  type AnnouncementReceipt,
  type KpiDefinition,
  type SopAcknowledgement,
  type TrainingCompletion,
} from "@starter/shared/hris";
import { API_MOCK } from "@/lib/api/mock-flag";

/** Rows written by this browser session, layered over the fixtures. */
const writtenAcknowledgements: SopAcknowledgement[] = [];
const writtenReceipts: AnnouncementReceipt[] = [];
const writtenCompletions: TrainingCompletion[] = [];

export function recordSopAcknowledgement(row: SopAcknowledgement): void {
  if (writtenAcknowledgements.some((known) => known.id === row.id)) return;
  writtenAcknowledgements.push(row);
}

export function recordAnnouncementReceipt(row: AnnouncementReceipt): void {
  const index = writtenReceipts.findIndex((known) => known.id === row.id);
  if (index === -1) writtenReceipts.push(row);
  else writtenReceipts[index] = row;
}

export function recordTrainingCompletion(row: TrainingCompletion): void {
  if (writtenCompletions.some((known) => known.id === row.id)) return;
  writtenCompletions.push(row);
}

export function fixtureKpiDefinitions(): readonly KpiDefinition[] | null {
  return API_MOCK ? cafeLegendHrisFixtures.kpiDefinitions : null;
}

export function fixtureSopAcknowledgements():
  readonly SopAcknowledgement[] | null {
  return API_MOCK
    ? [
        ...cafeLegendHrisFixtures.sopAcknowledgements,
        ...writtenAcknowledgements,
      ]
    : null;
}

export function fixtureAnnouncementReceipts():
  readonly AnnouncementReceipt[] | null {
  return API_MOCK
    ? [...cafeLegendHrisFixtures.announcementReceipts, ...writtenReceipts]
    : null;
}

export function fixtureTrainingCompletions():
  readonly TrainingCompletion[] | null {
  return API_MOCK
    ? [...cafeLegendHrisFixtures.trainingCompletions, ...writtenCompletions]
    : null;
}

/** The fixtures' reference "today", so demo metrics stay deterministic. */
export function fixtureReferenceDate(): string | null {
  return API_MOCK ? cafeLegendHrisFixtures.now.slice(0, 10) : null;
}
