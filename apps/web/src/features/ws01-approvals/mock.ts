// Mock mode for the approval inbox (VITE_API_MOCK=true). Serves the identity
// fixtures, rebased on the mock clock so deadlines count down for real, and
// enforces the same rules as the service by calling the shared lifecycle
// (`recordApprovalDecision`: pending-only, deadline fail-closed, AUTH-06
// approver ≠ requester, a different person per level, 3..500 char reason),
// plus a second factor for the decision (AUTH-05) and Idempotency-Key replay.
//
// The signed-in mock user is the owner (ws01-auth mock). The AI price change
// in the fixtures was requested by the owner, so it demonstrates the
// "cannot decide your own request" state; one pending request is already past
// its deadline to show the blocked/overdue state. One more pending request is
// the sole Owner's own and carries `selfApprovalAllowed` (legend-mbhw1): the
// mock lets them approve it, never reject it.
import {
  findDevicePinRequest,
  listDevicePinRequests,
  saveDevicePinRequest,
} from "@/features/ws01-device-pin/mock";
import {
  approvalRequestSchema,
  cafeLegendIdentityFixtures,
  cancelApprovalRequest,
  decideApprovalRequest,
  getApprovalRequest,
  listApprovalRequests,
  recordApprovalDecision,
  type ApprovalRequest,
} from "@starter/shared/identity";
import type { UserId } from "@starter/shared/core";
import { ApiError } from "@/lib/api/errors";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { staffCurrentAuthMock } from "../ws01-auth/mock.ts";

const MIN = 60_000;
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();

/** Minutes until the deadline (negative = already past) per fixture index. */
const DEADLINE_MIN = [22, 47, 9, 130] as const;

function seed(): ApprovalRequest[] {
  const base = cafeLegendIdentityFixtures.approvalRequests;
  const rebased = base.map((row, index) => {
    const createdOffset = -(40 + index * 7) * MIN;
    const deadlineMin = DEADLINE_MIN[index];
    if (row.status === "pending" && deadlineMin !== undefined)
      return approvalRequestSchema.parse({
        ...row,
        createdAt: iso(createdOffset),
        deadlineAt: iso(deadlineMin * MIN),
      });
    return approvalRequestSchema.parse({
      ...row,
      createdAt: iso(-(3 * 60 + index * 20) * MIN),
      deadlineAt: iso(-(2 * 60 + index * 20) * MIN),
      decidedAt: row.decidedAt ? iso(-(2 * 60 + 30 + index * 20) * MIN) : null,
    });
  });
  // A pending request that nobody decided in time: the action stays blocked.
  const late = base[1];
  if (late)
    rebased.push(
      approvalRequestSchema.parse({
        ...late,
        id: "a9c00000-0000-4000-8000-0000000000f1",
        level: 1,
        createdAt: iso(-95 * MIN),
        deadlineAt: iso(-12 * MIN),
        amountIdr: 410_000,
        payload: { ...late.payload, discountIdr: 410_000 },
      }),
    );
  // The sole Owner's own shareholder-list change (legend-mbhw1): approvable
  // by them alone. A user request, so the AI/MCP rows stay as they were.
  const template = base[0];
  if (template)
    rebased.push(
      approvalRequestSchema.parse({
        ...template,
        id: SELF_APPROVABLE_ID,
        actionType: "shareholder_version",
        objectType: "shareholder_version",
        payload: { versionLabel: "Daftar pemegang saham Nov 2026" },
        requestedBy: cafeLegendIdentityFixtures.usersByKey.owner.id,
        source: "user",
        amountIdr: null,
        requestReason:
          "Daftar pemegang saham diperbarui setelah penyesuaian porsi.",
        createdAt: iso(-18 * MIN),
        deadlineAt: iso(60 * MIN),
        selfApprovalAllowed: true,
      }),
    );
  // Shift close (legend-6om3): the cash difference rides in payload.valueIdr
  // (amountIdr stays null). Raised by the cashier, so the signed-in owner
  // sees it as approver; the second one is the owner's own, i.e. the
  // requester view that must not show the figure.
  if (template) {
    const shiftClose = {
      ...template,
      actionType: "cash_shift_close",
      objectType: "pos_shift",
      source: "user",
      amountIdr: null,
      level: 1,
      requiredLevels: 1,
      selfApprovalAllowed: false,
      createdAt: iso(-8 * MIN),
      deadlineAt: iso(50 * MIN),
    } as const;
    rebased.push(
      approvalRequestSchema.parse({
        ...shiftClose,
        id: SHIFT_CLOSE_APPROVER_ID,
        payload: {
          shiftCode: "S-008",
          terminal: "Terminal 01",
          valueIdr: 20_000,
        },
        requestedBy: cafeLegendIdentityFixtures.usersByKey.cashier.id,
        requestReason: "Hitungan kas akhir shift berbeda dari sistem.",
      }),
      approvalRequestSchema.parse({
        ...shiftClose,
        id: SHIFT_CLOSE_REQUESTER_ID,
        payload: {
          shiftCode: "S-009",
          terminal: "Terminal 02",
          valueIdr: 15_000,
        },
        requestedBy: cafeLegendIdentityFixtures.usersByKey.owner.id,
        requestReason: "Hitungan kas akhir shift berbeda dari sistem.",
      }),
    );
  }
  return rebased;
}

export const SHIFT_CLOSE_APPROVER_ID = "a9c00000-0000-4000-8000-0000000000f3";
export const SHIFT_CLOSE_REQUESTER_ID = "a9c00000-0000-4000-8000-0000000000f4";
export const SELF_APPROVABLE_ID = "a9c00000-0000-4000-8000-0000000000f2";

const requests = createMockStore<ApprovalRequest[]>(seed);
/** Idempotency-Key → (request + body fingerprint, stored result). */
const replays = createMockStore<
  Map<string, { fingerprint: string; result: ApprovalRequest }>
>(() => new Map());

/** The shared machines throw IdentityError / AccessError ({ code, status }). */
function asApiError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const { code, status, message } = error as {
    code?: string;
    status?: number;
    message?: string;
  };
  if (code && status) throw new ApiError(status, code, message ?? code);
  throw error;
}

/** Fixture requests plus the override requests raised from the PIN pad. */
function allRequests(): ApprovalRequest[] {
  return [...requests.get(), ...listDevicePinRequests()];
}

function save(row: ApprovalRequest) {
  if (requests.get().some((item) => item.id === row.id))
    requests.set(
      requests.get().map((item) => (item.id === row.id ? row : item)),
    );
  else saveDevicePinRequest(row);
}

function find(requestId: string): ApprovalRequest {
  const row = allRequests().find((item) => item.id === requestId);
  if (!row) throw new ApiError(404, "NOT_FOUND", "Permintaan tidak ditemukan.");
  return row;
}

registerMock(listApprovalRequests, ({ query, scenario }) =>
  paginateFixture(
    allRequests().filter(
      (row) =>
        (!query.status || row.status === query.status) &&
        (!query.source || row.source === query.source) &&
        (!query.actionType || row.actionType === query.actionType),
    ),
    query,
    (row) => row.id,
    scenario,
  ),
);

registerMock(getApprovalRequest, ({ params }) => {
  // Override requests raised from the PIN pad (ws01-device-pin) are in the list too.
  const request =
    requests.get().find((item) => item.id === params.requestId) ??
    findDevicePinRequest(params.requestId);
  if (!request)
    throw new ApiError(404, "NOT_FOUND", "Permintaan tidak ditemukan.");
  return { data: request };
});

registerMock(decideApprovalRequest, ({ params, body, scenario, headers }) => {
  const key = headers?.["Idempotency-Key"];
  const fingerprint = JSON.stringify([params.requestId, body]);
  const replay = key ? replays.get().get(key) : undefined;
  if (replay) {
    if (replay.fingerprint !== fingerprint)
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Kunci idempotensi dipakai untuk keputusan lain.",
      );
    return { data: replay.result };
  }
  const row = find(params.requestId);
  const me = cafeLegendIdentityFixtures.usersByKey.owner;
  // Approvers of earlier levels of the same chain (same object and action).
  const priorApproverIds = allRequests()
    .filter(
      (item) =>
        item.objectId === row.objectId &&
        item.actionType === row.actionType &&
        item.level < row.level &&
        item.status === "approved" &&
        item.decidedBy !== null,
    )
    .map((item) => item.decidedBy as UserId);
  const selfApproving =
    row.selfApprovalAllowed === true && row.requestedBy === me.id;
  if (selfApproving && body.decision === "rejected")
    throw new ApiError(
      403,
      "APPROVER_IS_REQUESTER",
      "Permintaan sendiri hanya bisa disetujui.",
    );
  const decide = () =>
    recordApprovalDecision({
      // The service skips the distinct-actor rule for the sole Owner; the
      // shared lifecycle has no such switch, so the mock hands it a stand-in.
      request: selfApproving
        ? {
            ...row,
            requestedBy: cafeLegendIdentityFixtures.usersByKey.cashier.id,
          }
        : row,
      decision: body.decision,
      decidedBy: me.id,
      priorApproverIds,
      reason: body.reason,
      now: new Date(),
    });
  let decided: ApprovalRequest;
  try {
    decided = decide();
  } catch (error) {
    asApiError(error);
  }
  // The rules above pass before the factor check, as the service orders them.
  const auth = staffCurrentAuthMock({ scenario });
  if (me.mfaRequired && auth.data.session?.mfaVerifiedAt == null)
    throw new ApiError(
      403,
      "MFA_REQUIRED",
      "Verifikasi faktor kedua diperlukan.",
    );
  decided = approvalRequestSchema.parse({
    ...decided,
    requestedBy: row.requestedBy,
  });
  save(decided);
  if (key) replays.get().set(key, { fingerprint, result: decided });
  return { data: decided };
});

// The requester withdraws their own pending request ("Berhenti menunggu").
// Only the requester sees it (404 for anyone else), pending-only; repeating a
// cancel is a no-op 200. Requests raised from the PIN pad belong to the mock
// device's cashier, fixture requests to the signed-in owner.
registerMock(cancelApprovalRequest, ({ params }) => {
  const row = find(params.requestId);
  const fromPinPad = findDevicePinRequest(row.id) !== undefined;
  const requester = fromPinPad
    ? cafeLegendIdentityFixtures.usersByKey.cashier
    : cafeLegendIdentityFixtures.usersByKey.owner;
  if (row.requestedBy !== requester.id)
    throw new ApiError(404, "NOT_FOUND", "Permintaan tidak ditemukan.");
  if (row.status === "cancelled") return { data: row };
  if (row.status !== "pending")
    throw new ApiError(
      409,
      "APPROVAL_NOT_PENDING",
      "Permintaan sudah diputuskan.",
    );
  const cancelled = approvalRequestSchema.parse({
    ...row,
    status: "cancelled",
  });
  save(cancelled);
  return { data: cancelled };
});
