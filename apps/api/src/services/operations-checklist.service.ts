// Checklist templates and runs for daily operations (PRD v1.7 §3 F41/F45,
// §6 L; WS-14; bead legend-btha). Routes: routes/operations.routes.ts.
//
// OPS-01 rules live in the contract (`@starter/shared/operations`) and this
// service only applies them:
// - a run snapshots its template at creation (`snapshotChecklistTemplate`), so
//   a later template edit never rewrites past runs;
// - `dueAt` is derived from the template schedule `dueTime` plus the shift date
//   in the OUTLET time zone, never from the client;
// - a done/failed answer carries the evidence its item requires
//   (`checklistItemResultIssues` -> 422 CHECKLIST_ITEM_INCOMPLETE);
// - `complete`/`fail` require every snapshot item to be finished
//   (`checklistCompletionStatus`), a failed run alerts the supervisor through
//   the transactional outbox, and a miss is escalated by
//   `markChecklistRunMissed` (alert delivery evidence) instead of a plain write.
//
// Every query runs inside `withTenant` (RLS scopes rows to the tenant and the
// caller's outlets) and every write re-checks `ops.checklist.complete` (template
// writes: `ops.checklist.manage`) on the concrete outlet inside that transaction (TEN-03). Creates and mutations bind
// their client idempotency key to the document they wrote (D-CORE-5).
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNull,
  lt,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import type { PermissionCode } from "@starter/shared/access";
import {
  assertOutletInScope,
  CoreError,
  decodeCursor,
  encodeCursor,
  userIdSchema,
  z,
  type CursorKey,
  type CursorPage,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
  type UserId,
} from "@starter/shared/core";
import {
  checklistCompletionStatus,
  checklistEvidenceKindSchema,
  checklistItemResultIssues,
  checklistRunListQuerySchema,
  checklistRunSchema,
  checklistTemplateListQuerySchema,
  checklistTemplateSchema,
  createChecklistRunInputSchema,
  createChecklistTemplateInputSchema,
  OperationsError,
  operationsEvents,
  opsChecklistItemIdSchema,
  recordChecklistItemResultInputSchema,
  snapshotChecklistTemplate,
  transitionChecklistRun as nextChecklistRunStatus,
  transitionChecklistRunInputSchema,
  updateChecklistTemplateInputSchema,
  type ChecklistItem,
  type ChecklistItemResult,
  type ChecklistRun,
  type ChecklistTemplate,
} from "@starter/shared/operations";
import { db } from "../db/index.ts";
import {
  opsChecklistRuns,
  opsChecklistTemplates,
} from "../db/schema/operations.ts";
import { roleAssignments, roles } from "../db/schema/platform-access.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assertFacilityEvidenceBindable,
  linkFacilityEvidence,
} from "./facility-evidence-media.ts";
import { zonedInstant } from "./facility-rules.ts";
import { minutesOfDay } from "./menu-availability.ts";
import { assertOutletPermission, type Tx } from "./menu-internals.ts";
import { markChecklistRunMissed } from "./operations-escalation.service.ts";
import {
  emitOperationsEvent,
  OPERATIONS_NOTIFICATION_DESTINATION,
} from "./operations-events.ts";
import {
  operationsFingerprint,
  readIdempotentResult,
  storeIdempotentResult,
} from "./operations-idempotency.ts";

/** Run and item writes use this permission (shared/RBAC catalog). */
export const CHECKLIST_PERMISSION: PermissionCode = "ops.checklist.complete";

/** Template writes (create, edit, retire) need the manage permission. */
export const CHECKLIST_MANAGE_PERMISSION: PermissionCode =
  "ops.checklist.manage";

/** `operations_idempotency.result_table` values this service owns. */
export const CHECKLIST_TEMPLATE_RESULT_TABLE = "checklist_template";
export const CHECKLIST_RUN_RESULT_TABLE = "checklist_run";

type ChecklistTemplateListQuery = z.output<
  typeof checklistTemplateListQuerySchema
>;
type ChecklistRunListQuery = z.output<typeof checklistRunListQuerySchema>;
type CreateChecklistTemplateInput = z.output<
  typeof createChecklistTemplateInputSchema
>;
type UpdateChecklistTemplateInput = z.output<
  typeof updateChecklistTemplateInputSchema
>;
type CreateChecklistRunInput = z.output<typeof createChecklistRunInputSchema>;
type RecordChecklistItemResultInput = z.output<
  typeof recordChecklistItemResultInputSchema
>;
type TransitionChecklistRunInput = z.output<
  typeof transitionChecklistRunInputSchema
>;

type TemplateRow = typeof opsChecklistTemplates.$inferSelect;
type RunRow = typeof opsChecklistRuns.$inferSelect;

const notFound = (what: string) =>
  new HttpError(404, "NOT_FOUND", `${what} tidak ditemukan.`);

const invalidCursor = () =>
  new HttpError(422, "VALIDATION_ERROR", "Periksa cursor halaman.");

// ------------------------------------------------------------- cursor keys

/** Decodes an opaque cursor into `expected` string sort keys (422 if not). */
function cursorKeys(cursor: string, expected: number): string[] {
  let decoded: CursorKey[];
  try {
    decoded = decodeCursor(cursor);
  } catch {
    throw invalidCursor();
  }
  const keys: string[] = [];
  for (const key of decoded) {
    // Every checklist cursor sorts on bounded text/timestamp keys only.
    if (typeof key !== "string") throw invalidCursor();
    keys.push(key);
  }
  if (keys.length !== expected) throw invalidCursor();
  return keys;
}

/** A cursor instant that does not parse is a client error, not a 500. */
function cursorInstant(value: string): Date {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw invalidCursor();
  return at;
}

/** Keyset filter for `updated_at DESC, id DESC`. */
function templateCursorWhere(cursor: string): SQL {
  const [updatedAt, id] = cursorKeys(cursor, 2);
  const at = cursorInstant(updatedAt);
  return or(
    lt(opsChecklistTemplates.updatedAt, at),
    and(
      eq(opsChecklistTemplates.updatedAt, at),
      lt(opsChecklistTemplates.id, id),
    ),
  ) as SQL;
}

/** Keyset filter for `shift_date DESC, due_at ASC, id DESC`. */
function runCursorWhere(cursor: string): SQL {
  const [shiftDate, dueAt, id] = cursorKeys(cursor, 3);
  const at = cursorInstant(dueAt);
  return or(
    lt(opsChecklistRuns.shiftDate, shiftDate),
    and(
      eq(opsChecklistRuns.shiftDate, shiftDate),
      gt(opsChecklistRuns.dueAt, at),
    ),
    and(
      eq(opsChecklistRuns.shiftDate, shiftDate),
      eq(opsChecklistRuns.dueAt, at),
      lt(opsChecklistRuns.id, id),
    ),
  ) as SQL;
}

// ------------------------------------------------------------------ mappers

function toChecklistTemplate(row: TemplateRow): ChecklistTemplate {
  return checklistTemplateSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    name: row.name,
    type: row.type,
    items: row.items,
    schedule: row.schedule,
    roleId: row.roleId,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  });
}

function toChecklistRun(row: RunRow): ChecklistRun {
  return checklistRunSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    templateId: row.templateId,
    templateVersion: row.templateVersion,
    items: row.items,
    shiftDate: row.shiftDate,
    shiftTemplateId: row.shiftTemplateId,
    assignedTo: row.assignedTo,
    dueAt: row.dueAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    status: row.status,
    missedAt: row.missedAt?.toISOString() ?? null,
    alertedAt: row.alertedAt?.toISOString() ?? null,
    results: row.results,
  });
}

/** An item without an id gets a server-minted one; a sent id is kept. */
function toChecklistItem(
  item: {
    label: string;
    instruction?: string | null;
    requiredEvidence?: string[];
  },
  id: string,
): ChecklistItem {
  return {
    id: opsChecklistItemIdSchema.parse(id),
    label: item.label,
    instruction: item.instruction ?? null,
    requiredEvidence: checklistEvidenceKindSchema
      .array()
      .parse(item.requiredEvidence ?? []),
  };
}

async function loadTemplateRow(
  tx: Tx,
  tenantId: TenantId,
  templateId: string,
  outletId?: OutletId,
  lock = false,
): Promise<TemplateRow> {
  const query = tx
    .select()
    .from(opsChecklistTemplates)
    .where(
      and(
        eq(opsChecklistTemplates.tenantId, tenantId),
        eq(opsChecklistTemplates.id, templateId),
        ...(outletId === undefined
          ? []
          : [eq(opsChecklistTemplates.outletId, outletId)]),
      ),
    )
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound("Template checklist");
  return row;
}

async function loadRunRow(
  tx: Tx,
  tenantId: TenantId,
  runId: string,
  lock: boolean,
): Promise<RunRow> {
  const query = tx
    .select()
    .from(opsChecklistRuns)
    .where(
      and(
        eq(opsChecklistRuns.tenantId, tenantId),
        eq(opsChecklistRuns.id, runId),
      ),
    )
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound("Checklist");
  return row;
}

/** OPS-01: `assignedTo` must hold a live grant on the tenant or that outlet. */
async function assertAssigneeInOutlet(
  tx: Tx,
  tenantId: string,
  outletId: string,
  assignedTo: UserId,
  now: Date,
): Promise<void> {
  const [assignment] = await tx
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.tenantId, tenantId),
        eq(roleAssignments.userId, assignedTo),
        lte(roleAssignments.validFrom, now),
        or(
          isNull(roleAssignments.validUntil),
          gt(roleAssignments.validUntil, now),
        ),
        or(
          eq(roleAssignments.scopeType, "tenant"),
          and(
            eq(roleAssignments.scopeType, "outlet"),
            eq(roleAssignments.scopeId, outletId),
          ),
        ),
      ),
    )
    .limit(1);
  if (!assignment)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Penanggung jawab di luar outlet",
    );
}

/** A template may only name a role of its own tenant (no FK on role_id). */
async function assertRoleInTenant(
  tx: Tx,
  tenantId: string,
  roleId: string | null | undefined,
): Promise<void> {
  if (roleId === null || roleId === undefined) return;
  const [role] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.tenantId, tenantId), eq(roles.id, roleId)))
    .limit(1);
  if (!role)
    throw new HttpError(422, "VALIDATION_ERROR", "Role tidak ditemukan.");
}

// --------------------------------------------------------------- templates

export async function listChecklistTemplates(
  context: ScopedTenantContext,
  query: ChecklistTemplateListQuery,
): Promise<CursorPage<ChecklistTemplate>> {
  // The query names an outlet: it may only narrow the server-minted scope.
  assertOutletInScope(context.outletScope, query.outletId);
  return withTenant(db, context, async (tx) => {
    const filters: SQL[] = [
      eq(opsChecklistTemplates.tenantId, context.tenant.tenantId),
      eq(opsChecklistTemplates.outletId, query.outletId),
    ];
    if (query.type) filters.push(eq(opsChecklistTemplates.type, query.type));
    if (query.cursor) filters.push(templateCursorWhere(query.cursor));
    const rows = await tx
      .select()
      .from(opsChecklistTemplates)
      .where(and(...filters))
      .orderBy(
        desc(opsChecklistTemplates.updatedAt),
        desc(opsChecklistTemplates.id),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toChecklistTemplate),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.updatedAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

export async function getChecklistTemplate(
  context: ScopedTenantContext,
  templateId: string,
): Promise<ChecklistTemplate> {
  return withTenant(db, context, async (tx) =>
    toChecklistTemplate(
      await loadTemplateRow(tx, context.tenant.tenantId, templateId),
    ),
  );
}

export async function createChecklistTemplate(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateChecklistTemplateInput,
  now = new Date(),
): Promise<ChecklistTemplate> {
  const actor = userIdSchema.parse(actorUserId);
  const fingerprint = operationsFingerprint({
    ...input,
    idempotencyKey: undefined,
  });
  return withTenant(db, context, async (tx) => {
    await assertOutletPermission(
      tx,
      context,
      actor,
      CHECKLIST_MANAGE_PERMISSION,
      input.outletId,
      now,
    );
    const replayed = await readIdempotentResult(
      tx,
      context,
      input.idempotencyKey,
      fingerprint,
      CHECKLIST_TEMPLATE_RESULT_TABLE,
    );
    if (replayed)
      return toChecklistTemplate(
        await loadTemplateRow(tx, context.tenant.tenantId, replayed),
      );
    await assertRoleInTenant(tx, context.tenant.tenantId, input.roleId);
    const [row] = await tx
      .insert(opsChecklistTemplates)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        name: input.name,
        type: input.type,
        items: input.items.map((item) => toChecklistItem(item, randomUUID())),
        schedule: input.schedule,
        roleId: input.roleId ?? null,
        // A new template starts at version 1; item edits bump it.
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await storeIdempotentResult(tx, context, {
      key: input.idempotencyKey,
      fingerprint,
      outletId: row.outletId,
      resultTable: CHECKLIST_TEMPLATE_RESULT_TABLE,
      resultId: row.id,
    });
    return toChecklistTemplate(row);
  });
}

export async function updateChecklistTemplate(
  context: ScopedTenantContext,
  actorUserId: string,
  templateId: string,
  input: UpdateChecklistTemplateInput,
  now = new Date(),
): Promise<ChecklistTemplate> {
  const actor = userIdSchema.parse(actorUserId);
  const fingerprint = operationsFingerprint({
    templateId,
    ...input,
    idempotencyKey: undefined,
  });
  return withTenant(db, context, async (tx) => {
    const locked = await loadTemplateRow(
      tx,
      context.tenant.tenantId,
      templateId,
      undefined,
      true,
    );
    await assertOutletPermission(
      tx,
      context,
      actor,
      CHECKLIST_MANAGE_PERMISSION,
      locked.outletId,
      now,
    );
    const replayed = await readIdempotentResult(
      tx,
      context,
      input.idempotencyKey,
      fingerprint,
      CHECKLIST_TEMPLATE_RESULT_TABLE,
    );
    if (replayed)
      return toChecklistTemplate(
        await loadTemplateRow(tx, context.tenant.tenantId, replayed),
      );
    // Optimistic concurrency (CORE PRECONDITION_FAILED): compare instants, so
    // the same moment sent in another UTC offset is still the same version.
    if (Date.parse(input.expectedUpdatedAt) !== locked.updatedAt.getTime())
      throw new CoreError(
        "PRECONDITION_FAILED",
        "Checklist sudah berubah. Muat ulang lalu coba lagi.",
      );
    // Keep the stamp strictly newer than the version just checked, so a stale
    // expectedUpdatedAt can never match two writes in the same millisecond.
    const stamp = new Date(
      Math.max(now.getTime(), locked.updatedAt.getTime() + 1),
    );
    await assertRoleInTenant(tx, context.tenant.tenantId, input.roleId);
    const items =
      input.items === undefined
        ? undefined
        : input.items.map((item) =>
            toChecklistItem(item, item.id ?? randomUUID()),
          );
    const [row] = await tx
      .update(opsChecklistTemplates)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.schedule !== undefined && { schedule: input.schedule }),
        ...(input.roleId !== undefined && { roleId: input.roleId }),
        // Changing the items bumps the version a run snapshots.
        ...(items !== undefined && {
          items,
          version: locked.version + 1,
        }),
        updatedAt: stamp,
      })
      .where(
        and(
          eq(opsChecklistTemplates.tenantId, context.tenant.tenantId),
          eq(opsChecklistTemplates.id, templateId),
        ),
      )
      .returning();
    await storeIdempotentResult(tx, context, {
      key: input.idempotencyKey,
      fingerprint,
      outletId: row.outletId,
      resultTable: CHECKLIST_TEMPLATE_RESULT_TABLE,
      resultId: row.id,
    });
    return toChecklistTemplate(row);
  });
}

// -------------------------------------------------------------------- runs

export async function listChecklistRuns(
  context: ScopedTenantContext,
  query: ChecklistRunListQuery,
): Promise<CursorPage<ChecklistRun>> {
  assertOutletInScope(context.outletScope, query.outletId);
  return withTenant(db, context, async (tx) => {
    const filters: SQL[] = [
      eq(opsChecklistRuns.tenantId, context.tenant.tenantId),
      eq(opsChecklistRuns.outletId, query.outletId),
    ];
    if (query.status) filters.push(eq(opsChecklistRuns.status, query.status));
    if (query.shiftDate)
      filters.push(eq(opsChecklistRuns.shiftDate, query.shiftDate));
    if (query.assignedTo)
      filters.push(eq(opsChecklistRuns.assignedTo, query.assignedTo));
    if (query.cursor) filters.push(runCursorWhere(query.cursor));
    const rows = await tx
      .select()
      .from(opsChecklistRuns)
      .where(and(...filters))
      .orderBy(
        desc(opsChecklistRuns.shiftDate),
        asc(opsChecklistRuns.dueAt),
        desc(opsChecklistRuns.id),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toChecklistRun),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.shiftDate, last.dueAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

export async function getChecklistRun(
  context: ScopedTenantContext,
  runId: string,
): Promise<ChecklistRun> {
  return withTenant(db, context, async (tx) =>
    toChecklistRun(await loadRunRow(tx, context.tenant.tenantId, runId, false)),
  );
}

export async function createChecklistRun(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateChecklistRunInput,
  now = new Date(),
): Promise<ChecklistRun> {
  const actor = userIdSchema.parse(actorUserId);
  const fingerprint = operationsFingerprint({
    ...input,
    idempotencyKey: undefined,
  });
  return withTenant(db, context, async (tx) => {
    await assertOutletPermission(
      tx,
      context,
      actor,
      CHECKLIST_PERMISSION,
      input.outletId,
      now,
    );
    const replayed = await readIdempotentResult(
      tx,
      context,
      input.idempotencyKey,
      fingerprint,
      CHECKLIST_RUN_RESULT_TABLE,
    );
    if (replayed)
      return toChecklistRun(
        await loadRunRow(tx, context.tenant.tenantId, replayed, false),
      );
    // The template must live in the same outlet as the run (TEN-03).
    const template = await loadTemplateRow(
      tx,
      context.tenant.tenantId,
      input.templateId,
      input.outletId,
    );
    // OPS-01: the run's shift must match the template schedule when both set.
    const scheduledShiftId = template.schedule.shiftTemplateId ?? null;
    if (
      input.shiftTemplateId &&
      scheduledShiftId &&
      input.shiftTemplateId !== scheduledShiftId
    )
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Shift tidak sesuai jadwal template",
      );
    await assertAssigneeInOutlet(
      tx,
      context.tenant.tenantId,
      input.outletId,
      input.assignedTo,
      now,
    );
    const [outlet] = await tx
      .select({ timezone: outlets.timezone })
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, context.tenant.tenantId),
          eq(outlets.id, input.outletId),
        ),
      )
      .limit(1);
    if (!outlet) throw notFound("Outlet");
    // OPS-01: the deadline is the template's due time on the shift date, read
    // on the outlet wall clock (server-derived; the client never sends it).
    const dueAt = zonedInstant(
      input.shiftDate,
      minutesOfDay(template.schedule.dueTime),
      outlet.timezone,
    );
    const snapshot = snapshotChecklistTemplate(toChecklistTemplate(template));
    const [row] = await tx
      .insert(opsChecklistRuns)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        templateId: snapshot.templateId,
        templateVersion: snapshot.templateVersion,
        items: snapshot.items,
        shiftDate: input.shiftDate,
        shiftTemplateId: input.shiftTemplateId ?? scheduledShiftId,
        assignedTo: input.assignedTo,
        dueAt,
        completedAt: null,
        status: "pending",
        results: [],
        missedAt: null,
        alertedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await storeIdempotentResult(tx, context, {
      key: input.idempotencyKey,
      fingerprint,
      outletId: row.outletId,
      resultTable: CHECKLIST_RUN_RESULT_TABLE,
      resultId: row.id,
    });
    return toChecklistRun(row);
  });
}

export async function recordChecklistItemResult(
  context: ScopedTenantContext,
  actorUserId: string,
  runId: string,
  itemId: string,
  input: RecordChecklistItemResultInput,
  now = new Date(),
): Promise<ChecklistRun> {
  const actor = userIdSchema.parse(actorUserId);
  const { expectedActorUserId, ...answerInput } = input;
  if (expectedActorUserId !== undefined && expectedActorUserId !== actor)
    throw new OperationsError("CHECKLIST_REPLAY_ACTOR_MISMATCH");
  const fingerprint = operationsFingerprint({
    runId,
    itemId,
    ...answerInput,
    idempotencyKey: undefined,
  });
  return withTenant(db, context, async (tx) => {
    const locked = await loadRunRow(tx, context.tenant.tenantId, runId, true);
    await assertOutletPermission(
      tx,
      context,
      actor,
      CHECKLIST_PERMISSION,
      locked.outletId,
      now,
    );
    const replayed = await readIdempotentResult(
      tx,
      context,
      input.idempotencyKey,
      fingerprint,
      CHECKLIST_RUN_RESULT_TABLE,
    );
    if (replayed)
      return toChecklistRun(
        await loadRunRow(tx, context.tenant.tenantId, replayed, false),
      );
    const run = toChecklistRun(locked);
    // Answers are only accepted while the run is being worked on.
    if (run.status !== "in_progress")
      throw new OperationsError(
        "CHECKLIST_TRANSITION_INVALID",
        "Checklist harus dimulai sebelum butir dapat diisi.",
      );
    const item = run.items.find((entry) => entry.id === itemId);
    if (!item)
      throw new OperationsError(
        "CHECKLIST_ITEM_NOT_IN_RUN",
        "Butir checklist ini tidak ada pada checklist tersebut.",
      );
    // A queued snapshot must not overwrite an answer confirmed after capture.
    // Same-key retries have already returned above; legacy online corrections
    // keep their existing behavior when no queue actor precondition is present.
    if (
      expectedActorUserId !== undefined &&
      run.results.some((entry) => entry.itemId === item.id)
    )
      throw new OperationsError("CHECKLIST_ANSWER_CONFLICT");
    const finished = input.status === "done" || input.status === "failed";
    const result: ChecklistItemResult = {
      itemId: item.id,
      status: input.status,
      numberValue: input.numberValue ?? null,
      note: input.note ?? null,
      photoMediaIds: input.photoMediaIds ?? [],
      signatureMediaId: input.signatureMediaId ?? null,
      // Server-set evidence metadata: the client never claims it.
      completedAt: finished ? now.toISOString() : null,
      completedBy: finished ? actor : null,
    };
    // OPS-01: a finished answer must carry the evidence its item requires.
    if (finished && checklistItemResultIssues(item, result).length > 0)
      throw new OperationsError(
        "CHECKLIST_ITEM_INCOMPLETE",
        "Butir checklist belum lengkap. Lengkapi foto, angka, atau tanda tangan yang diminta.",
      );
    // legend-mg2bz: evidence must be the actor's own checklist upload at this
    // outlet and not attached to another document.
    const evidenceIds = [
      ...result.photoMediaIds,
      ...(result.signatureMediaId === null ? [] : [result.signatureMediaId]),
    ];
    await assertFacilityEvidenceBindable(tx, {
      tenantId: context.tenant.tenantId,
      outletId: run.outletId,
      actorUserId: actor,
      sourceKind: "checklist_evidence",
      sourceId: run.id,
      mediaIds: evidenceIds,
      message:
        "Foto atau tanda tangan tidak ditemukan. Unggah ulang lalu coba lagi.",
    });
    const index = run.results.findIndex((entry) => entry.itemId === item.id);
    const results =
      index >= 0
        ? run.results.map((entry, position) =>
            position === index ? result : entry,
          )
        : [...run.results, result];
    const [row] = await tx
      .update(opsChecklistRuns)
      .set({ results, updatedAt: now })
      .where(
        and(
          eq(opsChecklistRuns.tenantId, context.tenant.tenantId),
          eq(opsChecklistRuns.id, run.id),
        ),
      )
      .returning();
    await linkFacilityEvidence(tx, {
      tenantId: context.tenant.tenantId,
      outletId: run.outletId,
      actorUserId: actor,
      sourceKind: "checklist_evidence",
      sourceId: run.id,
      mediaIds: evidenceIds,
    });
    await storeIdempotentResult(tx, context, {
      key: input.idempotencyKey,
      fingerprint,
      outletId: row.outletId,
      resultTable: CHECKLIST_RUN_RESULT_TABLE,
      resultId: row.id,
    });
    return toChecklistRun(row);
  });
}

export async function transitionChecklistRun(
  context: ScopedTenantContext,
  actorUserId: string,
  runId: string,
  input: TransitionChecklistRunInput,
  now = new Date(),
): Promise<ChecklistRun> {
  const actor = userIdSchema.parse(actorUserId);
  const fingerprint = operationsFingerprint({
    runId,
    ...input,
    idempotencyKey: undefined,
  });
  return withTenant(db, context, async (tx) => {
    const locked = await loadRunRow(tx, context.tenant.tenantId, runId, true);
    await assertOutletPermission(
      tx,
      context,
      actor,
      CHECKLIST_PERMISSION,
      locked.outletId,
      now,
    );
    const replayed = await readIdempotentResult(
      tx,
      context,
      input.idempotencyKey,
      fingerprint,
      CHECKLIST_RUN_RESULT_TABLE,
    );
    if (replayed)
      return toChecklistRun(
        await loadRunRow(tx, context.tenant.tenantId, replayed, false),
      );
    const run = toChecklistRun(locked);
    // The contract machine owns the allowed transitions (409 when forbidden).
    const next = nextChecklistRunStatus(run.status, input.action);
    if (input.action === "miss") {
      // OPS-01: the escalation service stamps the miss and records the
      // supervisor alert; a plain update here would skip the alert.
      await markChecklistRunMissed(
        tx,
        context,
        {
          id: run.id,
          templateId: run.templateId,
          shiftDate: run.shiftDate,
          assignedTo: run.assignedTo,
          outletId: run.outletId,
          dueAt: run.dueAt,
        },
        now,
      );
      // Bind the key like every other action, so a retried miss replays the
      // missed run instead of failing the machine with 409.
      await storeIdempotentResult(tx, context, {
        key: input.idempotencyKey,
        fingerprint,
        outletId: run.outletId,
        resultTable: CHECKLIST_RUN_RESULT_TABLE,
        resultId: run.id,
      });
      return toChecklistRun(
        await loadRunRow(tx, context.tenant.tenantId, run.id, false),
      );
    }
    const finished = next === "completed" || next === "failed";
    if (finished) {
      // complete/fail need a finished answer per snapshot item, and the
      // outcome must match the requested action.
      const outcome = checklistCompletionStatus(run.items, run.results);
      if (outcome !== next)
        throw new OperationsError(
          "CHECKLIST_TRANSITION_INVALID",
          "Checklist gagal tidak dapat diselesaikan sebagai selesai.",
        );
    }
    // The stored instant (a run is finished exactly when it is completed or
    // failed); the contract parse below serialises it for the wire.
    const completedAt = finished ? now : null;
    const [row] = await tx
      .update(opsChecklistRuns)
      .set({
        status: next,
        completedAt,
        // Only a miss carries these; any other move clears them.
        missedAt: null,
        alertedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(opsChecklistRuns.tenantId, context.tenant.tenantId),
          eq(opsChecklistRuns.id, run.id),
        ),
      )
      .returning();
    if (next === "failed") {
      // OPS-01: a failed run alerts the supervisor just like a miss.
      const failedItemIds = run.results
        .filter((result) => result.status === "failed")
        .map((result) => result.itemId);
      await emitOperationsEvent(
        tx,
        context,
        operationsEvents["checklist.failed"],
        {
          aggregateId: run.id,
          outletId: run.outletId,
          actor: { type: "user", id: actor },
          payload: {
            runId: run.id,
            templateId: run.templateId,
            shiftDate: run.shiftDate,
            assignedTo: run.assignedTo,
            dueAt: run.dueAt,
            // A failed run is finished, so this write is its completion time.
            completedAt: now.toISOString(),
            failedItemIds,
          },
          // Like a miss, the supervisor alert is built by the notification
          // consumer; the default cloud-sync stream would never alert anyone.
          destination: OPERATIONS_NOTIFICATION_DESTINATION,
          now,
        },
      );
    }
    await storeIdempotentResult(tx, context, {
      key: input.idempotencyKey,
      fingerprint,
      outletId: row.outletId,
      resultTable: CHECKLIST_RUN_RESULT_TABLE,
      resultId: row.id,
    });
    return toChecklistRun(row);
  });
}
