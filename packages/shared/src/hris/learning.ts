// HRIS learning contract: SOP library management, training quizzes and
// certificates, announcement receipts (PRD v1.7 §3 F32, bead legend-7df1).
// Extends the employee-facing endpoints in endpoints.ts (listSopDocuments,
// acknowledgeSopDocument, listTrainings, completeTraining, listAnnouncements,
// markAnnouncementRead) with the manager side: create/publish, enrolment,
// certificate registry and recipient tracking. Bodies are `clientInputSchema`
// (no client tenant id, TEN-02); every list is cursor paginated.

import {
  z,
  clientInputSchema,
  cursorPageMetaSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  isoDateTimeSchema,
  businessDateSchema,
  outletIdSchema,
  tenantIdSchema,
  uuidIdSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  employeeIdSchema,
  positionIdSchema,
  sopDocumentIdSchema,
  trainingIdSchema,
  trainingCompletionIdSchema,
  announcementIdSchema,
  stationIdSchema,
} from "./ids.ts";
import {
  announcementAudienceSchema,
  announcementSchema,
  sopDocumentSchema,
  trainingSchema,
} from "./performance.ts";

const title = z.string().min(1).max(200);
const employeeName = z.string().min(1).max(150);

export const trainingEnrollmentIdSchema =
  uuidIdSchema<"TrainingEnrollmentId">();
export type TrainingEnrollmentId = z.infer<typeof trainingEnrollmentIdSchema>;
export const trainingCertificateIdSchema =
  uuidIdSchema<"TrainingCertificateId">();
export type TrainingCertificateId = z.infer<typeof trainingCertificateIdSchema>;

// ---- SOP -----------------------------------------------------------------

const sopVersionContent = {
  title,
  body: z.string().min(1).max(50_000),
  mediaIds: z.array(z.uuid().toLowerCase()).max(20),
  requiresAcknowledgement: z.boolean(),
  effectiveFrom: businessDateSchema,
};

export const createSopDocumentInputSchema = clientInputSchema({
  ...sopVersionContent,
  stationId: stationIdSchema.nullable(),
  positionId: positionIdSchema.nullable(),
});
export type CreateSopDocumentInput = z.infer<
  typeof createSopDocumentInputSchema
>;

/** Station and position are inherited from the version it replaces. */
export const publishSopVersionInputSchema =
  clientInputSchema(sopVersionContent);
export type PublishSopVersionInput = z.infer<
  typeof publishSopVersionInputSchema
>;

/** Per-employee acknowledgement state against the latest SOP version. */
export const sopAcknowledgementStatusSchema = z.strictObject({
  employeeId: employeeIdSchema,
  employeeName,
  homeOutletId: outletIdSchema,
  /** Version the employee last acknowledged; null = never. */
  acknowledgedVersion: z.number().int().positive().safe().nullable(),
  acknowledgedAt: isoDateTimeSchema.nullable(),
  /** True when the acknowledged version is the version being asked about. */
  current: z.boolean(),
});
export type SopAcknowledgementStatus = z.infer<
  typeof sopAcknowledgementStatusSchema
>;

const sopDocumentParams = z.strictObject({
  sopDocumentId: sopDocumentIdSchema,
});

export const createSopDocument = defineEndpoint({
  method: "POST",
  path: "/api/hris/sop-documents",
  body: createSopDocumentInputSchema,
  response: dataResponseSchema(sopDocumentSchema),
});

/** Must target the latest version of its lineage, else 409 SOP_VERSION_STALE. */
export const publishSopVersion = defineEndpoint({
  method: "POST",
  path: "/api/hris/sop-documents/:sopDocumentId/versions",
  params: sopDocumentParams,
  body: publishSopVersionInputSchema,
  response: dataResponseSchema(sopDocumentSchema),
});

/** Every version of the lineage, oldest to newest. */
export const listSopDocumentVersions = defineEndpoint({
  method: "GET",
  path: "/api/hris/sop-documents/:sopDocumentId/versions",
  params: sopDocumentParams,
  response: dataResponseSchema(z.array(sopDocumentSchema)),
});

export const listSopAcknowledgementStatus = defineEndpoint({
  method: "GET",
  path: "/api/hris/sop-documents/:sopDocumentId/acknowledgement-status",
  params: sopDocumentParams,
  query: cursorPageQuerySchema,
  response: cursorPageSchema(sopAcknowledgementStatusSchema),
});

// ---- Training ------------------------------------------------------------

export const createTrainingQuestionInputSchema = z
  .strictObject({
    prompt: z.string().min(1).max(500),
    options: z.array(z.string().min(1).max(300)).min(2).max(6),
    points: z.number().int().min(1).max(100),
    correctOptionIndex: z.number().int().min(0).max(5),
  })
  .superRefine((question, ctx) => {
    if (question.correctOptionIndex >= question.options.length)
      ctx.addIssue({
        code: "custom",
        path: ["correctOptionIndex"],
        message: "The correct option must be one of the options",
      });
  });
export type CreateTrainingQuestionInput = z.infer<
  typeof createTrainingQuestionInputSchema
>;

export const createTrainingInputSchema = clientInputSchema({
  title,
  description: z.string().min(1).max(2_000),
  stationId: stationIdSchema.nullable(),
  positionId: positionIdSchema.nullable(),
  passingScore: z.number().int().min(0).max(100),
  /** 0 = certificate never expires. */
  validityMonths: z.number().int().min(0).max(120),
  scheduledStart: isoDateTimeSchema.nullable(),
  scheduledEnd: isoDateTimeSchema.nullable(),
  questions: z.array(createTrainingQuestionInputSchema).min(1).max(100),
}).superRefine((training, ctx) => {
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
export type CreateTrainingInput = z.infer<typeof createTrainingInputSchema>;

export const enrollTrainingInputSchema = clientInputSchema({
  employeeIds: z.array(employeeIdSchema).min(1).max(200),
  dueOn: businessDateSchema.nullable(),
});
export type EnrollTrainingInput = z.infer<typeof enrollTrainingInputSchema>;

export const trainingEnrollmentSchema = z.strictObject({
  id: trainingEnrollmentIdSchema,
  tenantId: tenantIdSchema,
  trainingId: trainingIdSchema,
  employeeId: employeeIdSchema,
  enrolledAt: isoDateTimeSchema,
  dueOn: businessDateSchema.nullable(),
});
export type TrainingEnrollment = z.infer<typeof trainingEnrollmentSchema>;

export const trainingEnrollmentStatusSchema = z.strictObject({
  id: trainingEnrollmentIdSchema,
  employeeId: employeeIdSchema,
  employeeName,
  homeOutletId: outletIdSchema,
  enrolledAt: isoDateTimeSchema,
  dueOn: businessDateSchema.nullable(),
  attempts: z.number().int().min(0).max(100),
  bestScore: z.number().int().min(0).max(100).nullable(),
  passed: z.boolean(),
  certificateId: trainingCertificateIdSchema.nullable(),
  certificateExpiresOn: businessDateSchema.nullable(),
});
export type TrainingEnrollmentStatus = z.infer<
  typeof trainingEnrollmentStatusSchema
>;

export const trainingCertificateSchema = z.strictObject({
  id: trainingCertificateIdSchema,
  tenantId: tenantIdSchema,
  trainingId: trainingIdSchema,
  employeeId: employeeIdSchema,
  completionId: trainingCompletionIdSchema,
  /** `CERT-<YYYYMMDD>-<6 base32>`, unique per tenant. */
  certificateNumber: z.string().min(1).max(40),
  issuedAt: isoDateTimeSchema,
  expiresOn: businessDateSchema.nullable(),
});
export type TrainingCertificate = z.infer<typeof trainingCertificateSchema>;

const trainingParams = z.strictObject({ trainingId: trainingIdSchema });

/** The response never carries the answer key (`trainingSchema` has none). */
export const createTraining = defineEndpoint({
  method: "POST",
  path: "/api/hris/trainings",
  body: createTrainingInputSchema,
  response: dataResponseSchema(trainingSchema),
});

/** Idempotent: employees already enrolled are returned unchanged. */
export const enrollTraining = defineEndpoint({
  method: "POST",
  path: "/api/hris/trainings/:trainingId/enrollments",
  params: trainingParams,
  body: enrollTrainingInputSchema,
  response: dataResponseSchema(z.array(trainingEnrollmentSchema)),
});

export const listTrainingEnrollments = defineEndpoint({
  method: "GET",
  path: "/api/hris/trainings/:trainingId/enrollments",
  params: trainingParams,
  query: cursorPageQuerySchema,
  response: cursorPageSchema(trainingEnrollmentStatusSchema),
});

export const listTrainingCertificates = defineEndpoint({
  method: "GET",
  path: "/api/hris/training-certificates",
  query: cursorPageQuerySchema.extend({
    employeeId: employeeIdSchema.optional(),
    trainingId: trainingIdSchema.optional(),
  }),
  response: cursorPageSchema(trainingCertificateSchema),
});

// ---- Announcements -------------------------------------------------------

export const createAnnouncementInputSchema = clientInputSchema({
  title,
  body: z.string().min(1).max(20_000),
  audience: announcementAudienceSchema,
  requiresReceipt: z.boolean(),
  expiresAt: isoDateTimeSchema.nullable(),
});
export type CreateAnnouncementInput = z.infer<
  typeof createAnnouncementInputSchema
>;

export const announcementReceiptStatusSchema = z.enum([
  "unread",
  "read",
  "acknowledged",
]);
export type AnnouncementReceiptStatus = z.infer<
  typeof announcementReceiptStatusSchema
>;

/** One recipient of an announcement and what they did with it. */
export const announcementRecipientSchema = z.strictObject({
  employeeId: employeeIdSchema,
  employeeName,
  homeOutletId: outletIdSchema,
  readAt: isoDateTimeSchema.nullable(),
  acknowledgedAt: isoDateTimeSchema.nullable(),
});
export type AnnouncementRecipient = z.infer<typeof announcementRecipientSchema>;

/** Totals over every recipient in the manager's reach, ignoring `status`. */
export const announcementReceiptSummarySchema = z.strictObject({
  recipients: z.number().int().nonnegative(),
  read: z.number().int().nonnegative(),
  acknowledged: z.number().int().nonnegative(),
});
export type AnnouncementReceiptSummary = z.infer<
  typeof announcementReceiptSummarySchema
>;

/** cursorPageSchema with `meta.summary` (cursorPageMetaSchema is not strict). */
export const announcementRecipientPageSchema = z.object({
  data: z.array(announcementRecipientSchema),
  meta: cursorPageMetaSchema.extend({
    summary: announcementReceiptSummarySchema,
  }),
});

export const createAnnouncement = defineEndpoint({
  method: "POST",
  path: "/api/hris/announcements",
  body: createAnnouncementInputSchema,
  response: dataResponseSchema(announcementSchema),
});

export const listAnnouncementReceipts = defineEndpoint({
  method: "GET",
  path: "/api/hris/announcements/:announcementId/receipts",
  params: z.strictObject({ announcementId: announcementIdSchema }),
  query: cursorPageQuerySchema.extend({
    status: announcementReceiptStatusSchema.optional(),
  }),
  response: announcementRecipientPageSchema,
});

/** Manager-side learning endpoints, for route registration and client generation. */
export const hrisLearningEndpoints = [
  createSopDocument,
  publishSopVersion,
  listSopDocumentVersions,
  listSopAcknowledgementStatus,
  createTraining,
  enrollTraining,
  listTrainingEnrollments,
  listTrainingCertificates,
  createAnnouncement,
  listAnnouncementReceipts,
] as const;
