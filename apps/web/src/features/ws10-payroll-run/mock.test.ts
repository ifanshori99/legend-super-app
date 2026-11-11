// Payroll-run mock (bead legend-6pha, PAYR-01): the run is created and simulated
// by one person, approved by HR by a second and finally approved and locked by a
// third. The mock identity comes from the `legend-mock-role` cookie, so each test
// switches the cookie between steps.
//
// Assumptions (the spec does not name the cookie value of the creator):
// - `payroll-admin` is the third mock identity (payroll.run only, acts as
//   `userIds.runCreator`); `hr` acts as `hrApprover`; `finance` as `financeApprover`.
// - The creator's refusal at final approval is 403 (FORBIDDEN: payroll-admin has
//   no payroll.approve); at HR approval it is 403 PAYROLL_APPROVER_NOT_DISTINCT
//   (payroll-admin holds payroll.run, so the contract reducer is what refuses).
//
// No jsdom: the mock only reads `document.cookie`, so a one-field stub is enough
// and stays honest about what the code under test touches.
import {
  approvePayrollRunFinal,
  approvePayrollRunHr,
  cafeLegendPayrollFixtures,
  createPayrollRun,
  lockPayrollRun,
  simulatePayrollRun,
  type PayrollRun,
} from "@starter/shared/hris/payroll";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import { dispatchMock, resetMocks } from "@/lib/mock/runtime";

const { userIds, payrollPolicies } = cafeLegendPayrollFixtures;
const [monthlyPolicy] = payrollPolicies;
if (!monthlyPolicy) throw new Error("fixture has no payroll policy");

const cookieJar = { cookie: "" };
const asRole = (role: string) => {
  cookieJar.cookie = `legend-mock-role=${role}`;
};

beforeAll(async () => {
  Object.assign(globalThis, { document: cookieJar });
  // Imported after the stub so the handlers register against a browser-like runtime.
  await import("./mock");
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "document");
});

beforeEach(() => {
  resetMocks();
  cookieJar.cookie = "";
});

let periodSeq = 0;
/** A reference date in a month no fixture run covers; a new one per call. */
function freshReferenceDate(): string {
  periodSeq += 1;
  return `2028-${String(periodSeq).padStart(2, "0")}-15`;
}

type Endpoint = { method: string; path: string };
async function call(
  endpoint: Endpoint,
  options: { runId?: string; body: Record<string, unknown> },
): Promise<PayrollRun> {
  const path = options.runId
    ? endpoint.path.replace(":payrollRunId", options.runId)
    : endpoint.path;
  const response = (await dispatchMock({
    method: endpoint.method,
    path,
    body: options.body,
  })) as { data: PayrollRun };
  return response.data;
}

const action = (endpoint: Endpoint, runId: string) =>
  call(endpoint, { runId, body: { idempotencyKey: newIdempotencyKey() } });

async function createAndSimulate(): Promise<PayrollRun> {
  asRole("payroll-admin");
  const created = await call(createPayrollRun, {
    body: {
      payrollPolicyId: monthlyPolicy.id,
      runType: "regular",
      referenceDate: freshReferenceDate(),
      thrScheduleId: null,
      idempotencyKey: newIdempotencyKey(),
    },
  });
  expect(created.status).toBe("draft");
  expect(created.createdBy).toBe(userIds.runCreator);
  const simulated = await action(simulatePayrollRun, created.id);
  expect(simulated.status).toBe("simulated");
  return simulated;
}

describe("payroll run mock: three different people (PAYR-01)", () => {
  test("create + simulate, HR approve, final approve and lock by three people", async () => {
    const simulated = await createAndSimulate();

    asRole("hr");
    const hrApproved = await action(approvePayrollRunHr, simulated.id);
    expect(hrApproved.status).toBe("hr_approved");
    expect(hrApproved.approvedByHr).toBe(userIds.hrApprover);

    asRole("finance");
    const approved = await action(approvePayrollRunFinal, simulated.id);
    expect(approved.status).toBe("approved");
    expect(approved.approvedByFinance).toBe(userIds.financeApprover);

    const locked = await action(lockPayrollRun, simulated.id);
    expect(locked.status).toBe("locked");
    expect(locked.lockedBy).toBe(userIds.financeApprover);

    const people = new Set([
      locked.createdBy,
      locked.approvedByHr,
      locked.approvedByFinance,
    ]);
    expect(people.size).toBe(3);
    expect(userIds.runCreator).not.toBe(userIds.hrApprover);
    expect(userIds.runCreator).not.toBe(userIds.financeApprover);
    expect(userIds.hrApprover).not.toBe(userIds.financeApprover);
  });

  test("the owner cookie acts as the second approver like finance", async () => {
    const simulated = await createAndSimulate();
    asRole("hr");
    await action(approvePayrollRunHr, simulated.id);
    asRole("owner");
    const approved = await action(approvePayrollRunFinal, simulated.id);
    expect(approved.approvedByFinance).toBe(userIds.financeApprover);
  });
});

describe("payroll run mock: refusals", () => {
  test("the creator cannot give HR approval", async () => {
    const simulated = await createAndSimulate();

    asRole("payroll-admin");
    await expect(
      action(approvePayrollRunHr, simulated.id),
    ).rejects.toMatchObject({
      status: 403,
      code: "PAYROLL_APPROVER_NOT_DISTINCT",
    });

    // Nothing was recorded: HR can still approve afterwards.
    asRole("hr");
    const approved = await action(approvePayrollRunHr, simulated.id);
    expect(approved.status).toBe("hr_approved");
    expect(approved.approvedByHr).toBe(userIds.hrApprover);
  });

  test("the creator cannot give the final approval", async () => {
    const simulated = await createAndSimulate();
    asRole("hr");
    await action(approvePayrollRunHr, simulated.id);

    asRole("payroll-admin");
    await expect(
      action(approvePayrollRunFinal, simulated.id),
    ).rejects.toMatchObject({ status: 403 });

    // Still waiting for the final approver; finance can approve.
    asRole("finance");
    const approved = await action(approvePayrollRunFinal, simulated.id);
    expect(approved.status).toBe("approved");
    expect(approved.approvedByFinance).toBe(userIds.financeApprover);
  });

  test("the HR approver cannot also give the final approval", async () => {
    const simulated = await createAndSimulate();
    asRole("hr");
    await action(approvePayrollRunHr, simulated.id);
    await expect(
      action(approvePayrollRunFinal, simulated.id),
    ).rejects.toMatchObject({
      status: 403,
      code: "PAYROLL_APPROVER_NOT_DISTINCT",
    });
  });

  test("the creator cannot lock an approved run", async () => {
    const simulated = await createAndSimulate();
    asRole("hr");
    await action(approvePayrollRunHr, simulated.id);
    asRole("finance");
    await action(approvePayrollRunFinal, simulated.id);

    asRole("payroll-admin");
    await expect(action(lockPayrollRun, simulated.id)).rejects.toMatchObject({
      status: 403,
    });
  });

  test("an unknown role cannot create a run", async () => {
    asRole("no-such-role");
    await expect(
      call(createPayrollRun, {
        body: {
          payrollPolicyId: monthlyPolicy.id,
          runType: "regular",
          referenceDate: freshReferenceDate(),
          thrScheduleId: null,
          idempotencyKey: newIdempotencyKey(),
        },
      }),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  });
});
