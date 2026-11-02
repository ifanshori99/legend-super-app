// Mock mode for the onboarding/offboarding screens: serves and updates the
// shared Cafe Legend checklist fixtures, so every screen works with
// VITE_API_MOCK=true (docs/frontend.md "Mock mode").
//
// The handler behaves like the API will: the caller's filters are applied
// server-side, the page is cursor-paginated, and an unknown task is 404. The
// only registered endpoint is `listChecklistTasks`; the task action has no
// endpoint yet, so it is applied to this store through ./local-action.ts and
// the screens refetch the list to see it.
import {
  cafeLegendHrisFixtures,
  checklistTaskSchema,
  listChecklistTasks,
  transitionChecklistTask,
  type ChecklistTask,
} from "@starter/shared/hris";
import { ApiError } from "@/lib/api/errors";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { registerLocalTaskAction } from "./local-action.ts";

/** The mock's actor for a completed task: the HR admin of the fixtures. */
const MOCK_ACTOR = cafeLegendHrisFixtures.userIds.hrAdmin;

/**
 * Task rows a local action can change. Re-seeded by `resetMocks()`, so every
 * Playwright test starts from the fixture statuses.
 */
export const lifecycleMockTasks = createMockStore<ChecklistTask[]>(() => [
  ...cafeLegendHrisFixtures.checklistTasks,
]);

registerMock(listChecklistTasks, ({ params, query, scenario }) => {
  const rows = lifecycleMockTasks
    .get()
    .filter((task) => task.employeeId === params.employeeId)
    .filter((task) => query.kind === undefined || task.kind === query.kind)
    .filter(
      (task) => query.status === undefined || task.status === query.status,
    )
    .slice()
    .sort(
      (left, right) =>
        left.category.localeCompare(right.category) ||
        left.title.localeCompare(right.title, "id-ID"),
    );
  return paginateFixture(rows, query, (task) => task.id, scenario);
});

registerLocalTaskAction(({ taskId, action }) => {
  const tasks = lifecycleMockTasks.get();
  const current = tasks.find((task) => task.id === taskId);
  if (!current)
    throw new ApiError(404, "NOT_FOUND", "Tugas checklist tidak ditemukan.");
  // The contract's state machine decides the next status; an illegal move
  // throws CONFLICT exactly as the API route will.
  const status = transitionChecklistTask(current.status, action);
  const next = checklistTaskSchema.parse({
    ...current,
    status,
    doneBy: status === "done" ? MOCK_ACTOR : null,
    doneAt: status === "done" ? new Date().toISOString() : null,
  });
  lifecycleMockTasks.set(
    tasks.map((task) => (task.id === taskId ? next : task)),
  );
  return next;
});
