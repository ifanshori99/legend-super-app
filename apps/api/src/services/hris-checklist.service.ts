// Onboarding/offboarding checklists: templates per position, task instances
// per employee and the task actions (PRD v1.7 F24; DECISIONS 2026-11-10 "WS-10
// lifecycle"; brief 299 slice A; bead legend-ovxw). Routes:
// routes/hris-checklist.routes.ts.
//
// - A template is tenant-wide master data (`hris_checklist_templates`, one
//   active per tenant + kind + position, null position = default). Writes need
//   `hr.employee.manage` with tenant-wide reach. Changing the items bumps
//   `version`; tasks already created keep their own copy of the text.
// - Starting onboarding copies the active template (the employee's position,
//   else the default) into `hris_checklist_tasks`. A repeat call returns the
//   existing tasks and writes nothing.
// - A task changes only through `applyChecklistTaskAction`: one row lock, the
//   shared status machine (`transitionChecklistTask`), one append-only action
//   row and one audit row. `done` and `waived` are terminal. A system managed
//   task (offboarding access revocation) is never completed by hand.
// - Outlet reach is the employee's home outlet (`access.viewerFor`); a row the
//   caller cannot see answers 404, a visible row without the right answers 403.

import { and, asc, eq, gt, or, sql, type SQL } from "drizzle-orm";
import {
  CoreError,
  createUlid,
  decodeCursor,
  encodeCursor,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  checklistTaskActionSchema,
  checklistTaskSchema,
  checklistTemplateItemSchema,
  checklistTemplateSchema,
  transitionChecklistTask,
  type ChecklistKind,
  type ChecklistTask,
  type ChecklistTaskAction,
  type ChecklistTaskActionInput,
  type CreateChecklistTemplateInput,
  type UpdateChecklistTemplateInput,
  type ChecklistTemplate,
} from "@starter/shared/hris";
import { db } from "../db/index.ts";
import { employeeDocuments, employees, positions } from "../db/schema/hris.ts";
import {
  hrisChecklistTaskActions,
  hrisChecklistTasks,
  hrisChecklistTemplates,
} from "../db/schema/hris-lifecycle.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import {
  HRIS_AUDIT_SAFE_FIELDS,
  HRIS_MANAGE_CODE,
  assertCursorKeysNulFree,
  cursorPair,
  forbidden,
  hrisAuditEntry,
  loadHrisAccess,
  notFound,
  uniqueViolation,
  type HrisAccess,
  type Tx,
} from "./hris-access.ts";

type EmployeeRow = typeof employees.$inferSelect;
type TemplateRow = typeof hrisChecklistTemplates.$inferSelect;
type TaskRow = typeof hrisChecklistTasks.$inferSelect;
type ActionRow = typeof hrisChecklistTaskActions.$inferSelect;
type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};
type PageQuery = { limit: number; cursor?: string | undefined };

/** Task categories an employee may complete on their own onboarding. */
const SELF_COMPLETE_CATEGORIES: readonly string[] = ["documents", "training"];

// ---------------------------------------------------------------- mapping

function toTemplate(row: TemplateRow): ChecklistTemplate {
  return checklistTemplateSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind,
    positionId: row.positionId,
    title: row.title,
    items: row.items,
    version: row.version,
    isActive: row.isActive,
  });
}

function toTask(row: TaskRow): ChecklistTask {
  return checklistTaskSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    employeeId: row.employeeId,
    offboardingId: row.offboardingId,
    templateId: row.templateId,
    kind: row.kind,
    code: row.code,
    title: row.title,
    category: row.category,
    requiresDocument: row.requiresDocument,
    documentId: row.documentId,
    sortOrder: row.sortOrder,
    status: row.status,
    systemManaged: row.systemManaged,
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    doneBy: row.doneBy,
    doneAt: row.doneAt ? row.doneAt.toISOString() : null,
    blockReason: row.blockReason,
    waiveReason: row.waiveReason,
  });
}

function toAction(row: ActionRow): ChecklistTaskAction {
  return checklistTaskActionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    taskId: row.taskId,
    action: row.action,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    reason: row.reason,
    documentId: row.documentId,
    actorUserId: row.actorUserId,
    createdAt: row.createdAt.toISOString(),
  });
}

// ---------------------------------------------------------------- helpers

async function findEmployee(
  tx: Tx,
  context: ScopedTenantContext,
  employeeId: string,
  lock = false,
): Promise<EmployeeRow | undefined> {
  const query = tx
    .select()
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, context.tenant.tenantId),
        eq(employees.id, employeeId),
      ),
    )
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row;
}

async function findTask(
  tx: Tx,
  context: ScopedTenantContext,
  taskId: string,
  lock = false,
): Promise<TaskRow | undefined> {
  const query = tx
    .select()
    .from(hrisChecklistTasks)
    .where(
      and(
        eq(hrisChecklistTasks.tenantId, context.tenant.tenantId),
        eq(hrisChecklistTasks.id, taskId),
      ),
    )
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row;
}

/** Template writes are tenant master data: tenant-wide manage reach only. */
function assertTenantWideManage(access: HrisAccess): void {
  const reach = access.reach([HRIS_MANAGE_CODE]);
  if (reach === null || reach.kind !== "tenant") throw forbidden();
}

function holdsManage(access: HrisAccess, employee: EmployeeRow): boolean {
  return access.permissionsAt(employee.homeOutletId).includes(HRIS_MANAGE_CODE);
}

async function auditTemplate(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string,
  now: Date,
  action: string,
  template: TemplateRow,
  fields: readonly string[],
) {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: null,
      actorType: "user",
      actorId: actor,
      deviceId: null,
      action,
      objectType: "checklist_template",
      objectId: template.id,
      reason: null,
      maskedChanges: {
        before: null,
        after: { fields: [...fields], status: template.kind },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    HRIS_AUDIT_SAFE_FIELDS,
  );
}

function templateConflict(error: unknown): never {
  const violation = uniqueViolation(error);
  if (violation)
    throw new HttpError(
      409,
      "CHECKLIST_TEMPLATE_EXISTS",
      "Sudah ada template aktif untuk jenis dan jabatan ini.",
    );
  throw error;
}

/** Three-key cursor `[kind, sortOrder, id]`; 422 on anything else. */
function taskCursor(cursor: string): [string, number, string] {
  let keys;
  try {
    keys = decodeCursor(cursor);
  } catch {
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  }
  const [kind, sortOrder, id] = keys;
  if (
    typeof kind !== "string" ||
    typeof sortOrder !== "string" ||
    !/^\d{1,9}$/.test(sortOrder) ||
    typeof id !== "string"
  )
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  assertCursorKeysNulFree([kind, id]);
  return [kind, Number(sortOrder), id];
}

// -------------------------------------------------------------- templates

/** GET /api/hris/checklist-templates — all templates unless `isActive` filters. */
export async function listChecklistTemplates(
  context: ScopedTenantContext,
  actorUserId: string,
  query: PageQuery & {
    kind?: ChecklistKind | undefined;
    positionId?: string | undefined;
    isActive?: "true" | "false" | undefined;
  },
): Promise<Page<ChecklistTemplate>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId);
    if (access.reach([HRIS_MANAGE_CODE]) === null) throw forbidden();
    const filters: SQL[] = [
      eq(hrisChecklistTemplates.tenantId, context.tenant.tenantId),
    ];
    if (query.isActive)
      filters.push(
        eq(hrisChecklistTemplates.isActive, query.isActive === "true"),
      );
    if (query.kind) filters.push(eq(hrisChecklistTemplates.kind, query.kind));
    if (query.positionId)
      filters.push(eq(hrisChecklistTemplates.positionId, query.positionId));
    if (query.cursor) {
      const [title, id] = cursorPair(query.cursor);
      filters.push(
        or(
          gt(hrisChecklistTemplates.title, title),
          and(
            eq(hrisChecklistTemplates.title, title),
            gt(hrisChecklistTemplates.id, id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(hrisChecklistTemplates)
      .where(and(...filters))
      .orderBy(
        asc(hrisChecklistTemplates.title),
        asc(hrisChecklistTemplates.id),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toTemplate),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.title, last.id])
            : null,
      },
    };
  });
}

/** POST /api/hris/checklist-templates */
export async function createChecklistTemplate(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateChecklistTemplateInput,
  now = new Date(),
): Promise<ChecklistTemplate> {
  try {
    return await withTenant(db, context, async (tx) => {
      const access = await loadHrisAccess(tx, context, actorUserId, now);
      assertTenantWideManage(access);
      if (input.positionId !== null) {
        const [position] = await tx
          .select({ id: positions.id })
          .from(positions)
          .where(
            and(
              eq(positions.tenantId, context.tenant.tenantId),
              eq(positions.id, input.positionId),
            ),
          )
          .limit(1);
        if (!position) throw notFound("Jabatan");
      }
      const [row] = await tx
        .insert(hrisChecklistTemplates)
        .values({
          tenantId: context.tenant.tenantId,
          kind: input.kind,
          positionId: input.positionId,
          title: input.title,
          items: input.items,
          version: 1,
          isActive: true,
          createdBy: access.actorUserId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error("Checklist template insert returned no row");
      await auditTemplate(
        tx,
        context,
        access.actorUserId,
        now,
        "hris.checklist_template.created",
        row,
        ["title", "items"],
      );
      return toTemplate(row);
    });
  } catch (error) {
    return templateConflict(error);
  }
}

/** PATCH /api/hris/checklist-templates/:templateId */
export async function updateChecklistTemplate(
  context: ScopedTenantContext,
  actorUserId: string,
  templateId: string,
  input: UpdateChecklistTemplateInput,
  now = new Date(),
): Promise<ChecklistTemplate> {
  try {
    return await withTenant(db, context, async (tx) => {
      const access = await loadHrisAccess(tx, context, actorUserId, now);
      assertTenantWideManage(access);
      const [current] = await tx
        .select()
        .from(hrisChecklistTemplates)
        .where(
          and(
            eq(hrisChecklistTemplates.tenantId, context.tenant.tenantId),
            eq(hrisChecklistTemplates.id, templateId),
          ),
        )
        .limit(1)
        .for("update");
      if (!current) throw notFound("Template checklist");
      const changed: string[] = [];
      const values: Partial<typeof hrisChecklistTemplates.$inferInsert> = {};
      if (input.title !== undefined && input.title !== current.title) {
        values.title = input.title;
        changed.push("title");
      }
      if (input.items !== undefined) {
        values.items = input.items;
        values.version = current.version + 1;
        changed.push("items");
      }
      if (input.isActive !== undefined && input.isActive !== current.isActive) {
        values.isActive = input.isActive;
        changed.push("isActive");
      }
      if (changed.length === 0) return toTemplate(current);
      const [row] = await tx
        .update(hrisChecklistTemplates)
        .set({ ...values, updatedAt: now })
        .where(
          and(
            eq(hrisChecklistTemplates.tenantId, context.tenant.tenantId),
            eq(hrisChecklistTemplates.id, templateId),
          ),
        )
        .returning();
      if (!row) throw new Error("Checklist template update returned no row");
      await auditTemplate(
        tx,
        context,
        access.actorUserId,
        now,
        "hris.checklist_template.updated",
        row,
        changed,
      );
      return toTemplate(row);
    });
  } catch (error) {
    return templateConflict(error);
  }
}

// ------------------------------------------------------------- onboarding

/**
 * POST /api/hris/employees/:employeeId/onboarding — copies the active
 * onboarding template of the employee's position (else the default) into
 * tasks. The employee row lock serializes concurrent calls; a repeat returns
 * the existing tasks (`created: false`) and writes nothing.
 */
export async function startOnboarding(
  context: ScopedTenantContext,
  actorUserId: string,
  employeeId: string,
  now = new Date(),
): Promise<{ created: boolean; tasks: ChecklistTask[] }> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const employee = await findEmployee(tx, context, employeeId, true);
    if (!employee || access.viewerFor(employee) === null) throw notFound();
    if (!holdsManage(access, employee)) throw forbidden();

    const existing = await tx
      .select()
      .from(hrisChecklistTasks)
      .where(
        and(
          eq(hrisChecklistTasks.tenantId, context.tenant.tenantId),
          eq(hrisChecklistTasks.employeeId, employee.id),
          eq(hrisChecklistTasks.kind, "onboarding"),
        ),
      )
      .orderBy(asc(hrisChecklistTasks.sortOrder), asc(hrisChecklistTasks.id));
    if (existing.length > 0)
      return { created: false, tasks: existing.map(toTask) };

    if (employee.status === "resigned" || employee.status === "terminated")
      throw new HttpError(
        409,
        "EMPLOYEE_NOT_ACTIVE",
        "Karyawan sudah keluar; onboarding tidak bisa dimulai.",
      );

    const template = await pickOnboardingTemplate(tx, context, employee);
    if (!template)
      throw new HttpError(
        409,
        "CHECKLIST_TEMPLATE_MISSING",
        "Belum ada template onboarding aktif untuk jabatan ini atau default.",
      );
    const items = checklistTemplateItemSchema
      .array()
      .parse(template.items)
      .toSorted(
        (a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code),
      );
    const rows = await tx
      .insert(hrisChecklistTasks)
      .values(
        items.map((item) => ({
          tenantId: context.tenant.tenantId,
          employeeId: employee.id,
          offboardingId: null,
          templateId: template.id,
          kind: "onboarding" as const,
          code: item.code,
          title: item.title,
          category: item.category,
          requiresDocument: item.requiresDocument,
          sortOrder: item.sortOrder,
          status: "open" as const,
          systemManaged: false,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .returning();
    await recordAudit(
      tx,
      context,
      hrisAuditEntry(context, access.actorUserId, now, {
        outletId: employee.homeOutletId,
        action: "hris.onboarding.started",
        objectType: "employee",
        objectId: employee.id,
        after: { fields: ["checklist_tasks"], status: "open" },
      }),
      HRIS_AUDIT_SAFE_FIELDS,
    );
    return {
      created: true,
      tasks: rows.toSorted((a, b) => a.sortOrder - b.sortOrder).map(toTask),
    };
  });
}

async function pickOnboardingTemplate(
  tx: Tx,
  context: ScopedTenantContext,
  employee: EmployeeRow,
): Promise<TemplateRow | undefined> {
  const base = [
    eq(hrisChecklistTemplates.tenantId, context.tenant.tenantId),
    eq(hrisChecklistTemplates.kind, "onboarding"),
    eq(hrisChecklistTemplates.isActive, true),
  ];
  if (employee.positionId !== null) {
    const [own] = await tx
      .select()
      .from(hrisChecklistTemplates)
      .where(
        and(
          ...base,
          eq(hrisChecklistTemplates.positionId, employee.positionId),
        ),
      )
      .limit(1);
    if (own) return own;
  }
  const [fallback] = await tx
    .select()
    .from(hrisChecklistTemplates)
    .where(and(...base, sql`${hrisChecklistTemplates.positionId} IS NULL`))
    .limit(1);
  return fallback;
}

// ------------------------------------------------------------------ tasks

/** GET /api/hris/employees/:employeeId/checklist-tasks — HR-01: own or reach. */
export async function listChecklistTasks(
  context: ScopedTenantContext,
  actorUserId: string,
  employeeId: string,
  query: PageQuery & {
    kind?: ChecklistKind | undefined;
    status?: ChecklistTask["status"] | undefined;
  },
): Promise<Page<ChecklistTask>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId);
    const employee = await findEmployee(tx, context, employeeId);
    if (!employee || access.viewerFor(employee) === null) throw notFound();
    const filters: SQL[] = [
      eq(hrisChecklistTasks.tenantId, context.tenant.tenantId),
      eq(hrisChecklistTasks.employeeId, employee.id),
    ];
    if (query.kind) filters.push(eq(hrisChecklistTasks.kind, query.kind));
    if (query.status) filters.push(eq(hrisChecklistTasks.status, query.status));
    if (query.cursor) {
      const [cursorKind, sortOrder, id] = taskCursor(query.cursor);
      const kind = cursorKind as ChecklistKind;
      filters.push(
        or(
          gt(hrisChecklistTasks.kind, kind),
          and(
            eq(hrisChecklistTasks.kind, kind),
            gt(hrisChecklistTasks.sortOrder, sortOrder),
          ),
          and(
            eq(hrisChecklistTasks.kind, kind),
            eq(hrisChecklistTasks.sortOrder, sortOrder),
            gt(hrisChecklistTasks.id, id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(hrisChecklistTasks)
      .where(and(...filters))
      .orderBy(
        asc(hrisChecklistTasks.kind),
        asc(hrisChecklistTasks.sortOrder),
        asc(hrisChecklistTasks.id),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toTask),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.kind, String(last.sortOrder), last.id])
            : null,
      },
    };
  });
}

/**
 * POST /api/hris/checklist-tasks/:taskId/actions — complete, block, unblock or
 * waive one task.
 *   - block, unblock, waive: `hr.employee.manage` on the employee's outlet.
 *   - complete: the same, or the employee on their own onboarding task of
 *     category documents or training.
 *   - block and waive need a reason; the reason lands on the task and on the
 *     append-only action row together with the actor.
 *   - A system managed task is never completed by hand (409
 *     TASK_SYSTEM_MANAGED); a task that requires a document needs a document
 *     of the same employee (422).
 */
export async function applyChecklistTaskAction(
  context: ScopedTenantContext,
  actorUserId: string,
  taskId: string,
  input: ChecklistTaskActionInput,
  now = new Date(),
): Promise<ChecklistTask> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const task = await findTask(tx, context, taskId, true);
    if (!task) throw notFound("Tugas checklist");
    const employee = await findEmployee(tx, context, task.employeeId);
    const viewer = employee ? access.viewerFor(employee) : null;
    if (!employee || viewer === null) throw notFound("Tugas checklist");

    if (!holdsManage(access, employee)) {
      const ownOnboarding =
        viewer.kind === "self" &&
        input.action === "complete" &&
        task.kind === "onboarding" &&
        SELF_COMPLETE_CATEGORIES.includes(task.category);
      if (!ownOnboarding) throw forbidden();
    }

    const reason = input.reason?.trim() ?? "";
    if ((input.action === "block" || input.action === "waive") && !reason)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Alasan wajib diisi untuk menahan atau membebaskan tugas.",
      );
    if (input.documentId !== undefined && input.action !== "complete")
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Dokumen hanya bisa dilampirkan saat menyelesaikan tugas.",
      );

    if (input.idempotencyKey !== undefined) {
      const [replay] = await tx
        .select({ action: hrisChecklistTaskActions.action })
        .from(hrisChecklistTaskActions)
        .where(
          and(
            eq(hrisChecklistTaskActions.tenantId, context.tenant.tenantId),
            eq(hrisChecklistTaskActions.taskId, task.id),
            eq(hrisChecklistTaskActions.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (replay) {
        if (replay.action !== input.action)
          throw new CoreError(
            "IDEMPOTENCY_KEY_REUSED",
            "Idempotency key already used for a different request.",
          );
        return toTask(task);
      }
    }

    const from = task.status;
    const to = transitionChecklistTask(from, input.action);

    let documentId: string | null = null;
    if (input.action === "complete") {
      if (task.systemManaged)
        throw new HttpError(
          409,
          "TASK_SYSTEM_MANAGED",
          "Tugas ini diselesaikan sistem, bukan manual.",
        );
      const attached = input.documentId ?? task.documentId;
      if (task.requiresDocument && attached === null)
        throw new HttpError(
          422,
          "DOCUMENT_REQUIRED",
          "Tugas ini butuh dokumen karyawan sebelum diselesaikan.",
        );
      if (attached !== null) {
        const [document] = await tx
          .select({ id: employeeDocuments.id })
          .from(employeeDocuments)
          .where(
            and(
              eq(employeeDocuments.tenantId, context.tenant.tenantId),
              eq(employeeDocuments.id, attached),
              eq(employeeDocuments.employeeId, task.employeeId),
            ),
          )
          .limit(1);
        if (!document)
          throw new HttpError(
            422,
            "DOCUMENT_REQUIRED",
            "Dokumen tidak ditemukan untuk karyawan ini.",
          );
        documentId = document.id;
      }
    }

    const [updated] = await tx
      .update(hrisChecklistTasks)
      .set({
        status: to,
        updatedAt: now,
        ...(input.action === "complete"
          ? { doneBy: access.actorUserId, doneAt: now, documentId }
          : {}),
        ...(input.action === "block" ? { blockReason: reason } : {}),
        ...(input.action === "unblock" ? { blockReason: null } : {}),
        ...(input.action === "waive" ? { waiveReason: reason } : {}),
      })
      .where(
        and(
          eq(hrisChecklistTasks.tenantId, context.tenant.tenantId),
          eq(hrisChecklistTasks.id, task.id),
        ),
      )
      .returning();
    if (!updated) throw new Error("Checklist task update returned no row");
    await tx.insert(hrisChecklistTaskActions).values({
      tenantId: context.tenant.tenantId,
      taskId: task.id,
      action: input.action,
      fromStatus: from,
      toStatus: to,
      reason: reason || null,
      documentId,
      actorUserId: access.actorUserId,
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: now,
    });
    await recordAudit(
      tx,
      context,
      hrisAuditEntry(context, access.actorUserId, now, {
        outletId: employee.homeOutletId,
        action: `hris.checklist_task.${input.action}`,
        objectType: "checklist_task",
        objectId: task.id,
        after: { status: to },
      }),
      HRIS_AUDIT_SAFE_FIELDS,
    );
    return toTask(updated);
  });
}

/** GET /api/hris/checklist-tasks/:taskId/actions — the audit trail of one task. */
export async function listChecklistTaskActions(
  context: ScopedTenantContext,
  actorUserId: string,
  taskId: string,
  query: PageQuery,
): Promise<Page<ChecklistTaskAction>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId);
    const task = await findTask(tx, context, taskId);
    const employee = task
      ? await findEmployee(tx, context, task.employeeId)
      : undefined;
    const viewer = employee ? access.viewerFor(employee) : null;
    if (!task || viewer === null || viewer.kind === "self")
      throw notFound("Tugas checklist");
    const filters: SQL[] = [
      eq(hrisChecklistTaskActions.tenantId, context.tenant.tenantId),
      eq(hrisChecklistTaskActions.taskId, task.id),
    ];
    if (query.cursor) {
      const [createdAt, id] = cursorPair(query.cursor);
      const at = new Date(createdAt);
      if (Number.isNaN(at.getTime()))
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      filters.push(
        or(
          gt(hrisChecklistTaskActions.createdAt, at),
          and(
            eq(hrisChecklistTaskActions.createdAt, at),
            gt(hrisChecklistTaskActions.id, id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(hrisChecklistTaskActions)
      .where(and(...filters))
      .orderBy(
        asc(hrisChecklistTaskActions.createdAt),
        asc(hrisChecklistTaskActions.id),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toAction),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.createdAt.toISOString(), last.id])
            : null,
      },
    };
  });
}
