// Mock mode (VITE_API_MOCK=true) for the device PIN pad and approval flow.
//
// Mock PINs (stay in the mock; a real PIN is never in the repo):
//   Kasir 246810, Supervisor 482604. Anything else is a wrong PIN; the fifth
// wrong PIN locks the device for STAFF_PIN_LOCK_MINUTES (423 PIN_LOCKED).
//
// Phone approvals stay pending until decided from the console / e2e:
//   window.__legendDevicePinMock.decide("approved" | "rejected" | "expired")
import {
  createPosOverride,
  posOverrideViewSchema,
} from "@starter/shared/access/override";
import { createUlid } from "@starter/shared/core";
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
import { ACTING_STAFF_TTL_MS } from "@starter/shared/pos/acting-staff";
import { ApiError } from "@/lib/api/errors";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { endPosSession, startPosSession } from "./api.ts";
import { seedRosterIfEmpty } from "./storage.ts";

const cashier = fx.usersByKey.cashier;
const supervisor = fx.usersByKey.supervisor;
const PINS: Record<string, User> = {
  "246810": cashier,
  "482604": supervisor,
};

const attempts = createMockStore(() => resetStaffPinAttempts());
const requests = createMockStore(() => new Map<string, ApprovalRequest>());

/**
 * The PIN rules shared by /verify and /pos-session: lockout, then the PIN
 * table. With `onlyUserId` the PIN counts only for that user (the override's
 * picked approver): another user's PIN is a miss, never a reset.
 */
function checkPin(body: { pin: string }, now: Date, onlyUserId?: string): User {
  const state = attempts.get();
  if (
    state.lockedUntil !== null &&
    Date.parse(state.lockedUntil) > now.getTime()
  )
    throw new ApiError(423, "PIN_LOCKED", "PIN terkunci.");
  const found = PINS[body.pin];
  const user =
    found !== undefined && (onlyUserId === undefined || found.id === onlyUserId)
      ? found
      : undefined;
  attempts.set(
    recordStaffPinAttempt({ state, correct: user !== undefined, now }),
  );
  if (!user) {
    if (attempts.get().lockedUntil !== null)
      throw new ApiError(423, "PIN_LOCKED", "PIN terkunci.");
    throw new ApiError(401, "PIN_INVALID", "PIN salah.");
  }
  return user;
}

registerMock(verifyStaffPin, ({ body }) => {
  const now = new Date();
  const user = checkPin(body, now);
  return {
    data: {
      user,
      outletId: fx.outletIds.bandung,
      verifiedAt: now.toISOString(),
    },
  };
});

// POS switch: same PIN rules, plus the acting-staff token the real API issues.
registerMock(startPosSession, ({ body }) => {
  const now = new Date();
  const user = checkPin(body, now);
  return {
    data: {
      token: `pas_mock_${crypto.randomUUID()}`,
      expiresAt: new Date(now.getTime() + ACTING_STAFF_TTL_MS).toISOString(),
      staff: { id: user.id, displayName: user.displayName },
      outletId: fx.outletIds.bandung,
    },
  };
});

registerMock(endPosSession, () => undefined);

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

// Supervisor override with the PIN typed on this device (legend-5vlw): the
// approver's PIN rides in the body, like the real POST /api/pos-overrides.
registerMock(createPosOverride, ({ body }) => {
  const now = new Date();
  if (body.approval.method !== "supervisor_pin")
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Persetujuan ponsel memakai kotak approval.",
    );
  const approver = checkPin(body.approval, now, body.approval.approverUserId);
  if (approver.id === cashier.id)
    throw new ApiError(
      403,
      "APPROVER_IS_REQUESTER",
      "Penyetuju tidak boleh sama dengan peminta.",
    );
  return {
    data: posOverrideViewSchema.parse({
      id: createUlid(),
      tenantId: fx.tenantId,
      outletId: body.outletId,
      action: body.action,
      method: "supervisor_pin",
      status: "approved",
      requestedBy: cashier.id,
      approvedBy: approver.id,
      reasonCode: body.reasonCode ?? null,
      reason: body.reason,
      valueIdr: body.valueIdr,
      objectType: body.objectType,
      objectId: body.objectId,
      approvalRequestId: null,
      createdAt: now.toISOString(),
      resolvedAt: now.toISOString(),
    }),
  };
});

/**
 * Read by ws01-approvals/mock.ts, which merges these requests into the inbox
 * (one list, one decide, one cancel) next to its own fixtures.
 */
export function findDevicePinRequest(requestId: string) {
  return requests.get().get(requestId);
}
export function listDevicePinRequests(): ApprovalRequest[] {
  return [...requests.get().values()];
}
export function saveDevicePinRequest(request: ApprovalRequest) {
  requests.get().set(request.id, request);
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
