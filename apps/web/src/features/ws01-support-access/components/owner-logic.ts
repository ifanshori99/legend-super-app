// Pure rules for the owner's read_write request screen (legend-8r77t).
// No framework or alias imports so the root node:test suite loads it with
// plain Node ESM. The API decides again on every call.
import type {
  SupportAccessGrant,
  SupportAccessRequest,
} from "@starter/shared/platform";

export type RequestDisplayStatus =
  "pending" | "approved" | "rejected" | "expired";

/** The list hook returns a cursor page (`{ data }`) or a bare array. */
export function requestsFromResult(
  result: unknown,
): readonly SupportAccessRequest[] {
  if (Array.isArray(result)) return result as SupportAccessRequest[];
  const rows = (result as { data?: unknown } | null | undefined)?.data;
  return Array.isArray(rows) ? (rows as SupportAccessRequest[]) : [];
}

/** A pending request past its 24 hour window is shown as expired. */
export function displayRequestStatus(
  request: Pick<SupportAccessRequest, "status" | "approvalExpiresAt">,
  nowMs: number,
): RequestDisplayStatus {
  if (request.status !== "pending") return request.status;
  return nowMs < Date.parse(request.approvalExpiresAt) ? "pending" : "expired";
}

export type ActiveEntry = {
  request: SupportAccessRequest;
  grant: SupportAccessGrant;
};

export type RequestSections = {
  pending: SupportAccessRequest[];
  active: ActiveEntry[];
  history: { request: SupportAccessRequest; status: RequestDisplayStatus }[];
};

const newestFirst = (a: SupportAccessRequest, b: SupportAccessRequest) =>
  Date.parse(b.requestedAt) - Date.parse(a.requestedAt);

/** A grant is running until it ends or its time is up. */
export function isGrantRunning(
  grant: Pick<SupportAccessGrant, "expiresAt" | "endedAt">,
  nowMs: number,
): boolean {
  return grant.endedAt === null && nowMs < Date.parse(grant.expiresAt);
}

export function sectionRequests(
  requests: readonly SupportAccessRequest[],
  grants: readonly SupportAccessGrant[],
  nowMs: number,
): RequestSections {
  const sections: RequestSections = { pending: [], active: [], history: [] };
  for (const request of [...requests].sort(newestFirst)) {
    const status = displayRequestStatus(request, nowMs);
    if (status === "pending") {
      sections.pending.push(request);
      continue;
    }
    if (status === "approved") {
      const grant = grants.find((row) => row.id === request.grantId);
      if (grant && isGrantRunning(grant, nowMs)) {
        sections.active.push({ request, grant });
        continue;
      }
    }
    sections.history.push({ request, status });
  }
  return sections;
}

export type DecisionBlock =
  "offline" | "impersonating" | "mfa_required" | "not_owner";

/** Why the decision buttons are off, or null. Role rules win over offline. */
export function decisionBlock(
  guard: { canDecide: boolean; reason: string | null },
  online: boolean,
): DecisionBlock | null {
  if (!guard.canDecide) {
    return guard.reason === "impersonating" ||
      guard.reason === "mfa_required" ||
      guard.reason === "not_owner"
      ? guard.reason
      : "not_owner";
  }
  return online ? null : "offline";
}

export type DecisionErrorKind =
  | "offline"
  | "impersonating"
  | "mfa"
  | "forbidden"
  | "conflict"
  | "revokeUnavailable"
  | "generic";

/** Maps a failed decision to a catalog suffix (duck-typed ApiError). */
export function decisionErrorKind(error: unknown): DecisionErrorKind {
  const { status, code } = (error ?? {}) as { status?: number; code?: string };
  switch (code) {
    case "IMPERSONATION_NOT_ALLOWED":
      return "impersonating";
    case "MFA_REQUIRED":
    case "MFA_INVALID":
    case "REAUTH_REQUIRED":
      return "mfa";
    case "NETWORK_ERROR":
      return "offline";
    case "FORBIDDEN":
      return "forbidden";
    default:
      if (status === 403) return "forbidden";
      if (status === 409) return "conflict";
      return "generic";
  }
}

/**
 * Revoke reuses the platform "end grant" call, which the Owner may not be
 * allowed to make: a refusal or a missing route gets its own clear message.
 */
export function revokeErrorKind(error: unknown): DecisionErrorKind {
  const { status, code } = (error ?? {}) as { status?: number; code?: string };
  if (code === "NETWORK_ERROR") return "offline";
  if (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 405 ||
    code === "FORBIDDEN" ||
    code === "NOT_FOUND"
  )
    return "revokeUnavailable";
  return decisionErrorKind(error);
}

/** Short stand-in for the requester (the contract carries an id, no name). */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
