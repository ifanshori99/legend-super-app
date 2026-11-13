// Mock mode for the employee master (docs/frontend.md "Typed endpoints and
// mock mode"). Every read this screen needs is registered by the shared HRIS
// read models in `lib/mock/handlers/hris-directory.ts` (one owner per
// endpoint), so this file registers the writes the back office performs:
// HR-03 `updateEmployeePii` and the payslip PIN reset
// `resetEmployeePayslipPin`.
//
// The handler keeps the contract's promise: the request carries raw values
// only, the response carries masked values only, and the shared store is
// updated so the profile's refetch shows the new masked form.
import {
  cafeLegendHrisFixtures,
  maskPiiValue,
  updateEmployeePii,
  type EmployeePii,
  type PiiMaskRule,
} from "@starter/shared/hris";
import { resetEmployeePayslipPin } from "@starter/shared/hris/payroll";
import { ApiError } from "@/lib/api/errors";
import {
  hrisMockPiiStore,
  mockHrisViewer,
  redactEmployeePii,
  setHrisMockPii,
} from "@/lib/mock/handlers/hris-directory";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { resetMockPayslipPin } from "../ws10-payslip/mock";

/** Mask rule per field, matching `HRIS_PII_FIELDS` in the PII contract. */
const PII_MASK_RULE: Record<
  Exclude<keyof EmployeePii, "bankCode">,
  PiiMaskRule
> = {
  nik: "last4",
  npwp: "last4",
  bpjsKesNo: "last4",
  bpjsTkNo: "last4",
  bankAccount: "last4",
  emergencyContactName: "name",
  emergencyContactPhone: "last4",
};

type Replay = { fingerprint: string; result: EmployeePii };

/**
 * Idempotency replays: the same key + the same body returns the first result,
 * a reused key with another body is `IDEMPOTENCY_KEY_REUSED` 409, exactly like
 * the API (docs/plan/contracts.md "Idempotent mutations"). A store, so
 * `resetMocks()` clears it with the rest of the mock state.
 */
const replays = createMockStore<Record<string, Replay>>(() => ({}));

registerMock(updateEmployeePii, ({ params, body }) => {
  // HR-03: only HR with `hr.employee.manage` writes personal data. The owner
  // template holds the permission but its viewer kind sees none of these
  // classes, so it is refused like any other role (fail closed).
  const viewer = mockHrisViewer();
  if (
    viewer === null ||
    viewer.kind !== "hr" ||
    !viewer.permissions.includes("hr.employee.manage")
  )
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Peran Anda tidak boleh mengubah data pribadi karyawan.",
    );
  const { idempotencyKey, ...values } = body;
  const fingerprint = JSON.stringify(values);
  const previous = replays.get()[idempotencyKey];
  if (previous !== undefined) {
    if (previous.fingerprint !== fingerprint)
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Kunci idempotensi sudah dipakai dengan isi yang berbeda.",
      );
    return {
      data: redactEmployeePii(viewer, params.employeeId, previous.result),
    };
  }

  const current = hrisMockPiiStore.get()[params.employeeId];
  if (current === undefined)
    throw new ApiError(404, "NOT_FOUND", "Karyawan tidak ditemukan.");

  const patch: Partial<EmployeePii> = {};
  // `bankCode` is a plain column (not sealed): copied as-is, `null` clears it.
  // Like the API, a new account sent without a code empties the old code so a
  // stale code never reaches a transfer file.
  if (values.bankCode !== undefined) patch.bankCode = values.bankCode;
  else if (values.bankAccount !== undefined) patch.bankCode = null;
  for (const field of Object.keys(
    PII_MASK_RULE,
  ) as (keyof typeof PII_MASK_RULE)[]) {
    const value = values[field];
    if (value === undefined) continue;
    patch[field] = {
      masked: maskPiiValue(value, PII_MASK_RULE[field]),
      // The mock has no key rotation; keep the stored version.
      keyVersion: current[field]?.keyVersion ?? 1,
    };
  }

  const result = setHrisMockPii(params.employeeId, patch);
  replays.set({ ...replays.get(), [idempotencyKey]: { fingerprint, result } });
  return { data: redactEmployeePii(viewer, params.employeeId, result) };
});

/** Idempotency key → request fingerprint, same rules as `replays` above. */
const pinResetReplays = createMockStore<Record<string, string>>(() => ({}));

const NOT_SET = { status: "not_set", lockedUntil: null } as const;

registerMock(resetEmployeePayslipPin, ({ params, body }) => {
  // Only HR with `payroll.run` resets a PIN; HR never sees or sets the new one.
  const viewer = mockHrisViewer();
  if (viewer === null || !viewer.permissions.includes("payroll.run"))
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Peran Anda tidak boleh mereset PIN slip gaji.",
    );
  const { idempotencyKey, ...values } = body;
  const fingerprint = `${params.employeeId}|${JSON.stringify(values)}`;
  const previous = pinResetReplays.get()[idempotencyKey];
  if (previous !== undefined && previous !== fingerprint)
    throw new ApiError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "Kunci idempotensi sudah dipakai dengan isi yang berbeda.",
    );
  // A retry must not wipe a PIN the employee created after the first reset.
  if (previous !== undefined) return { data: NOT_SET };
  if (
    !cafeLegendHrisFixtures.employees.some(
      (employee) => employee.id === params.employeeId,
    )
  )
    throw new ApiError(404, "NOT_FOUND", "Karyawan tidak ditemukan.");
  pinResetReplays.set({
    ...pinResetReplays.get(),
    [idempotencyKey]: fingerprint,
  });
  return { data: resetMockPayslipPin(params.employeeId) };
});
