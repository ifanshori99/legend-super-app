// KPI, SOP library, training and internal announcements (PRD v1.7 §3 Kelompok D
// 32 "Kinerja, Pelatihan & SOP", §6 H `kpi_definitions`, `kpi_reviews`,
// `sop_documents`, `trainings`, `training_completions`; F29).
//
// - KPI definitions name a system source or a manager review and a target with
//   its direction, so a review row holds actual values plus the reviewer score.
// - SOP documents are versioned; a new version supersedes the previous one and
//   employees acknowledge the exact version they read. Acknowledgement of an
//   older version does not satisfy a newer one (F29 "wajib dibaca dengan tanda
//   konfirmasi").
// - Training questions ship to the client WITHOUT the answer key; grading runs
//   server-side against `TrainingAnswerKey` (never returned by an endpoint).
// - Announcement audiences are all employees, outlets, org units or positions;
//   receipts record who read and acknowledged.

import {
  z,
  clientInputSchema,
  tenantIdSchema,
  outletIdSchema,
  userIdSchema,
  isoDateTimeSchema,
  businessDateSchema,
  decimal4Schema,
  parseDecimal4,
  divideRounded,
  CoreError,
} from "../core/index.ts";
import {
  employeeIdSchema,
  positionIdSchema,
  kpiDefinitionIdSchema,
  kpiReviewIdSchema,
  sopDocumentIdSchema,
  sopAcknowledgementIdSchema,
  trainingIdSchema,
  trainingQuestionIdSchema,
  trainingCompletionIdSchema,
  announcementIdSchema,
  announcementReceiptIdSchema,
  stationIdSchema,
} from "./ids.ts";

const nonnegativeDecimal = decimal4Schema.refine(
  (value) => parseDecimal4(value) >= 0n,
  "Must not be negative",
);
const title = z.string().min(1).max(200);

// ---- KPI -----------------------------------------------------------------

/** PRD F29: a KPI is filled from system data or a manager's review. */
export const kpiSourceSchema = z.enum(["system", "manager"]);
export type KpiSource = z.infer<typeof kpiSourceSchema>;

export const kpiDirectionSchema = z.enum([
  "higher_is_better",
  "lower_is_better",
]);
export type KpiDirection = z.infer<typeof kpiDirectionSchema>;

export const kpiReviewCycleSchema = z.enum(["monthly", "quarterly"]);
export type KpiReviewCycle = z.infer<typeof kpiReviewCycleSchema>;

const metricCode = z.string().min(1).max(60);

/** PRD §6 H `kpi_definitions`: position, name, source, target. */
export const kpiDefinitionSchema = z
  .strictObject({
    id: kpiDefinitionIdSchema,
    tenantId: tenantIdSchema,
    positionId: positionIdSchema.nullable(),
    name: z.string().min(1).max(150),
    source: kpiSourceSchema,
    /** Metric catalog code that fills a system KPI; null for a manager KPI. */
    metricCode: metricCode.nullable(),
    /** Null when the KPI is purely qualitative (manager's judgement). */
    target: nonnegativeDecimal.nullable(),
    unit: z.string().min(1).max(20),
    direction: kpiDirectionSchema,
    isActive: z.boolean(),
  })
  .superRefine(refineKpiMetricCode);
export type KpiDefinition = z.infer<typeof kpiDefinitionSchema>;

/** A metric code is set exactly when the KPI is filled from system data. */
function refineKpiMetricCode(
  definition: { source: KpiSource; metricCode?: string | null | undefined },
  ctx: z.RefinementCtx,
): void {
  const hasCode =
    definition.metricCode !== null && definition.metricCode !== undefined;
  if ((definition.source === "system") !== hasCode)
    ctx.addIssue({
      code: "custom",
      path: ["metricCode"],
      message: "A metric code is required for, and only for, a system KPI",
    });
}

const signedDecimal = decimal4Schema;

/** One KPI line of a review: system value, manual actual and reviewer score. */
export const kpiScoreSchema = z.strictObject({
  kpiDefinitionId: kpiDefinitionIdSchema,
  /** Value the score is judged on; signed (a cash variance can be negative). */
  actual: signedDecimal.nullable(),
  /** Reviewer score, 0–100. */
  score: z.number().int().min(0).max(100).nullable(),
  /** Last value the metric engine computed for the period. */
  systemActual: signedDecimal.nullable(),
  /** Why the engine has no value (e.g. no data), when systemActual is null. */
  systemAvailability: z.string().min(1).max(30).nullable(),
  actualSource: z.enum(["system", "manual"]).nullable(),
  comment: z.string().min(1).max(1000).nullable(),
});
export type KpiScore = z.infer<typeof kpiScoreSchema>;

export const kpiReviewStatusSchema = z.enum(["draft", "submitted"]);
export type KpiReviewStatus = z.infer<typeof kpiReviewStatusSchema>;

/** PRD §6 H `kpi_reviews`: employee, period, scores, reviewer. */
export const kpiReviewSchema = z
  .strictObject({
    id: kpiReviewIdSchema,
    tenantId: tenantIdSchema,
    employeeId: employeeIdSchema,
    periodStart: businessDateSchema,
    periodEnd: businessDateSchema,
    cycle: kpiReviewCycleSchema,
    scores: z.array(kpiScoreSchema).min(1),
    reviewerId: userIdSchema.nullable(),
    status: kpiReviewStatusSchema,
    submittedAt: isoDateTimeSchema.nullable(),
    note: z.string().min(1).max(2000).nullable(),
    /** Rounded mean of the scores; set when the review is submitted. */
    overallScore: z.number().min(0).max(100).nullable(),
  })
  .superRefine((review, ctx) => {
    if (review.periodEnd < review.periodStart)
      ctx.addIssue({
        code: "custom",
        path: ["periodEnd"],
        message: "Review period ends before it starts",
      });
    const ids = new Set<string>();
    for (const score of review.scores) {
      if (ids.has(score.kpiDefinitionId))
        ctx.addIssue({
          code: "custom",
          path: ["scores"],
          message: "A KPI appears twice in one review",
        });
      ids.add(score.kpiDefinitionId);
    }
    if (review.status === "submitted" && review.submittedAt === null)
      ctx.addIssue({
        code: "custom",
        path: ["submittedAt"],
        message: "A submitted review needs a submission time",
      });
    if (review.status === "draft" && review.submittedAt !== null)
      ctx.addIssue({
        code: "custom",
        path: ["submittedAt"],
        message: "A draft review has no submission time",
      });
    if (review.status === "submitted") {
      if (review.reviewerId === null)
        ctx.addIssue({
          code: "custom",
          path: ["reviewerId"],
          message: "A submitted review needs a reviewer",
        });
      if (review.scores.some((score) => score.score === null))
        ctx.addIssue({
          code: "custom",
          path: ["scores"],
          message: "A submitted review needs a score on every KPI",
        });
    }
  });
export type KpiReview = z.infer<typeof kpiReviewSchema>;

export const createKpiDefinitionInputSchema = clientInputSchema({
  positionId: positionIdSchema.nullable().default(null),
  name: z.string().trim().min(1).max(150),
  source: kpiSourceSchema,
  metricCode: metricCode.nullable().default(null),
  target: nonnegativeDecimal.nullable().default(null),
  unit: z.string().trim().min(1).max(20),
  direction: kpiDirectionSchema,
}).superRefine(refineKpiMetricCode);
export type CreateKpiDefinitionInput = z.infer<
  typeof createKpiDefinitionInputSchema
>;

/** Source and position are fixed at creation; the metric code may change. */
export const updateKpiDefinitionInputSchema = clientInputSchema({
  name: z.string().trim().min(1).max(150).optional(),
  metricCode: metricCode.optional(),
  target: nonnegativeDecimal.nullable().optional(),
  unit: z.string().trim().min(1).max(20).optional(),
  direction: kpiDirectionSchema.optional(),
  isActive: z.boolean().optional(),
}).refine(
  (input) => Object.values(input).some((value) => value !== undefined),
  "Nothing to update",
);
export type UpdateKpiDefinitionInput = z.infer<
  typeof updateKpiDefinitionInputSchema
>;

/** Opens a draft review; the period must be a full calendar month or quarter. */
export const createKpiReviewInputSchema = clientInputSchema({
  employeeId: employeeIdSchema,
  cycle: kpiReviewCycleSchema,
  periodStart: businessDateSchema,
});
export type CreateKpiReviewInput = z.infer<typeof createKpiReviewInputSchema>;

export const updateKpiScoresInputSchema = clientInputSchema({
  scores: z
    .array(
      z
        .strictObject({
          kpiDefinitionId: kpiDefinitionIdSchema,
          actual: signedDecimal.optional(),
          score: z.number().int().min(0).max(100).optional(),
          comment: z.string().trim().max(1000).optional(),
        })
        .refine(
          (line) =>
            line.actual !== undefined ||
            line.score !== undefined ||
            line.comment !== undefined,
          "A score line needs an actual, a score or a comment",
        ),
    )
    .min(1)
    .max(100),
  note: z.string().trim().max(2000).optional(),
}).superRefine((input, ctx) => {
  const ids = new Set<string>();
  for (const line of input.scores) {
    if (ids.has(line.kpiDefinitionId))
      ctx.addIssue({
        code: "custom",
        path: ["scores"],
        message: "A KPI appears twice in one update",
      });
    ids.add(line.kpiDefinitionId);
  }
});
export type UpdateKpiScoresInput = z.infer<typeof updateKpiScoresInputSchema>;

/** Draft → submitted; a submitted review is what the employee sees. */
export function transitionKpiReview(
  status: KpiReviewStatus,
  action: "submit",
): KpiReviewStatus {
  if (status === "draft" && action === "submit") return "submitted";
  throw new CoreError(
    "CONFLICT",
    `Transisi review KPI tidak valid: ${status} → ${action}.`,
  );
}

// ---- SOP -----------------------------------------------------------------

/** PRD F29 "Pustaka SOP": station/position scoped, versioned, read-confirmed. */
export const sopDocumentSchema = z
  .strictObject({
    id: sopDocumentIdSchema,
    tenantId: tenantIdSchema,
    stationId: stationIdSchema.nullable(),
    positionId: positionIdSchema.nullable(),
    title,
    version: z.number().int().positive().safe(),
    /** Markdown body; images/videos are referenced by media ids. */
    body: z.string().min(1).max(50_000),
    mediaIds: z.array(z.uuid()).max(20),
    requiresAcknowledgement: z.boolean(),
    effectiveFrom: businessDateSchema,
    publishedAt: isoDateTimeSchema,
    /** The version this one replaces; null for the first version. */
    supersedesId: sopDocumentIdSchema.nullable(),
  })
  .superRefine((sopDocument, ctx) => {
    if (sopDocument.version === 1 && sopDocument.supersedesId !== null)
      ctx.addIssue({
        code: "custom",
        path: ["supersedesId"],
        message: "The first version has nothing to supersede",
      });
    if (sopDocument.version > 1 && sopDocument.supersedesId === null)
      ctx.addIssue({
        code: "custom",
        path: ["supersedesId"],
        message: "A later version must name the version it replaces",
      });
  });
export type SopDocument = z.infer<typeof sopDocumentSchema>;

/** True when `next` is the direct successor of `previous` (version + date). */
export function isSopVersionSuccessor(
  previous: Pick<SopDocument, "id" | "version" | "effectiveFrom">,
  next: Pick<SopDocument, "version" | "effectiveFrom" | "supersedesId">,
): boolean {
  return (
    next.version === previous.version + 1 &&
    next.supersedesId === previous.id &&
    next.effectiveFrom >= previous.effectiveFrom
  );
}

/** Acknowledgement of an exact SOP version (F29 read confirmation). */
export const sopAcknowledgementSchema = z.strictObject({
  id: sopAcknowledgementIdSchema,
  tenantId: tenantIdSchema,
  sopDocumentId: sopDocumentIdSchema,
  employeeId: employeeIdSchema,
  /** Version that was on screen when the employee confirmed. */
  documentVersion: z.number().int().positive().safe(),
  acknowledgedAt: isoDateTimeSchema,
});
export type SopAcknowledgement = z.infer<typeof sopAcknowledgementSchema>;

/** True when the employee confirmed the current version of the SOP. */
export function isSopAcknowledged(
  sopDocument: Pick<SopDocument, "id" | "version" | "requiresAcknowledgement">,
  acknowledgements: readonly SopAcknowledgement[],
  employeeId: string,
): boolean {
  if (!sopDocument.requiresAcknowledgement) return true;
  return acknowledgements.some(
    (acknowledgement) =>
      acknowledgement.sopDocumentId === sopDocument.id &&
      acknowledgement.employeeId.toLowerCase() === employeeId.toLowerCase() &&
      acknowledgement.documentVersion === sopDocument.version,
  );
}

// ---- Training ------------------------------------------------------------

export const trainingQuestionSchema = z
  .strictObject({
    id: trainingQuestionIdSchema,
    prompt: z.string().min(1).max(500),
    options: z.array(z.string().min(1).max(300)).min(2).max(6),
    /** Weight of the question; the score is the weighted share. */
    points: z.number().int().min(1).max(100),
  })
  .strict();
export type TrainingQuestion = z.infer<typeof trainingQuestionSchema>;

/**
 * PRD §6 H `trainings` (title, quiz) + F29 certification. The answer key is a
 * separate server-only schema; `trainingSchema` is safe to serve to the
 * employee PWA.
 */
export const trainingSchema = z
  .strictObject({
    id: trainingIdSchema,
    tenantId: tenantIdSchema,
    title,
    description: z.string().min(1).max(2_000),
    stationId: stationIdSchema.nullable(),
    positionId: positionIdSchema.nullable(),
    questions: z.array(trainingQuestionSchema).min(1),
    /** Minimum weighted score (0–100) to pass. */
    passingScore: z.number().int().min(0).max(100),
    /** Certification validity after completion; 0 = no expiry. */
    validityMonths: z.number().int().min(0).max(120),
    scheduledStart: isoDateTimeSchema.nullable(),
    scheduledEnd: isoDateTimeSchema.nullable(),
  })
  .superRefine((training, ctx) => {
    const ids = new Set<string>();
    for (const question of training.questions) {
      if (ids.has(question.id))
        ctx.addIssue({
          code: "custom",
          path: ["questions"],
          message: "Duplicate question id",
        });
      ids.add(question.id);
    }
    if (
      training.scheduledStart !== null &&
      training.scheduledEnd !== null &&
      Date.parse(training.scheduledEnd) <= Date.parse(training.scheduledStart)
    )
      ctx.addIssue({
        code: "custom",
        path: ["scheduledEnd"],
        message: "Training schedule ends before it starts",
      });
  });
export type Training = z.infer<typeof trainingSchema>;

/** SERVER ONLY: answer key, never included in a training response. */
export const trainingAnswerKeySchema = z
  .strictObject({
    trainingId: trainingIdSchema,
    answers: z
      .array(
        z.strictObject({
          questionId: trainingQuestionIdSchema,
          correctOptionIndex: z.number().int().nonnegative().safe(),
        }),
      )
      .min(1),
  })
  .superRefine((key, ctx) => {
    const ids = new Set<string>();
    for (const answer of key.answers) {
      if (ids.has(answer.questionId))
        ctx.addIssue({
          code: "custom",
          path: ["answers"],
          message: "Duplicate answer for a question",
        });
      ids.add(answer.questionId);
    }
  });
export type TrainingAnswerKey = z.infer<typeof trainingAnswerKeySchema>;

export type TrainingAnswer = {
  readonly questionId: string;
  readonly optionIndex: number;
};

export type TrainingGrade = {
  readonly score: number;
  readonly passed: boolean;
  readonly correctPoints: number;
  readonly totalPoints: number;
};

/**
 * Weighted quiz grading. Answers are partial: an unanswered question counts as
 * wrong, so a client cannot skip into a pass. Score is rounded half up to the
 * nearest whole point (PRD F29 quiz).
 */
export function gradeTrainingAttempt(
  training: Pick<Training, "questions" | "passingScore">,
  answerKey: TrainingAnswerKey,
  answers: readonly TrainingAnswer[],
): TrainingGrade {
  const key = new Map(
    answerKey.answers.map((answer) => [
      answer.questionId,
      answer.correctOptionIndex,
    ]),
  );
  const given = new Map(
    answers.map((answer) => [answer.questionId, answer.optionIndex]),
  );
  let correctPoints = 0;
  let totalPoints = 0;
  for (const question of training.questions) {
    totalPoints += question.points;
    const correctIndex = key.get(question.id);
    const givenIndex = given.get(question.id);
    if (
      correctIndex !== undefined &&
      givenIndex !== undefined &&
      givenIndex === correctIndex &&
      givenIndex < question.options.length
    )
      correctPoints += question.points;
  }
  const score =
    totalPoints === 0
      ? 0
      : Number(
          divideRounded(
            BigInt(correctPoints) * 100n,
            BigInt(totalPoints),
            "half_up",
          ),
        );
  return {
    score,
    passed: score >= training.passingScore,
    correctPoints,
    totalPoints,
  };
}

/** PRD §6 H `training_completions` row. */
export const trainingCompletionSchema = z
  .strictObject({
    id: trainingCompletionIdSchema,
    tenantId: tenantIdSchema,
    employeeId: employeeIdSchema,
    trainingId: trainingIdSchema,
    score: z.number().int().min(0).max(100),
    passed: z.boolean(),
    completedAt: isoDateTimeSchema,
    /** Certification expiry derived from `validityMonths`; null = no expiry. */
    expiresOn: businessDateSchema.nullable(),
    attempts: z.number().int().min(1).max(100),
  })
  .superRefine((completion, ctx) => {
    if (completion.passed && completion.score === 0)
      ctx.addIssue({
        code: "custom",
        path: ["score"],
        message: "A passing completion cannot score zero",
      });
  });
export type TrainingCompletion = z.infer<typeof trainingCompletionSchema>;

/** True while the internal certification from a completion is still valid. */
export function isCertificationValid(
  completion: Pick<TrainingCompletion, "passed" | "expiresOn">,
  onDate: string,
): boolean {
  if (!completion.passed) return false;
  return completion.expiresOn === null || completion.expiresOn >= onDate;
}

// ---- Announcements -------------------------------------------------------

/**
 * PRD F29 "Pengumuman Internal": every employee or specific outlets ("ke
 * seluruh karyawan atau outlet tertentu"). No other targeting exists.
 */
export const announcementAudienceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({
    kind: z.literal("outlets"),
    outletIds: z.array(outletIdSchema).min(1),
  }),
]);
export type AnnouncementAudience = z.infer<typeof announcementAudienceSchema>;

export const announcementSchema = z.strictObject({
  id: announcementIdSchema,
  tenantId: tenantIdSchema,
  title,
  body: z.string().min(1).max(20_000),
  audience: announcementAudienceSchema,
  /** Read receipt required (PRD F29 "dengan tanda terima"). */
  requiresReceipt: z.boolean(),
  publishedBy: userIdSchema,
  publishedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema.nullable(),
});
export type Announcement = z.infer<typeof announcementSchema>;

export type AnnouncementTarget = {
  readonly employeeId: string;
  readonly outletId: string;
};

/** True when the announcement's audience covers this employee. */
export function isAnnouncementVisibleTo(
  announcement: Pick<Announcement, "audience">,
  target: AnnouncementTarget,
): boolean {
  const audience = announcement.audience;
  switch (audience.kind) {
    case "all":
      return true;
    case "outlets":
      return audience.outletIds.some(
        (id) => id.toLowerCase() === target.outletId.toLowerCase(),
      );
  }
}

export const announcementReceiptSchema = z
  .strictObject({
    id: announcementReceiptIdSchema,
    tenantId: tenantIdSchema,
    announcementId: announcementIdSchema,
    employeeId: employeeIdSchema,
    readAt: isoDateTimeSchema,
    /** Required when the announcement has `requiresReceipt`. */
    acknowledgedAt: isoDateTimeSchema.nullable(),
  })
  .strict();
export type AnnouncementReceipt = z.infer<typeof announcementReceiptSchema>;

/** True when the announcement needs no receipt, or this receipt satisfies it. */
export function isAnnouncementReceiptComplete(
  announcement: Pick<Announcement, "requiresReceipt">,
  receipt: AnnouncementReceipt | null,
): boolean {
  if (!announcement.requiresReceipt) return true;
  return receipt !== null && receipt.acknowledgedAt !== null;
}
