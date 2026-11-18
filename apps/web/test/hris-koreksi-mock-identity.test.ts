import { randomUUID } from "node:crypto";
import { createUlid } from "@starter/shared/core";
import { requestAttendanceCorrection } from "@starter/shared/hris";
import {
  MOCK_ME,
  MOCK_OUTLET,
  hrisMockStore,
} from "@/lib/mock/handlers/hris-directory";
import { dispatchMock, resetMocks } from "@/lib/mock/runtime";
import "@/features/ws10-hris-employee/mock";

beforeEach(() => resetMocks());

function correctionBody(expectedEmployeeId: string) {
  return requestAttendanceCorrection.body.parse({
    outletId: MOCK_OUTLET.id,
    expectedEmployeeId,
    attendanceLogId: null,
    requestedType: "in",
    requestedOccurredAt: "2026-11-15T01:00:00.000Z",
    reason: "Lupa absen masuk",
    idempotencyKey: `key-${createUlid()}`,
  });
}

test("1124: mock rejects another expected employee without creating a correction", async () => {
  const body = correctionBody(randomUUID());
  const before = hrisMockStore.get().corrections.length;

  await expect(
    dispatchMock({
      method: requestAttendanceCorrection.method,
      path: requestAttendanceCorrection.path,
      body,
    }),
  ).rejects.toMatchObject({
    status: 409,
    code: "ATTENDANCE_CORRECTION_IDENTITY_MISMATCH",
  });

  expect(hrisMockStore.get().corrections).toHaveLength(before);
  expect(
    hrisMockStore.get().correctionReplays[body.idempotencyKey],
  ).toBeUndefined();
});

test("1124: mock accepts the session employee and rejects a mismatched replay", async () => {
  const body = correctionBody(MOCK_ME.id);
  const correction = requestAttendanceCorrection.response.parse(
    await dispatchMock({
      method: requestAttendanceCorrection.method,
      path: requestAttendanceCorrection.path,
      body,
    }),
  );
  expect(correction.data.employeeId).toBe(MOCK_ME.id);
  const before = hrisMockStore.get().corrections.length;

  await expect(
    dispatchMock({
      method: requestAttendanceCorrection.method,
      path: requestAttendanceCorrection.path,
      body: { ...body, expectedEmployeeId: randomUUID() },
    }),
  ).rejects.toMatchObject({
    status: 409,
    code: "ATTENDANCE_CORRECTION_IDENTITY_MISMATCH",
  });
  expect(hrisMockStore.get().corrections).toHaveLength(before);
});
