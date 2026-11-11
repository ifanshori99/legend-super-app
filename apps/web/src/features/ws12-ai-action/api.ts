// One typed caller per action-request endpoint. Components use the hooks in
// ./hooks.ts; the mock in ./mock.ts serves the same contracts when
// VITE_API_MOCK=true.
import {
  getActionRequest as getActionRequestEndpoint,
  getActionRequestByApproval as getActionRequestByApprovalEndpoint,
} from "@starter/shared/ai";
import { callEndpoint } from "@/lib/api/endpoint";

export const fetchActionRequest = (
  actionRequestId: string,
  signal?: AbortSignal,
) =>
  callEndpoint(
    getActionRequestEndpoint,
    { params: { actionRequestId } },
    { signal },
  );

export const fetchActionRequestByApproval = (
  approvalRequestId: string,
  signal?: AbortSignal,
) =>
  callEndpoint(
    getActionRequestByApprovalEndpoint,
    { params: { approvalRequestId } },
    { signal },
  );
