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
// its deadline to show the blocked/overdue state.
import { findDevicePinRequest } from "@/features/ws01-device-pin/mock";
import {
  approvalRequestSchema,
  cafeLegendIdentityFixtures,
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
  return rebased;
}

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

function find(requestId: string): ApprovalRequest {
  const row = requests.get().find((item) => item.id === requestId);
  if (!row) throw new ApiError(404, "NOT_FOUND", "Permintaan tidak ditemukan.");
  return row;
}

registerMock(listApprovalRequests, ({ query, scenario }) =>
  paginateFixture(
    requests
      .get()
      .filter(
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
  const own = requests.get().find((item) => item.id === params.requestId);
  // Override requests raised from the PIN pad (ws01-device-pin) live in its store.
  const request = own ?? findDevicePinRequest(params.requestId);
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
  const priorApproverIds = requests
    .get()
    .filter(
      (item) =>
        item.objectId === row.objectId &&
        item.actionType === row.actionType &&
        item.level < row.level &&
        item.status === "approved" &&
        item.decidedBy !== null,
    )
    .map((item) => item.decidedBy as UserId);
  const decide = () =>
    recordApprovalDecision({
      request: row,
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
  decided = approvalRequestSchema.parse(decided);
  requests.set(
    requests.get().map((item) => (item.id === row.id ? decided : item)),
  );
  if (key) replays.get().set(key, { fingerprint, result: decided });
  return { data: decided };
});
