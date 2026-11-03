// Mock mode for the approval inbox (VITE_API_MOCK=true). Serves the identity
// fixtures, rebased on the mock clock so deadlines count down for real, and
// enforces the same rules as the service: AUTH-06 distinct actor, a second
// factor for the decision (AUTH-05), pending-only, deadline fail-closed.
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
  type ApprovalRequest,
} from "@starter/shared/identity";
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

registerMock(decideApprovalRequest, ({ params, body, scenario }) => {
  const row = find(params.requestId);
  if (row.status !== "pending")
    throw new ApiError(
      409,
      "APPROVAL_REQUEST_NOT_PENDING",
      "Permintaan ini sudah diputuskan.",
    );
  if (Date.parse(row.deadlineAt) <= Date.now())
    throw new ApiError(
      410,
      "APPROVAL_REQUEST_EXPIRED",
      "Batas waktu persetujuan sudah lewat.",
    );
  const me = cafeLegendIdentityFixtures.usersByKey.owner;
  if (row.requestedBy.toLowerCase() === me.id.toLowerCase())
    throw new ApiError(
      403,
      "APPROVER_IS_REQUESTER",
      "Penyetuju tidak boleh sama dengan pemohon.",
    );
  const auth = staffCurrentAuthMock({ scenario });
  if (me.mfaRequired && auth.data.session?.mfaVerifiedAt == null)
    throw new ApiError(
      403,
      "MFA_REQUIRED",
      "Verifikasi faktor kedua diperlukan.",
    );
  const decided = approvalRequestSchema.parse({
    ...row,
    status: body.decision,
    decidedBy: me.id,
    decidedAt: new Date().toISOString(),
    reason: body.reason,
  });
  requests.set(
    requests.get().map((item) => (item.id === row.id ? decided : item)),
  );
  return { data: decided };
});
