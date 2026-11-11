// Typed endpoint callers for the approval inbox (docs/frontend.md "Typed
// endpoints and mock mode"). Components use the hooks in ./hooks.ts.
import {
  cancelApprovalRequest,
  decideApprovalRequest,
  getApprovalRequest,
  listApprovalRequests,
  verifyMfaFactor,
  type ApprovalDecisionInput,
  type ApprovalInboxQuery,
} from "@starter/shared/identity";
import { callEndpoint } from "@/lib/api/endpoint";

export function fetchApprovals(
  query: ApprovalInboxQuery,
  signal?: AbortSignal,
) {
  return callEndpoint(listApprovalRequests, { query }, { signal });
}

export function fetchApproval(requestId: string, signal?: AbortSignal) {
  return callEndpoint(
    getApprovalRequest,
    { params: { requestId } },
    { signal },
  );
}

/**
 * One Idempotency-Key per decision attempt (contracts.md "Idempotent
 * mutations"): a retry after a lost response replays the first result instead
 * of failing with "already decided".
 */
export function decideApproval(
  requestId: string,
  body: ApprovalDecisionInput,
  idempotencyKey: string,
) {
  return callEndpoint(
    decideApprovalRequest,
    { params: { requestId }, body },
    { headers: { "Idempotency-Key": idempotencyKey } },
  );
}

/** The requester withdraws their own pending request (POST .../cancel). */
export function cancelApproval(requestId: string, idempotencyKey: string) {
  return callEndpoint(
    cancelApprovalRequest,
    { params: { requestId } },
    { headers: { "Idempotency-Key": idempotencyKey } },
  );
}

export function verifyFactor(input: { factorId: string; code: string }) {
  return callEndpoint(verifyMfaFactor, { body: input });
}
