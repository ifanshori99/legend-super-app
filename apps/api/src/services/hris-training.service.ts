// HRIS training, quizzes and certificates (PRD v1.7 §3 F32; bead
// legend-7df1). Routes: routes/hris-training.routes.ts. Tables:
// db/schema/hris-training.ts.
//
// - Manage = `hr.training.manage`. A training bound to a station needs that
//   station's outlet in reach; one without a station needs tenant reach.
// - The answer key (`training_questions.correct_option_index`) is read only by
//   `completeTraining` and never leaves this file: every response is built
//   from columns that exclude it.
// - Every quiz attempt is an immutable `training_completions` row; a passing
//   attempt also issues one `training_certificates` row.
// - Cross-outlet and foreign rows answer 404; a write aimed at an outlet
//   outside the caller's reach answers 403 OUTLET_OUT_OF_SCOPE.

import { randomBytes } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  encodeCursor,
  localDateOf,
  z,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  completeTraining as completeTrainingEndpoint,
  createTrainingInputSchema,
  enrollTrainingInputSchema,
  gradeTrainingAttempt,
  listTrainingCertificates as listTrainingCertificatesEndpoint,
  listTrainings as listTrainingsEndpoint,
  trainingAnswerKeySchema,
  trainingCertificateSchema,
  trainingCompletionSchema,
  trainingEnrollmentSchema,
  trainingEnrollmentStatusSchema,
  trainingSchema,
  type Training,
  type TrainingCertificate,
  type TrainingCompletion,
  type TrainingEnrollment,
  type TrainingEnrollmentStatus,
} from "@starter/shared/hris";
import { db } from "../db/index.ts";
import { employees, positions } from "../db/schema/hris.ts";
import {
  trainingCertificates,
  trainingCompletions,
  trainingEnrollments,
  trainingQuestions,
  trainings,
} from "../db/schema/hris-training.ts";
import { stations } from "../db/schema/menu.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  cursorPair as rawCursorPair,
  forbidden,
  loadHrisAccess,
  notFound,
  uniqueViolation,
  type HrisAccess,
  type HrisReach,
  type Tx,
} from "./hris-access.ts";

export const TRAINING_MANAGE_CODE = "hr.training.manage";
export const TRAINING_SELF_CODE = "self.sop.read";
export const TRAINING_MAX_ATTEMPTS = 100;
/** Quiz attempts one employee may make per training in a rolling 24 hours. */
export const TRAINING_ATTEMPTS_PER_DAY = 5;
/** A new attempt is allowed this many days before the certificate expires. */
export const TRAINING_RENEWAL_DAYS = 30;

type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};
type CreateInput = z.output<typeof createTrainingInputSchema>;
type EnrollInput = z.output<typeof enrollTrainingInputSchema>;
type ListQuery = z.output<typeof listTrainingsEndpoint.query>;
type CertificateQuery = z.output<typeof listTrainingCertificatesEndpoint.query>;
type CompleteInput = z.output<typeof completeTrainingEndpoint.body>;
type CursorQuery = { cursor?: string | undefined; limit: number };

const lower = (value: string) => value.toLowerCase();

/** `cursorPair` whose tie-break id is a UUID, so Postgres never sees junk. */
function cursorPair(cursor: string): [string, string] {
  const pair = rawCursorPair(cursor);
  if (!z.uuid().safeParse(pair[1]).success)
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  return pair;
}

function outletOutOfScope(): HttpError {
  return new HttpError(
    403,
    "OUTLET_OUT_OF_SCOPE",
    "Outlet ini di luar jangkauan akun Anda.",
  );
}

function reachAllows(reach: HrisReach, outletId: string): boolean {
  return (
    reach.kind === "tenant" ||
    reach.outletIds.some((id) => lower(id) === lower(outletId))
  );
}

function page<Row, T>(
  rows: Row[],
  limit: number,
  map: (row: Row) => T,
  keys: (row: Row) => [string, string],
): Page<T> {
  const data = rows.slice(0, limit);
  const last = data.at(-1);
  return {
    data: data.map(map),
    meta: {
      limit,
      nextCursor: rows.length > limit && last ? encodeCursor(keys(last)) : null,
    },
  };
}

// ----------------------------------------------------------------- viewers

type SelfViewer = {
  readonly employeeId: string;
  readonly homeOutletId: string;
  readonly positionId: string | null;
};
type Viewer = {
  /** `hr.training.manage` reach, or null. */
  readonly manage: HrisReach | null;
  /** The caller's own employee row, when they hold `self.sop.read`. */
  readonly self: SelfViewer | null;
};

/** Employee statuses that may take trainings (same list as hris-sop.service). */
const LEARNER_STATUSES: ("active" | "onboarding")[] = ["active", "onboarding"];

async function loadSelf(
  tx: Tx,
  context: ScopedTenantContext,
  access: HrisAccess,
): Promise<SelfViewer | null> {
  if (access.own === null || access.reach([TRAINING_SELF_CODE]) === null)
    return null;
  const [row] = await tx
    .select({ positionId: employees.positionId })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, context.tenant.tenantId),
        eq(employees.id, access.own.id),
        inArray(employees.status, LEARNER_STATUSES),
      ),
    )
    .limit(1);
  // Only a working employee takes quizzes and sees the self lists.
  if (!row) return null;
  return {
    employeeId: access.own.id,
    homeOutletId: access.own.homeOutletId,
    positionId: row.positionId,
  };
}

async function loadViewer(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
): Promise<Viewer & { access: HrisAccess }> {
  const access = await loadHrisAccess(tx, context, actorUserId);
  const manage = access.reach([TRAINING_MANAGE_CODE]);
  const self = await loadSelf(tx, context, access);
  // Holds the self code but is not a working employee (or has no row): 404.
  if (
    manage === null &&
    self === null &&
    access.reach([TRAINING_SELF_CODE]) !== null
  )
    throw notFound();
  return { access, manage, self };
}

async function loadManager(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
): Promise<{ actor: string; reach: HrisReach }> {
  const access = await loadHrisAccess(tx, context, actorUserId);
  const reach = access.reach([TRAINING_MANAGE_CODE]);
  if (reach === null) throw forbidden();
  return { actor: access.actorUserId, reach };
}

/**
 * SQL for "this viewer may see this training" over `trainings LEFT JOIN
 * stations`. Managers: no station, or a station inside their reach. Employees:
 * station/position match (no station = every outlet, no position = everyone)
 * or an enrolment.
 */
function visibleTo(
  tx: Tx,
  context: ScopedTenantContext,
  viewer: Viewer,
): SQL | undefined {
  const tenantId = context.tenant.tenantId;
  const parts: SQL[] = [];
  if (viewer.manage !== null) {
    const inReach =
      viewer.manage.kind === "tenant"
        ? sql`true`
        : inArray(stations.outletId, [...viewer.manage.outletIds]);
    parts.push(or(isNull(trainings.stationId), inReach)!);
  }
  if (viewer.self !== null) {
    const self = viewer.self;
    const stationMatch = or(
      isNull(trainings.stationId),
      eq(stations.outletId, self.homeOutletId),
    )!;
    const positionMatch =
      self.positionId === null
        ? isNull(trainings.positionId)
        : or(
            isNull(trainings.positionId),
            eq(trainings.positionId, self.positionId),
          )!;
    const enrolled = inArray(
      trainings.id,
      tx
        .select({ id: trainingEnrollments.trainingId })
        .from(trainingEnrollments)
        .where(
          and(
            eq(trainingEnrollments.tenantId, tenantId),
            eq(trainingEnrollments.employeeId, self.employeeId),
          ),
        ),
    );
    parts.push(or(and(stationMatch, positionMatch), enrolled)!);
  }
  return parts.length === 0 ? undefined : or(...parts);
}

type TrainingRow = typeof trainings.$inferSelect;
type PublicQuestionRow = {
  id: string;
  trainingId: string;
  prompt: string;
  options: string[];
  points: number;
};

/** Question columns without the answer key. */
async function publicQuestions(
  tx: Tx,
  tenantId: TenantId,
  trainingIds: string[],
): Promise<Map<string, PublicQuestionRow[]>> {
  const byTraining = new Map<string, PublicQuestionRow[]>();
  if (trainingIds.length === 0) return byTraining;
  const rows = await tx
    .select({
      id: trainingQuestions.id,
      trainingId: trainingQuestions.trainingId,
      prompt: trainingQuestions.prompt,
      options: trainingQuestions.options,
      points: trainingQuestions.points,
    })
    .from(trainingQuestions)
    .where(
      and(
        eq(trainingQuestions.tenantId, tenantId),
        inArray(trainingQuestions.trainingId, trainingIds),
      ),
    )
    .orderBy(
      asc(trainingQuestions.trainingId),
      asc(trainingQuestions.sortOrder),
    );
  for (const row of rows) {
    const list = byTraining.get(row.trainingId) ?? [];
    list.push(row);
    byTraining.set(row.trainingId, list);
  }
  return byTraining;
}

const toTraining = (
  row: TrainingRow,
  questions: PublicQuestionRow[],
): Training =>
  trainingSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    title: row.title,
    description: row.description,
    stationId: row.stationId,
    positionId: row.positionId,
    questions: questions.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      options: question.options,
      points: question.points,
    })),
    passingScore: row.passingScore,
    validityMonths: row.validityMonths,
    scheduledStart: row.scheduledStart?.toISOString() ?? null,
    scheduledEnd: row.scheduledEnd?.toISOString() ?? null,
  });

/** One training the viewer may see, or null (= 404). */
async function loadVisibleTraining(
  tx: Tx,
  context: ScopedTenantContext,
  viewer: Viewer,
  trainingId: string,
): Promise<TrainingRow | null> {
  const visible = visibleTo(tx, context, viewer);
  if (visible === undefined) return null;
  const [row] = await tx
    .select({ training: trainings })
    .from(trainings)
    .leftJoin(
      stations,
      and(
        eq(stations.tenantId, trainings.tenantId),
        eq(stations.id, trainings.stationId),
      ),
    )
    .where(
      and(
        eq(trainings.tenantId, context.tenant.tenantId),
        eq(trainings.id, trainingId),
        visible,
      ),
    )
    .limit(1);
  return row?.training ?? null;
}

// ------------------------------------------------------------------ create

/** Station/tenant reach rule for a write (shared with SOP: 403 outside reach). */
async function assertTarget(
  tx: Tx,
  context: ScopedTenantContext,
  reach: HrisReach,
  stationId: string | null,
  positionId: string | null,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  if (stationId === null) {
    if (reach.kind !== "tenant") throw outletOutOfScope();
  } else {
    const [station] = await tx
      .select({ outletId: stations.outletId })
      .from(stations)
      .where(and(eq(stations.tenantId, tenantId), eq(stations.id, stationId)))
      .limit(1);
    if (!station) throw notFound("Station");
    if (!reachAllows(reach, station.outletId)) throw outletOutOfScope();
  }
  if (positionId !== null) {
    const [position] = await tx
      .select({ id: positions.id })
      .from(positions)
      .where(
        and(eq(positions.tenantId, tenantId), eq(positions.id, positionId)),
      )
      .limit(1);
    if (!position) throw notFound("Posisi");
  }
}

export async function createTraining(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateInput,
): Promise<Training> {
  return withTenant(db, context, async (tx) => {
    const { actor, reach } = await loadManager(tx, context, actorUserId);
    await assertTarget(tx, context, reach, input.stationId, input.positionId);
    const tenantId = context.tenant.tenantId;
    const [row] = await tx
      .insert(trainings)
      .values({
        tenantId,
        title: input.title,
        description: input.description,
        stationId: input.stationId,
        positionId: input.positionId,
        passingScore: input.passingScore,
        validityMonths: input.validityMonths,
        scheduledStart: input.scheduledStart
          ? new Date(input.scheduledStart)
          : null,
        scheduledEnd: input.scheduledEnd ? new Date(input.scheduledEnd) : null,
        createdBy: actor as TrainingRow["createdBy"],
      })
      .returning();
    if (!row) throw new Error("Training insert returned no row");
    await tx.insert(trainingQuestions).values(
      input.questions.map((question, index) => ({
        tenantId,
        trainingId: row.id,
        sortOrder: index,
        prompt: question.prompt,
        options: question.options,
        points: question.points,
        correctOptionIndex: question.correctOptionIndex,
      })),
    );
    const questions = await publicQuestions(tx, tenantId, [row.id]);
    return toTraining(row, questions.get(row.id) ?? []);
  });
}

// -------------------------------------------------------------------- list

export async function listTrainings(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListQuery,
): Promise<Page<Training>> {
  return withTenant(db, context, async (tx) => {
    const viewer = await loadViewer(tx, context, actorUserId);
    const visible = visibleTo(tx, context, viewer);
    if (visible === undefined) throw forbidden();
    const filters: SQL[] = [
      eq(trainings.tenantId, context.tenant.tenantId),
      visible,
    ];
    if (query.stationId) filters.push(eq(trainings.stationId, query.stationId));
    if (query.positionId)
      filters.push(eq(trainings.positionId, query.positionId));
    if (query.cursor) {
      const [title, id] = cursorPair(query.cursor);
      filters.push(
        or(
          gt(trainings.title, title),
          and(eq(trainings.title, title), gt(trainings.id, id)),
        )!,
      );
    }
    const rows = await tx
      .select({ training: trainings })
      .from(trainings)
      .leftJoin(
        stations,
        and(
          eq(stations.tenantId, trainings.tenantId),
          eq(stations.id, trainings.stationId),
        ),
      )
      .where(and(...filters))
      .orderBy(asc(trainings.title), asc(trainings.id))
      .limit(query.limit + 1);
    const pageRows = rows.slice(0, query.limit).map((row) => row.training);
    const questions = await publicQuestions(
      tx,
      context.tenant.tenantId,
      pageRows.map((row) => row.id),
    );
    const byId = new Map(pageRows.map((row) => [row.id, row]));
    return page(
      rows.map((row) => row.training),
      query.limit,
      (row) => toTraining(byId.get(row.id)!, questions.get(row.id) ?? []),
      (row) => [row.title, row.id],
    );
  });
}

// ---------------------------------------------------------------- complete

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function randomBase32(length: number): string {
  return Array.from(randomBytes(length), (byte) => BASE32[byte & 31]).join("");
}

/** `date` + `months` calendar months, the day clamped to the month's end. */
export function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const total = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(total / 12);
  const nextMonth = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
  const pad = (value: number, size: number) =>
    String(value).padStart(size, "0");
  return `${pad(nextYear, 4)}-${pad(nextMonth, 2)}-${pad(Math.min(day, lastDay), 2)}`;
}

/** `date` + `days` calendar days. */
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function certificateNumber(completedAt: Date): string {
  return `CERT-${localDateOf(completedAt).replaceAll("-", "")}-${randomBase32(6)}`;
}

type CompletionRow = typeof trainingCompletions.$inferSelect;

const toCompletion = (row: CompletionRow): TrainingCompletion =>
  trainingCompletionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    employeeId: row.employeeId,
    trainingId: row.trainingId,
    score: row.score,
    passed: row.passed,
    completedAt: row.completedAt.toISOString(),
    expiresOn: row.expiresOn,
    attempts: row.attemptNumber,
  });

export async function completeTraining(
  context: ScopedTenantContext,
  actorUserId: string,
  trainingId: string,
  input: CompleteInput,
  now = new Date(),
): Promise<TrainingCompletion> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId);
    if (access.reach([TRAINING_SELF_CODE]) === null) throw forbidden();
    const self = await loadSelf(tx, context, access);
    if (self === null) throw notFound();
    const tenantId = context.tenant.tenantId;

    const replay = async (): Promise<TrainingCompletion | null> => {
      const [existing] = await tx
        .select()
        .from(trainingCompletions)
        .where(
          and(
            eq(trainingCompletions.tenantId, tenantId),
            eq(trainingCompletions.employeeId, self.employeeId),
            eq(trainingCompletions.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (!existing) return null;
      if (existing.trainingId !== trainingId)
        throw new HttpError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "Kunci idempotensi sudah dipakai untuk permintaan lain.",
        );
      return toCompletion(existing);
    };
    const replayed = await replay();
    if (replayed) return replayed;

    const training = await loadVisibleTraining(
      tx,
      context,
      { manage: null, self },
      trainingId,
    );
    if (!training) throw notFound("Pelatihan");

    // A scheduled training only takes attempts inside its window.
    if (
      (training.scheduledStart && now < training.scheduledStart) ||
      (training.scheduledEnd && now > training.scheduledEnd)
    )
      throw new HttpError(
        409,
        "TRAINING_OUTSIDE_SCHEDULE",
        "Pelatihan ini belum dibuka atau sudah ditutup.",
      );

    // No new attempt while a certificate is still valid (renewal opens in
    // the last TRAINING_RENEWAL_DAYS before it expires).
    const [certificate] = await tx
      .select({ id: trainingCertificates.id })
      .from(trainingCertificates)
      .where(
        and(
          eq(trainingCertificates.tenantId, tenantId),
          eq(trainingCertificates.trainingId, trainingId),
          eq(trainingCertificates.employeeId, self.employeeId),
          or(
            isNull(trainingCertificates.expiresOn),
            gt(
              trainingCertificates.expiresOn,
              addDays(localDateOf(now), TRAINING_RENEWAL_DAYS),
            ),
          ),
        ),
      )
      .limit(1);
    if (certificate)
      throw new HttpError(
        409,
        "TRAINING_CERTIFICATE_ACTIVE",
        "Sertifikat pelatihan ini masih berlaku.",
      );

    // The answer key: the only place `correct_option_index` is read.
    const keyRows = await tx
      .select({
        id: trainingQuestions.id,
        prompt: trainingQuestions.prompt,
        options: trainingQuestions.options,
        points: trainingQuestions.points,
        correctOptionIndex: trainingQuestions.correctOptionIndex,
      })
      .from(trainingQuestions)
      .where(
        and(
          eq(trainingQuestions.tenantId, tenantId),
          eq(trainingQuestions.trainingId, trainingId),
        ),
      )
      .orderBy(asc(trainingQuestions.sortOrder));
    const questionIds = new Set(keyRows.map((row) => row.id));
    const given = new Set<string>();
    for (const answer of input.answers) {
      if (!questionIds.has(answer.questionId) || given.has(answer.questionId))
        throw new HttpError(
          422,
          "TRAINING_ANSWER_INVALID",
          "Jawaban tidak sesuai dengan soal pelatihan.",
        );
      given.add(answer.questionId);
    }
    // Every question must be answered, so a blank answer cannot probe the key.
    if (given.size !== questionIds.size)
      throw new HttpError(
        422,
        "TRAINING_ANSWERS_INCOMPLETE",
        "Jawab semua soal pelatihan.",
      );
    const grade = gradeTrainingAttempt(
      {
        passingScore: training.passingScore,
        questions: keyRows.map((row) => ({
          id: row.id,
          prompt: row.prompt,
          options: row.options,
          points: row.points,
        })) as Training["questions"],
      },
      trainingAnswerKeySchema.parse({
        trainingId,
        answers: keyRows.map((row) => ({
          questionId: row.id,
          correctOptionIndex: row.correctOptionIndex,
        })),
      }),
      input.answers,
    );
    // The completion contract forbids a passing zero score (passing score 0).
    const passed = grade.passed && grade.score > 0;

    const [recent] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(trainingCompletions)
      .where(
        and(
          eq(trainingCompletions.tenantId, tenantId),
          eq(trainingCompletions.trainingId, trainingId),
          eq(trainingCompletions.employeeId, self.employeeId),
          gt(
            trainingCompletions.completedAt,
            new Date(now.getTime() - 86_400_000),
          ),
        ),
      );
    if ((recent?.count ?? 0) >= TRAINING_ATTEMPTS_PER_DAY)
      throw new HttpError(
        429,
        "TRAINING_ATTEMPTS_RATE_LIMITED",
        "Terlalu banyak percobaan kuis. Coba lagi besok.",
      );

    const [last] = await tx
      .select({ attemptNumber: trainingCompletions.attemptNumber })
      .from(trainingCompletions)
      .where(
        and(
          eq(trainingCompletions.tenantId, tenantId),
          eq(trainingCompletions.trainingId, trainingId),
          eq(trainingCompletions.employeeId, self.employeeId),
        ),
      )
      .orderBy(desc(trainingCompletions.attemptNumber))
      .limit(1);
    const attemptNumber = (last?.attemptNumber ?? 0) + 1;
    if (attemptNumber > TRAINING_MAX_ATTEMPTS)
      throw new HttpError(
        409,
        "TRAINING_ATTEMPTS_EXHAUSTED",
        "Batas percobaan kuis sudah tercapai.",
      );

    const expiresOn =
      passed && training.validityMonths > 0
        ? addMonths(localDateOf(now), training.validityMonths)
        : null;
    const inserted = await tx
      .insert(trainingCompletions)
      .values({
        tenantId,
        trainingId,
        employeeId: self.employeeId,
        attemptNumber,
        score: grade.score,
        passed,
        answers: input.answers,
        completedAt: now,
        expiresOn,
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoNothing({
        target: [
          trainingCompletions.tenantId,
          trainingCompletions.employeeId,
          trainingCompletions.idempotencyKey,
        ],
      })
      .returning()
      .catch((error: unknown) => {
        // A concurrent attempt took the same attempt number.
        if (uniqueViolation(error))
          throw new HttpError(
            409,
            "CONFLICT",
            "Percobaan kuis lain sedang diproses. Coba lagi.",
          );
        throw error;
      });
    const [completion] = inserted;
    if (!completion) {
      // Same key inserted concurrently: replay the winner.
      const winner = await replay();
      if (winner) return winner;
      throw new Error("Training completion insert returned no row");
    }

    if (passed) {
      let issued = false;
      for (let tries = 0; tries < 5 && !issued; tries += 1) {
        const rows = await tx
          .insert(trainingCertificates)
          .values({
            tenantId,
            trainingId,
            employeeId: self.employeeId,
            completionId: completion.id,
            certificateNumber: certificateNumber(now),
            issuedAt: now,
            expiresOn,
          })
          .onConflictDoNothing({
            target: [
              trainingCertificates.tenantId,
              trainingCertificates.certificateNumber,
            ],
          })
          .returning({ id: trainingCertificates.id });
        issued = rows.length > 0;
      }
      if (!issued) throw new Error("Could not allocate a certificate number");
    }
    return toCompletion(completion);
  });
}

// ----------------------------------------------------------------- enroll

type EnrollmentRow = typeof trainingEnrollments.$inferSelect;

const toEnrollment = (row: EnrollmentRow): TrainingEnrollment =>
  trainingEnrollmentSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    trainingId: row.trainingId,
    employeeId: row.employeeId,
    enrolledAt: row.enrolledAt.toISOString(),
    dueOn: row.dueOn,
  });

export async function enrollTraining(
  context: ScopedTenantContext,
  actorUserId: string,
  trainingId: string,
  input: EnrollInput,
  now = new Date(),
): Promise<TrainingEnrollment[]> {
  return withTenant(db, context, async (tx) => {
    const { actor, reach } = await loadManager(tx, context, actorUserId);
    const tenantId = context.tenant.tenantId;
    const training = await loadVisibleTraining(
      tx,
      context,
      { manage: reach, self: null },
      trainingId,
    );
    if (!training) throw notFound("Pelatihan");

    const employeeIds = [...new Set(input.employeeIds.map(lower))];
    const found = await tx
      .select({ id: employees.id, homeOutletId: employees.homeOutletId })
      .from(employees)
      .where(
        and(
          eq(employees.tenantId, tenantId),
          inArray(employees.id, employeeIds),
          inArray(employees.status, LEARNER_STATUSES),
        ),
      );
    // One foreign or out-of-reach employee fails the whole request.
    if (
      found.length !== employeeIds.length ||
      found.some((row) => !reachAllows(reach, row.homeOutletId))
    )
      throw notFound();

    const enrollment = tx.insert(trainingEnrollments).values(
      employeeIds.map((employeeId) => ({
        tenantId,
        trainingId,
        employeeId,
        enrolledBy: actor as EnrollmentRow["enrolledBy"],
        enrolledAt: now,
        dueOn: input.dueOn,
      })),
    );
    const target = [
      trainingEnrollments.tenantId,
      trainingEnrollments.trainingId,
      trainingEnrollments.employeeId,
    ];
    // A new due date moves an existing enrolment; no due date leaves it as is.
    await (input.dueOn === null
      ? enrollment.onConflictDoNothing({ target })
      : enrollment.onConflictDoUpdate({
          target,
          set: { dueOn: input.dueOn },
        }));
    const rows = await tx
      .select()
      .from(trainingEnrollments)
      .where(
        and(
          eq(trainingEnrollments.tenantId, tenantId),
          eq(trainingEnrollments.trainingId, trainingId),
          inArray(trainingEnrollments.employeeId, employeeIds),
        ),
      );
    const byEmployee = new Map(rows.map((row) => [row.employeeId, row]));
    return employeeIds.map((id) => toEnrollment(byEmployee.get(id)!));
  });
}

export async function listTrainingEnrollments(
  context: ScopedTenantContext,
  actorUserId: string,
  trainingId: string,
  query: CursorQuery,
): Promise<Page<TrainingEnrollmentStatus>> {
  return withTenant(db, context, async (tx) => {
    const { reach } = await loadManager(tx, context, actorUserId);
    const tenantId = context.tenant.tenantId;
    const training = await loadVisibleTraining(
      tx,
      context,
      { manage: reach, self: null },
      trainingId,
    );
    if (!training) throw notFound("Pelatihan");

    const filters: SQL[] = [
      eq(trainingEnrollments.tenantId, tenantId),
      eq(trainingEnrollments.trainingId, trainingId),
    ];
    if (reach.kind === "outlets")
      filters.push(inArray(employees.homeOutletId, [...reach.outletIds]));
    if (query.cursor) {
      const [name, id] = cursorPair(query.cursor);
      filters.push(
        or(
          gt(employees.fullName, name),
          and(eq(employees.fullName, name), gt(trainingEnrollments.id, id)),
        )!,
      );
    }
    const rows = await tx
      .select({
        enrollment: trainingEnrollments,
        employeeName: employees.fullName,
        homeOutletId: employees.homeOutletId,
      })
      .from(trainingEnrollments)
      .innerJoin(
        employees,
        and(
          eq(employees.tenantId, trainingEnrollments.tenantId),
          eq(employees.id, trainingEnrollments.employeeId),
        ),
      )
      .where(and(...filters))
      .orderBy(asc(employees.fullName), asc(trainingEnrollments.id))
      .limit(query.limit + 1);

    const pageEmployees = rows
      .slice(0, query.limit)
      .map((row) => row.enrollment.employeeId);
    const attempts = new Map<
      string,
      { count: number; best: number | null; passed: boolean }
    >();
    const certificates = new Map<
      string,
      { id: string; expiresOn: string | null }
    >();
    if (pageEmployees.length > 0) {
      const completionRows = await tx
        .select({
          employeeId: trainingCompletions.employeeId,
          score: trainingCompletions.score,
          passed: trainingCompletions.passed,
        })
        .from(trainingCompletions)
        .where(
          and(
            eq(trainingCompletions.tenantId, tenantId),
            eq(trainingCompletions.trainingId, trainingId),
            inArray(trainingCompletions.employeeId, pageEmployees),
          ),
        );
      for (const row of completionRows) {
        const current = attempts.get(row.employeeId) ?? {
          count: 0,
          best: null,
          passed: false,
        };
        current.count += 1;
        current.best = Math.max(current.best ?? 0, row.score);
        current.passed ||= row.passed;
        attempts.set(row.employeeId, current);
      }
      const certificateRows = await tx
        .select({
          id: trainingCertificates.id,
          employeeId: trainingCertificates.employeeId,
          expiresOn: trainingCertificates.expiresOn,
        })
        .from(trainingCertificates)
        .where(
          and(
            eq(trainingCertificates.tenantId, tenantId),
            eq(trainingCertificates.trainingId, trainingId),
            inArray(trainingCertificates.employeeId, pageEmployees),
          ),
        )
        .orderBy(
          desc(trainingCertificates.issuedAt),
          desc(trainingCertificates.id),
        );
      for (const row of certificateRows)
        if (!certificates.has(row.employeeId))
          certificates.set(row.employeeId, row);
    }

    return page(
      rows,
      query.limit,
      (row) => {
        const tally = attempts.get(row.enrollment.employeeId);
        const certificate = certificates.get(row.enrollment.employeeId);
        return trainingEnrollmentStatusSchema.parse({
          id: row.enrollment.id,
          employeeId: row.enrollment.employeeId,
          employeeName: row.employeeName,
          homeOutletId: row.homeOutletId,
          enrolledAt: row.enrollment.enrolledAt.toISOString(),
          dueOn: row.enrollment.dueOn,
          attempts: tally?.count ?? 0,
          bestScore: tally?.best ?? null,
          passed: tally?.passed ?? false,
          certificateId: certificate?.id ?? null,
          certificateExpiresOn: certificate?.expiresOn ?? null,
        });
      },
      (row) => [row.employeeName, row.enrollment.id],
    );
  });
}

// ------------------------------------------------------------ certificates

const toCertificate = (
  row: typeof trainingCertificates.$inferSelect,
): TrainingCertificate =>
  trainingCertificateSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    trainingId: row.trainingId,
    employeeId: row.employeeId,
    completionId: row.completionId,
    certificateNumber: row.certificateNumber,
    issuedAt: row.issuedAt.toISOString(),
    expiresOn: row.expiresOn,
  });

/**
 * Managers: certificates of employees whose home outlet is in reach. Employees
 * (`self.sop.read`): their own. Holding both gives the union; the optional
 * `employeeId` / `trainingId` filters narrow either.
 */
export async function listTrainingCertificates(
  context: ScopedTenantContext,
  actorUserId: string,
  query: CertificateQuery,
): Promise<Page<TrainingCertificate>> {
  return withTenant(db, context, async (tx) => {
    const { manage, self } = await loadViewer(tx, context, actorUserId);
    const scope: SQL[] = [];
    if (manage !== null)
      scope.push(
        manage.kind === "tenant"
          ? sql`true`
          : inArray(employees.homeOutletId, [...manage.outletIds]),
      );
    if (self !== null) scope.push(eq(employees.id, self.employeeId));
    if (scope.length === 0) throw forbidden();

    const filters: SQL[] = [
      eq(trainingCertificates.tenantId, context.tenant.tenantId),
      or(...scope)!,
    ];
    if (query.employeeId)
      filters.push(eq(trainingCertificates.employeeId, query.employeeId));
    if (query.trainingId)
      filters.push(eq(trainingCertificates.trainingId, query.trainingId));
    if (query.cursor) {
      const [number, id] = cursorPair(query.cursor);
      filters.push(
        or(
          lt(trainingCertificates.certificateNumber, number),
          and(
            eq(trainingCertificates.certificateNumber, number),
            lt(trainingCertificates.id, id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select({ certificate: trainingCertificates })
      .from(trainingCertificates)
      .innerJoin(
        employees,
        and(
          eq(employees.tenantId, trainingCertificates.tenantId),
          eq(employees.id, trainingCertificates.employeeId),
        ),
      )
      .where(and(...filters))
      .orderBy(
        desc(trainingCertificates.certificateNumber),
        desc(trainingCertificates.id),
      )
      .limit(query.limit + 1);
    return page(
      rows.map((row) => row.certificate),
      query.limit,
      toCertificate,
      (row) => [row.certificateNumber, row.id],
    );
  });
}
