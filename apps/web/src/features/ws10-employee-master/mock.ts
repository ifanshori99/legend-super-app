// Mock mode for the employee master (docs/frontend.md "Typed endpoints and
// mock mode"). Every read this screen needs is registered by the shared HRIS
// read models in `lib/mock/handlers/hris-directory.ts` (one owner per
// endpoint), so this file registers the one write the back office performs:
// HR-03 `updateEmployeePii`.
//
// The handler keeps the contract's promise: the request carries raw values
// only, the response carries masked values only, and the shared store is
// updated so the profile's refetch shows the new masked form.
import {
  maskPiiValue,
  updateEmployeePii,
  type EmployeePii,
  type PiiMaskRule,
} from "@starter/shared/hris";
import { ApiError } from "@/lib/api/errors";
import {
  hrisMockPiiStore,
  mockHrisViewer,
  redactEmployeePii,
  setHrisMockPii,
} from "@/lib/mock/handlers/hris-directory";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";

/** Mask rule per field, matching `HRIS_PII_FIELDS` in the PII contract. */
const PII_MASK_RULE: Record<keyof EmployeePii, PiiMaskRule> = {
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
  for (const field of Object.keys(PII_MASK_RULE) as (keyof EmployeePii)[]) {
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
