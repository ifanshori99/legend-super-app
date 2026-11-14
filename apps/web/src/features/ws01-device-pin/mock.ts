// Mock mode (VITE_API_MOCK=true) for the device PIN pad and approval flow.
//
// Mock PINs (stay in the mock; a real PIN is never in the repo):
//   Kasir 246810, Supervisor 482604. Anything else is a wrong PIN; the fifth
// wrong PIN locks the device for STAFF_PIN_LOCK_MINUTES (423 PIN_LOCKED).
//
// Phone approvals stay pending until decided from the console / e2e:
//   window.__legendDevicePinMock.decide("approved" | "rejected" | "expired")
import {
  cancelPosOverrideApproval,
  getPosOverrideApproval,
  posOverrideViewSchema,
  type CreatePosOverrideInput,
  type PosOverrideView,
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
import {
  endEmergencySession,
  endPosSession,
  startEmergencySession,
  startPosSession,
} from "./api.ts";
import { seedRosterIfEmpty } from "./storage.ts";

const cashier = fx.usersByKey.cashier;
const supervisor = fx.usersByKey.supervisor;
const PINS: Record<string, User> = {
  "246810": cashier,
  "482604": supervisor,
};

const attempts = createMockStore(() => resetStaffPinAttempts());
const requests = createMockStore(() => new Map<string, ApprovalRequest>());
// Phone overrides (supervisor_phone) by override id, as created: the status
// is read from the linked request in `requests` (see devicePinPosOverride).
const phoneOverrides = createMockStore(
  () => new Map<string, PosOverrideView>(),
);

// Test hooks (window.__legendDevicePinMock): how an approved phone request
// settles as an override ("pending" = not settled yet), and a cancel that fails.
type Settlement = "pending" | "rejected" | "cancelled" | "expired";
let settleAs: Settlement | null = null;
let cancelFails = false;
// dropNextCreate (H2): the next phone create is stored but its answer is lost
// (a network error); the same body sent again replays that request, as the
// server does for a repeated Idempotency-Key.
let dropNextCreate = false;
// failCreate (H2): every phone create is refused with this status (the server
// answered, nothing was stored).
let failCreateStatus: number | null = null;
let replay: { signature: string; response: { data: PosOverrideView } } | null =
  null;

function isPhoneOverrideRequest(requestId: string): boolean {
  for (const view of phoneOverrides.get().values())
    if (view.approvalRequestId === requestId) return true;
  return false;
}

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

registerMock(startEmergencySession, ({ body }) => {
  const now = new Date();
  const user = checkPin(body, now, body.staffUserId);
  // The mock PIN roster has one receiver: its supervisor. The cashier
  // template does not hold facility.emergency.respond.
  if (user.id !== supervisor.id)
    throw new ApiError(403, "FORBIDDEN", "Petugas tidak dapat menerima alarm.");
  return {
    data: {
      user: { id: user.id, displayName: user.displayName },
      outletId: fx.outletIds.bandung,
      // Mock duty covers the receiver's 14-hour maximum (API receiver service).
      expiresAt: new Date(now.getTime() + 14 * 60 * 60_000).toISOString(),
    },
  };
});

registerMock(endEmergencySession, () => undefined);

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

// PhoneWait poll on the POS path (E3): only the mock cashier's own phone
// override requests; anything else is 404 like the real scope.
registerMock(getPosOverrideApproval, ({ params }) => {
  const row = requests.get().get(params.requestId);
  if (!row || row.requestedBy !== cashier.id || !isPhoneOverrideRequest(row.id))
    throw new ApiError(404, "NOT_FOUND", "Permintaan tidak ditemukan.");
  return { data: row };
});

// POS "Berhenti menunggu" (E3): the mock device's cashier withdraws their own
// pending phone override (its approvalRequestId). Same answers as the real POS
// path: 404 for anything else (inbox requests included), 200 on a repeat, 409
// once decided or past the deadline. The inbox mock (ws01-approvals/mock.ts)
// reads the same store, so the cancel shows there.
registerMock(cancelPosOverrideApproval, ({ params }) => {
  const row = requests.get().get(params.requestId);
  if (!row || row.requestedBy !== cashier.id || !isPhoneOverrideRequest(row.id))
    throw new ApiError(404, "NOT_FOUND", "Permintaan tidak ditemukan.");
  if (cancelFails)
    throw new ApiError(500, "INTERNAL", "Pembatalan gagal (mock).");
  if (row.status === "cancelled") return { data: row };
  if (row.status !== "pending" || Date.parse(row.deadlineAt) <= Date.now())
    throw new ApiError(409, "CONFLICT", "Permintaan sudah diputuskan.");
  const cancelled = approvalRequestSchema.parse({
    ...row,
    status: "cancelled",
  });
  requests.get().set(cancelled.id, cancelled);
  return { data: cancelled };
});

// Supervisor override with the PIN typed on this device (legend-5vlw): the
// approver's PIN rides in the body, like the real POST /api/pos-overrides.
// The mock registry allows one handler per endpoint and ws04-pos-kasir/mock.ts
// owns it; that handler calls this first and falls back to its own engine
// when the approver is not one of the device PIN users (undefined here).
export function devicePinOverride(body: CreatePosOverrideInput) {
  if (body.approval.method === "supervisor_phone")
    return devicePinPhoneOverride(body);
  if (body.approval.method !== "supervisor_pin") return undefined;
  const approverUserId = body.approval.approverUserId;
  if (!Object.values(PINS).some((user) => user.id === approverUserId))
    return undefined;
  const now = new Date();
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
}

/**
 * supervisor_phone (E3): opens a pending request in this store (so the inbox
 * mock lists it and window.__legendDevicePinMock.decide settles it) and
 * answers like the real API: a pending override linked by approvalRequestId.
 */
function devicePinPhoneOverride(body: CreatePosOverrideInput) {
  if (failCreateStatus !== null)
    throw new ApiError(failCreateStatus, "FORBIDDEN", "Ditolak (mock).");
  const signature = JSON.stringify(body);
  if (replay !== null && replay.signature === signature) {
    const { response } = replay;
    replay = null;
    return response;
  }
  const now = new Date();
  const request = approvalRequestSchema.parse({
    id: crypto.randomUUID(),
    tenantId: fx.tenantId,
    outletId: body.outletId,
    actionType: body.action,
    objectType: "pos_override",
    objectId: crypto.randomUUID(),
    payload: {
      action: body.action,
      valueIdr: body.valueIdr,
      objectType: body.objectType,
      objectId: body.objectId,
      reasonCode: body.reasonCode ?? null,
    },
    requestedBy: cashier.id,
    source: "user",
    level: 1,
    requiredLevels: 1,
    amountIdr: body.valueIdr,
    status: "pending",
    requestReason: body.reason,
    decidedBy: null,
    decidedAt: null,
    reason: null,
    deadlineAt: new Date(
      now.getTime() + APPROVAL_DEADLINE_MINUTES * MINUTE_MS,
    ).toISOString(),
    createdAt: now.toISOString(),
  });
  requests.get().set(request.id, request);
  const view = posOverrideViewSchema.parse({
    id: createUlid(),
    tenantId: fx.tenantId,
    outletId: body.outletId,
    action: body.action,
    method: "supervisor_phone",
    status: "pending",
    requestedBy: cashier.id,
    approvedBy: null,
    reasonCode: body.reasonCode ?? null,
    reason: body.reason,
    valueIdr: body.valueIdr,
    objectType: body.objectType,
    objectId: body.objectId,
    approvalRequestId: request.id,
    createdAt: now.toISOString(),
    resolvedAt: null,
  });
  phoneOverrides.get().set(view.id, view);
  const response = { data: view };
  if (dropNextCreate) {
    dropNextCreate = false;
    replay = { signature, response };
    throw new ApiError(503, "UNAVAILABLE", "Jaringan terputus (mock).");
  }
  return response;
}

/**
 * A phone override raised here, settled from its request like the real
 * GET /api/pos-overrides/:overrideId; undefined when it is not one of ours.
 * For the getPosOverride handler (ws04-pos-kasir/mock.ts owns it).
 */
export function devicePinPosOverride(
  overrideId: string,
): { data: PosOverrideView } | undefined {
  const view = phoneOverrides.get().get(overrideId);
  if (!view || view.approvalRequestId === null) return undefined;
  const request = requests.get().get(view.approvalRequestId);
  if (!request) return undefined;
  const status =
    request.status === "pending" && Date.parse(request.deadlineAt) <= Date.now()
      ? "expired"
      : request.status;
  if (status === "pending") return { data: view };
  if (status === "approved" && settleAs !== null) {
    // The request is approved but the override settled otherwise (or not yet).
    if (settleAs === "pending") return { data: view };
    return {
      data: posOverrideViewSchema.parse({
        ...view,
        status: settleAs,
        approvedBy: null,
        resolvedAt: new Date().toISOString(),
      }),
    };
  }
  // AUTH-06: an approval by the requester (or by nobody) is no override.
  const approvedBy =
    status === "approved" &&
    request.decidedBy !== null &&
    request.decidedBy !== view.requestedBy
      ? request.decidedBy
      : null;
  return {
    data: posOverrideViewSchema.parse({
      ...view,
      status:
        status === "approved" && approvedBy === null ? "rejected" : status,
      approvedBy,
      resolvedAt: request.decidedAt ?? new Date().toISOString(),
    }),
  };
}

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
      settleOverride: (status: Settlement | null) => void;
      failCancel: (on: boolean) => void;
      dropNextCreate: (on: boolean) => void;
      failCreate: (status: number | null) => void;
      requestStatuses: () => string[];
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
    settleOverride(status) {
      settleAs = status;
    },
    failCancel(on) {
      cancelFails = on;
    },
    dropNextCreate(on) {
      dropNextCreate = on;
    },
    failCreate(status) {
      failCreateStatus = status;
    },
    requestStatuses: () => [...requests.get().values()].map((r) => r.status),
  };
}
