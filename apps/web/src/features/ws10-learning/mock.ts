// Mock mode for the WS-10 learning back office (`VITE_API_MOCK=true`), so every
// screen works with no API (docs/frontend.md "Typed endpoints and mock mode").
//
// Handlers behave like the API will: strict input parsing is done by the mock
// runtime, mutations keep their rows in an in-memory store, and every mutation
// honours its idempotency key (a replay returns the original row, a reused key
// with different content fails with IDEMPOTENCY_KEY_REUSED). Grading happens
// here, on the server side of `completeTraining`, against the fixtures' answer
// key; the key is never imported by a component.
//
// Reads that another feature already owns stay there: listAnnouncements,
// listEmployees, listPositions and getMyHrisProfile are registered in
// lib/mock/handlers/hris-directory.ts, which also exports the mock's signed-in
// employee and outlet.
import {
  announcementReceiptSchema,
  cafeLegendHrisFixtures,
  completeTraining,
  gradeTrainingAttempt,
  listKpiReviews,
  listSopDocuments,
  listTrainings,
  acknowledgeSopDocument,
  markAnnouncementRead,
  sopAcknowledgementSchema,
  trainingCompletionSchema,
  type Announcement,
  type AnnouncementReceipt,
  type KpiReview,
  type SopAcknowledgement,
  type SopDocument,
  type Training,
  type TrainingCompletion,
} from "@starter/shared/hris";
import { localDateOf } from "@starter/shared/core";
import { ApiError } from "../../lib/api/errors.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import {
  MOCK_ME,
  MOCK_OUTLET,
} from "../../lib/mock/handlers/hris-directory.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { addMonths } from "./lib.ts";

const fixtures = cafeLegendHrisFixtures;

type Replay = { fingerprint: string; id: string };

type LearningMockState = {
  kpiReviews: KpiReview[];
  sopDocuments: SopDocument[];
  acknowledgements: SopAcknowledgement[];
  trainings: Training[];
  completions: TrainingCompletion[];
  announcements: Announcement[];
  receipts: AnnouncementReceipt[];
  ackReplays: Record<string, Replay>;
  completionReplays: Record<string, Replay>;
  readReplays: Record<string, Replay>;
};

const store = createMockStore<LearningMockState>(() => ({
  kpiReviews: [...fixtures.kpiReviews],
  sopDocuments: [...fixtures.sopDocuments],
  acknowledgements: [...fixtures.sopAcknowledgements],
  trainings: [...fixtures.trainings],
  completions: [...fixtures.trainingCompletions],
  announcements: [...fixtures.announcements],
  receipts: [...fixtures.announcementReceipts],
  ackReplays: {},
  completionReplays: {},
  readReplays: {},
}));

function idempotencyConflict(): ApiError {
  return new ApiError(
    409,
    "IDEMPOTENCY_KEY_REUSED",
    "Kunci idempotensi sudah dipakai dengan isi yang berbeda.",
  );
}

function sortedSopDocuments(): SopDocument[] {
  return [...store.get().sopDocuments].sort(
    (left, right) =>
      left.title.localeCompare(right.title, "id-ID") ||
      right.version - left.version,
  );
}

// ---- KPI -----------------------------------------------------------------

registerMock(listKpiReviews, ({ query, scenario }) => {
  const rows = store
    .get()
    .kpiReviews.filter(
      (review) =>
        query.employeeId === undefined ||
        review.employeeId === query.employeeId,
    )
    .filter(
      (review) => query.reviewId === undefined || review.id === query.reviewId,
    )
    .filter(
      (review) =>
        query.periodYear === undefined ||
        review.periodStart.startsWith(`${query.periodYear}-`),
    )
    .slice()
    .sort(
      (left, right) =>
        right.periodStart.localeCompare(left.periodStart) ||
        left.employeeId.localeCompare(right.employeeId),
    );
  return paginateFixture(rows, query, (review) => review.id, scenario);
});

// ---- SOP -----------------------------------------------------------------

registerMock(listSopDocuments, ({ query, scenario }) => {
  const rows = sortedSopDocuments()
    .filter(
      (document) =>
        query.stationId === undefined || document.stationId === query.stationId,
    )
    .filter(
      (document) =>
        query.positionId === undefined ||
        document.positionId === query.positionId,
    );
  return paginateFixture(rows, query, (document) => document.id, scenario);
});

registerMock(acknowledgeSopDocument, ({ params, body }) => {
  const state = store.get();
  const sopDocument = state.sopDocuments.find(
    (document) => document.id === params.sopDocumentId,
  );
  if (!sopDocument)
    throw new ApiError(404, "NOT_FOUND", "Dokumen SOP tidak ditemukan.");
  const fingerprint = JSON.stringify([params.sopDocumentId]);
  const replay = state.ackReplays[body.idempotencyKey];
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw idempotencyConflict();
    const original = state.acknowledgements.find((row) => row.id === replay.id);
    if (original) return { data: original };
  }
  // Confirming the same version twice keeps one row per employee and version
  // (F29: the confirmation belongs to the exact version read).
  const existing = state.acknowledgements.find(
    (row) =>
      row.sopDocumentId === sopDocument.id &&
      row.employeeId.toLowerCase() === MOCK_ME.id.toLowerCase() &&
      row.documentVersion === sopDocument.version,
  );
  const acknowledgement =
    existing ??
    sopAcknowledgementSchema.parse({
      id: newIdempotencyKey(),
      tenantId: sopDocument.tenantId,
      sopDocumentId: sopDocument.id,
      employeeId: MOCK_ME.id,
      documentVersion: sopDocument.version,
      acknowledgedAt: new Date().toISOString(),
    });
  store.set({
    ...state,
    acknowledgements: existing
      ? state.acknowledgements
      : [...state.acknowledgements, acknowledgement],
    ackReplays: {
      ...state.ackReplays,
      [body.idempotencyKey]: { fingerprint, id: acknowledgement.id },
    },
  });
  return { data: acknowledgement };
});

// ---- Training ------------------------------------------------------------

registerMock(listTrainings, ({ query, scenario }) => {
  const rows = [...store.get().trainings]
    .filter(
      (training) =>
        query.stationId === undefined || training.stationId === query.stationId,
    )
    .filter(
      (training) =>
        query.positionId === undefined ||
        training.positionId === query.positionId,
    )
    .sort((left, right) => left.title.localeCompare(right.title, "id-ID"));
  return paginateFixture(rows, query, (training) => training.id, scenario);
});

registerMock(completeTraining, ({ params, body }) => {
  const state = store.get();
  const training = state.trainings.find(
    (candidate) => candidate.id === params.trainingId,
  );
  if (!training)
    throw new ApiError(404, "NOT_FOUND", "Modul pelatihan tidak ditemukan.");
  const fingerprint = JSON.stringify([params.trainingId, body.answers]);
  const replay = state.completionReplays[body.idempotencyKey];
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw idempotencyConflict();
    const original = state.completions.find((row) => row.id === replay.id);
    if (original) return { data: original };
  }
  const answerKey = fixtures.trainingAnswerKeys.find(
    (key) => key.trainingId === training.id,
  );
  if (!answerKey)
    throw new ApiError(
      409,
      "CONFLICT",
      "Kunci jawaban pelatihan tidak tersedia di server.",
    );
  const grade = gradeTrainingAttempt(training, answerKey, body.answers);
  const previousAttempts = state.completions.filter(
    (row) =>
      row.trainingId === training.id &&
      row.employeeId.toLowerCase() === MOCK_ME.id.toLowerCase(),
  ).length;
  const completedAt = new Date();
  const businessDate = localDateOf(
    completedAt.toISOString(),
    MOCK_OUTLET.timeZone,
  );
  const completion = trainingCompletionSchema.parse({
    id: newIdempotencyKey(),
    tenantId: training.tenantId,
    employeeId: MOCK_ME.id,
    trainingId: training.id,
    score: grade.score,
    passed: grade.passed,
    completedAt: completedAt.toISOString(),
    expiresOn:
      grade.passed && training.validityMonths > 0
        ? addMonths(businessDate, training.validityMonths)
        : null,
    attempts: previousAttempts + 1,
  });
  store.set({
    ...state,
    completions: [...state.completions, completion],
    completionReplays: {
      ...state.completionReplays,
      [body.idempotencyKey]: { fingerprint, id: completion.id },
    },
  });
  return { data: completion };
});

// ---- Announcements -------------------------------------------------------

registerMock(markAnnouncementRead, ({ params, body }) => {
  const state = store.get();
  const announcement = state.announcements.find(
    (candidate) => candidate.id === params.announcementId,
  );
  if (!announcement)
    throw new ApiError(404, "NOT_FOUND", "Pengumuman tidak ditemukan.");
  const fingerprint = JSON.stringify([
    params.announcementId,
    body.acknowledged,
  ]);
  const replay = state.readReplays[body.idempotencyKey];
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw idempotencyConflict();
    const original = state.receipts.find((row) => row.id === replay.id);
    if (original) return { data: original };
  }
  const readAt = new Date().toISOString();
  const existing = state.receipts.find(
    (row) =>
      row.announcementId === announcement.id &&
      row.employeeId.toLowerCase() === MOCK_ME.id.toLowerCase(),
  );
  const receipt =
    existing === undefined
      ? announcementReceiptSchema.parse({
          id: newIdempotencyKey(),
          tenantId: announcement.tenantId,
          announcementId: announcement.id,
          employeeId: MOCK_ME.id,
          readAt,
          acknowledgedAt: body.acknowledged ? readAt : null,
        })
      : announcementReceiptSchema.parse({
          ...existing,
          // Reading again keeps the first read time; only the confirmation can
          // be added later (PRD F29 "tanda terima").
          acknowledgedAt:
            existing.acknowledgedAt ?? (body.acknowledged ? readAt : null),
        });
  store.set({
    ...state,
    receipts: existing
      ? state.receipts.map((row) => (row.id === receipt.id ? receipt : row))
      : [...state.receipts, receipt],
    readReplays: {
      ...state.readReplays,
      [body.idempotencyKey]: { fingerprint, id: receipt.id },
    },
  });
  return { data: receipt };
});
