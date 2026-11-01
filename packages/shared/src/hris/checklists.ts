// Onboarding and offboarding checklists (PRD v1.7 §3 Kelompok D 26 "Onboarding"
// and "Offboarding", §6 H `onboarding_tasks` / `offboarding_tasks`; F24).
//
// A template is the per-position checklist ("checklist per jabatan"); a task is
// the instance created for one employee. Offboarding tasks cover exit clearance
// (asset return, access/device revocation, final settlement, work certificate).

import {
  z,
  uuidSchema,
  tenantIdSchema,
  userIdSchema,
  isoDateTimeSchema,
  CoreError,
} from "../core/index.ts";
import {
  employeeIdSchema,
  positionIdSchema,
  checklistTemplateIdSchema,
  checklistTaskIdSchema,
} from "./ids.ts";

export const checklistKindSchema = z.enum(["onboarding", "offboarding"]);
export type ChecklistKind = z.infer<typeof checklistKindSchema>;

/** PRD F24 onboarding/offboarding checklist categories. */
export const checklistCategorySchema = z.enum([
  "documents",
  "uniform",
  "account",
  "training",
  "asset",
  "access_revocation",
  "final_settlement",
  "work_certificate",
  "other",
]);
export type ChecklistCategory = z.infer<typeof checklistCategorySchema>;

const taskTitle = z.string().min(1).max(200);
const taskCode = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, "Task codes are snake_case");

export const checklistTemplateItemSchema = z.strictObject({
  code: taskCode,
  title: taskTitle,
  category: checklistCategorySchema,
  /** A document must be uploaded before the task can be completed. */
  requiresDocument: z.boolean(),
  sortOrder: z.number().int().nonnegative(),
});
export type ChecklistTemplateItem = z.infer<typeof checklistTemplateItemSchema>;

export const checklistTemplateSchema = z
  .strictObject({
    id: checklistTemplateIdSchema,
    tenantId: tenantIdSchema,
    kind: checklistKindSchema,
    /** Per-position checklist; null = default for every position. */
    positionId: positionIdSchema.nullable(),
    title: z.string().min(1).max(150),
    items: z.array(checklistTemplateItemSchema).min(1),
  })
  .superRefine((template, ctx) => {
    const codes = new Set<string>();
    for (const item of template.items) {
      if (codes.has(item.code))
        ctx.addIssue({
          code: "custom",
          path: ["items"],
          message: `Duplicate checklist item code ${item.code}`,
        });
      codes.add(item.code);
    }
    for (const item of template.items)
      if (
        template.kind === "onboarding" &&
        (item.category === "final_settlement" ||
          item.category === "work_certificate" ||
          item.category === "access_revocation" ||
          item.category === "asset")
      )
        ctx.addIssue({
          code: "custom",
          path: ["items"],
          message: `Offboarding category ${item.category} is not valid on onboarding`,
        });
  });
export type ChecklistTemplate = z.infer<typeof checklistTemplateSchema>;

export const checklistTaskStatusSchema = z.enum([
  "open",
  "done",
  "blocked",
  "waived",
]);
export type ChecklistTaskStatus = z.infer<typeof checklistTaskStatusSchema>;

/** PRD §6 H `onboarding_tasks` / `offboarding_tasks` row. */
export const checklistTaskSchema = z
  .strictObject({
    id: checklistTaskIdSchema,
    tenantId: tenantIdSchema,
    employeeId: employeeIdSchema,
    templateId: checklistTemplateIdSchema.nullable(),
    kind: checklistKindSchema,
    code: taskCode,
    title: taskTitle,
    category: checklistCategorySchema,
    status: checklistTaskStatusSchema,
    dueAt: isoDateTimeSchema.nullable(),
    doneBy: userIdSchema.nullable(),
    doneAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((task, ctx) => {
    if ((task.doneBy === null) !== (task.doneAt === null))
      ctx.addIssue({
        code: "custom",
        message: "A completed task needs both actor and time",
      });
    if (task.status === "done" && task.doneAt === null)
      ctx.addIssue({
        code: "custom",
        path: ["doneAt"],
        message: "A done task needs a completion time",
      });
    if (task.status !== "done" && task.doneAt !== null)
      ctx.addIssue({
        code: "custom",
        path: ["doneAt"],
        message: "Only a done task carries a completion time",
      });
  });
export type ChecklistTask = z.infer<typeof checklistTaskSchema>;

const checklistTransitions: Partial<
  Record<
    ChecklistTaskStatus,
    Partial<
      Record<"complete" | "block" | "unblock" | "waive", ChecklistTaskStatus>
    >
  >
> = {
  open: { complete: "done", block: "blocked", waive: "waived" },
  blocked: { unblock: "open" },
};
export type ChecklistAction = "complete" | "block" | "unblock" | "waive";

/** Onboarding/offboarding task lifecycle. `done` and `waived` are terminal. */
export function transitionChecklistTask(
  status: ChecklistTaskStatus,
  action: ChecklistAction,
): ChecklistTaskStatus {
  const next = checklistTransitions[status]?.[action];
  if (!next)
    throw new CoreError(
      "CONFLICT",
      `Transisi checklist tidak valid: ${status} → ${action}.`,
    );
  return next;
}

/**
 * True when every task is done or waived. Blocked and open tasks keep the
 * checklist incomplete, so an offboarding clearance cannot close early.
 */
export function isChecklistComplete(
  tasks: readonly Pick<ChecklistTask, "status">[],
): boolean {
  return tasks.every(
    (task) => task.status === "done" || task.status === "waived",
  );
}

/** Open tasks due before `now`, for reminders on the employee home screen. */
export function dueChecklistTasks(
  tasks: readonly ChecklistTask[],
  now: Date,
): ChecklistTask[] {
  return tasks.filter(
    (task) =>
      task.status === "open" &&
      task.dueAt !== null &&
      Date.parse(task.dueAt) <= now.getTime(),
  );
}

/** A task id for the task-instance row; kept UUID like the other aggregates. */
export const checklistTaskId = uuidSchema;
