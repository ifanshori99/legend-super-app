// Query keys and options for the AI action request screens.
import { queryOptions } from "@tanstack/react-query";
import { fetchActionRequest, fetchActionRequestByApproval } from "./api.ts";

export const aiActionKeys = {
  all: ["ai-action"] as const,
  detail: (actionRequestId: string) =>
    [...aiActionKeys.all, "detail", actionRequestId] as const,
  byApproval: (approvalRequestId: string) =>
    [...aiActionKeys.all, "by-approval", approvalRequestId] as const,
};

// A missing request is an answer, not a failure to retry; other errors get one
// quick retry and then the screen's own "Coba lagi".
const retryUnlessMissing = (count: number, error: unknown) =>
  !(
    typeof error === "object" &&
    error !== null &&
    (error as { status?: number }).status === 404
  ) && count < 1;

export const actionRequestQuery = (actionRequestId: string) =>
  queryOptions({
    queryKey: aiActionKeys.detail(actionRequestId),
    queryFn: ({ signal }) => fetchActionRequest(actionRequestId, signal),
    retry: retryUnlessMissing,
    retryDelay: 600,
  });

export const actionRequestByApprovalQuery = (approvalRequestId: string) =>
  queryOptions({
    queryKey: aiActionKeys.byApproval(approvalRequestId),
    queryFn: ({ signal }) =>
      fetchActionRequestByApproval(approvalRequestId, signal),
    retry: retryUnlessMissing,
    retryDelay: 600,
  });
