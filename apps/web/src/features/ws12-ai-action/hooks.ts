// Hooks are the only way components touch AI action request data.
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/errors";
import { actionRequestByApprovalQuery, actionRequestQuery } from "./queries.ts";

const browser = () => typeof window !== "undefined";

/** True when the API answered 404 (ACTION_REQUEST_NOT_FOUND or any missing row). */
export const isMissing = (error: unknown) =>
  error instanceof ApiError && error.status === 404;

/** The review of one action request: the request first, then its approval view. */
export function useActionRequestReview(actionRequestId: string) {
  const request = useQuery({
    ...actionRequestQuery(actionRequestId),
    enabled: browser(),
  });
  const approvalRequestId = request.data?.data.approvalRequestId;
  const review = useQuery({
    ...actionRequestByApprovalQuery(approvalRequestId ?? ""),
    enabled: browser() && approvalRequestId !== undefined,
  });
  return { request, review };
}

/**
 * The AI action behind one approval request, for the approval inbox detail.
 * Most approvals have none (404): then `data` stays undefined and the inbox
 * renders nothing extra.
 */
export function useAiActionForApproval(approvalRequestId: string) {
  return useQuery({
    ...actionRequestByApprovalQuery(approvalRequestId),
    enabled: browser(),
  });
}
