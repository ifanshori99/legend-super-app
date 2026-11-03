// Mock mode (VITE_API_MOCK=true) for the device PIN pad and approval flow.
//
// Mock PINs (stay in the mock; a real PIN is never in the repo):
//   Kasir 246810, Supervisor 482604. Anything else is a wrong PIN; the fifth
// wrong PIN locks the device for STAFF_PIN_LOCK_MINUTES (423 PIN_LOCKED).
//
// Phone approvals stay pending until decided from the console / e2e:
//   window.__legendDevicePinMock.decide("approved" | "rejected" | "expired")
import {
  APPROVAL_DEADLINE_MINUTES,
  MINUTE_MS,
  approvalRequestSchema,
  cafeLegendIdentityFixtures as fx,
  createApprovalRequest,
  recordStaffPinAttempt,
  resetStaffPinAttempts,
  verifyStaffPin,
  type ApprovalRequest,
  type User,
} from "@starter/shared/identity";
import { ApiError } from "@/lib/api/errors";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { seedRosterIfEmpty } from "./storage.ts";

const cashier = fx.usersByKey.cashier;
const supervisor = fx.usersByKey.supervisor;
const PINS: Record<string, User> = {
  "246810": cashier,
  "482604": supervisor,
};

const attempts = createMockStore(() => resetStaffPinAttempts());
const requests = createMockStore(() => new Map<string, ApprovalRequest>());

registerMock(verifyStaffPin, ({ body }) => {
  const now = new Date();
  const state = attempts.get();
  if (
    state.lockedUntil !== null &&
    Date.parse(state.lockedUntil) > now.getTime()
  )
    throw new ApiError(423, "PIN_LOCKED", "PIN terkunci.");
  const user = PINS[body.pin];
  attempts.set(
    recordStaffPinAttempt({ state, correct: user !== undefined, now }),
  );
  if (!user) {
    if (attempts.get().lockedUntil !== null)
      throw new ApiError(423, "PIN_LOCKED", "PIN terkunci.");
    throw new ApiError(401, "PIN_INVALID", "PIN salah.");
  }
  return {
    data: {
      user,
      outletId: fx.outletIds.bandung,
      verifiedAt: now.toISOString(),
    },
  };
});

registerMock(createApprovalRequest, ({ body }) => {
  const now = Date.now();
  const request = approvalRequestSchema.parse({
    id: crypto.randomUUID(),
    tenantId: fx.tenantId,
    outletId: body.outletId ?? fx.outletIds.bandung,
    actionType: body.actionType,
    objectType: body.objectType,
    objectId: body.objectId,
    payload: body.payload,
    requestedBy: cashier.id,
    source: "user",
    level: 1,
    requiredLevels: 1,
    amountIdr: body.amountIdr ?? null,
    status: "pending",
    requestReason: body.requestReason,
    decidedBy: null,
    decidedAt: null,
    reason: null,
    deadlineAt: new Date(
      now + APPROVAL_DEADLINE_MINUTES * MINUTE_MS,
    ).toISOString(),
    createdAt: new Date(now).toISOString(),
  });
  requests.get().set(request.id, request);
  return { data: request };
});

/** Read by ws01-approvals/mock.ts, which owns the getApprovalRequest handler. */
export function findDevicePinRequest(requestId: string) {
  return requests.get().get(requestId);
}

type Decision = "approved" | "rejected" | "expired";

declare global {
  interface Window {
    __legendDevicePinMock?: {
      decide: (decision: Decision) => void;
      unlock: () => void;
    };
  }
}

if (typeof window !== "undefined") {
  seedRosterIfEmpty([
    { userId: cashier.id, displayName: cashier.displayName },
    { userId: supervisor.id, displayName: supervisor.displayName },
  ]);
  window.__legendDevicePinMock = {
    decide(decision) {
      const nowIso = new Date().toISOString();
      for (const [id, request] of requests.get()) {
        if (request.status !== "pending") continue;
        requests.get().set(
          id,
          approvalRequestSchema.parse({
            ...request,
            status: decision,
            ...(decision === "expired"
              ? {}
              : {
                  decidedBy: supervisor.id,
                  decidedAt: nowIso,
                  reason:
                    decision === "rejected"
                      ? "Nilai tidak sesuai dengan struk."
                      : null,
                }),
          }),
        );
      }
    },
    unlock: () => attempts.set(resetStaffPinAttempts()),
  };
}
