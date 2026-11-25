// Mock mode for the onboarding/offboarding screens: serves and updates the
// shared Cafe Legend checklist fixtures, so every screen works with
// VITE_API_MOCK=true (docs/frontend.md "Mock mode").
//
// It also owns the read-only payroll lists the final-settlement estimate needs
// (kasbon and reimbursement per employee); no other feature registers them
// yet. A later kasbon/reimbursement screen should import these handlers'
// fixtures or move the registration, never register a second time.
//
// The handler behaves like the API will: the caller's filters are applied
// server-side, the page is cursor-paginated, and an unknown task is 404. The
// only registered endpoint is `listChecklistTasks`; the task action has no
// endpoint yet, so it is applied to this store through ./local-action.ts and
// the screens refetch the list to see it.
import {
  cafeLegendHrisFixtures,
  checklistTaskSchema,
  finalSettlementSummarySchema,
  getOffboardingSettlement,
  outstandingLoans,
  listChecklistTasks,
  transitionChecklistTask,
  type ChecklistTask,
} from "@starter/shared/hris";
import {
  cafeLegendPayrollFixtures,
  listEmployeeLoans,
  listReimbursements,
} from "@starter/shared/hris/payroll";
import { ApiError } from "@/lib/api/errors";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { clearanceBlockers } from "./lib.ts";
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
  // Exit clearance gates the certificate: its task cannot be completed while
  // another offboarding task of the same employee is still open or blocked.
  if (
    action === "complete" &&
    current.kind === "offboarding" &&
    current.category === "work_certificate" &&
    clearanceBlockers(
      tasks.filter(
        (task) =>
          task.employeeId === current.employeeId && task.kind === "offboarding",
      ),
    ).length > 0
  )
    throw new ApiError(
      409,
      "CONFLICT",
      "Exit clearance belum selesai; surat keterangan belum bisa diterbitkan.",
    );
  // The contract's state machine decides the next status; an illegal move
  // throws CONFLICT exactly as the API route will.
  const status = transitionChecklistTask(current.status, action);
  const next = checklistTaskSchema.parse({
    ...current,
    status,
    doneBy: status === "done" ? MOCK_ACTOR : null,
    doneAt: status === "done" ? new Date().toISOString() : null,
    // The contract needs a reason on a blocked or waived task; the local
    // action carries none, so the preview stores a fixed note.
    blockReason: status === "blocked" ? "Ditandai terblokir (pratinjau)" : null,
    waiveReason: status === "waived" ? "Dibebaskan (pratinjau)" : null,
  });
  lifecycleMockTasks.set(
    tasks.map((task) => (task.id === taskId ? next : task)),
  );
  return next;
});

// The API's final-settlement summary, built from the fixture loans (kasbon).
// The fixture employee has no running payroll run, so only the kasbon and
// reimbursement counts carry numbers.
registerMock(getOffboardingSettlement, ({ params }) => {
  const task = lifecycleMockTasks
    .get()
    .find((row) => row.offboardingId === params.offboardingId);
  if (task === undefined)
    throw new ApiError(404, "NOT_FOUND", "Offboarding tidak ditemukan.");
  const loans = outstandingLoans(
    cafeLegendPayrollFixtures.employeeLoans.filter(
      (loan) => loan.employeeId === task.employeeId,
    ),
  );
  return {
    data: finalSettlementSummarySchema.parse({
      offboardingId: params.offboardingId,
      employeeId: task.employeeId,
      exitType: "resignation",
      joinDate: "2024-01-15",
      lastWorkingDate: "2026-11-30",
      runningSalary: {
        lastPayrollRun: null,
        unpaidFrom: null,
        unpaidTo: "2026-11-30",
        unpaidCalendarDays: 0,
      },
      outstandingLoans: loans,
      pendingPayrollDeductions: { count: 0, amountIdr: 0, loanIds: [] },
      unpaidReimbursements: { count: 0, amountIdr: 0, pendingCount: 0 },
      leave: [],
      pendingPayrollEngine: [],
      computedAt: "2026-11-25T00:00:00.000Z",
      frozen: false,
    }),
  };
});

registerMock(listEmployeeLoans, ({ query, scenario }) => {
  const rows = cafeLegendPayrollFixtures.employeeLoans
    .filter(
      (loan) =>
        query.employeeId === undefined || loan.employeeId === query.employeeId,
    )
    .filter(
      (loan) => query.status === undefined || loan.status === query.status,
    );
  return paginateFixture(rows, query, (loan) => loan.id, scenario);
});

registerMock(listReimbursements, ({ query, scenario }) => {
  const rows = cafeLegendPayrollFixtures.reimbursements
    .filter(
      (claim) =>
        query.employeeId === undefined || claim.employeeId === query.employeeId,
    )
    .filter(
      (claim) => query.status === undefined || claim.status === query.status,
    );
  return paginateFixture(rows, query, (claim) => claim.id, scenario);
});
