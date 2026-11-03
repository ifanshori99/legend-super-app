// Typed endpoint callers for the device PIN and approval flows. Components
// use the hooks in ./hooks.ts.
import {
  createApprovalRequest,
  getApprovalRequest,
  verifyStaffPin,
  type CreateApprovalRequestInput,
} from "@starter/shared/identity";
import { callEndpoint } from "@/lib/api/endpoint";

export const verifyStaffPinCall = (pin: string) =>
  callEndpoint(verifyStaffPin, { body: { pin } });

export const createApprovalRequestCall = (body: CreateApprovalRequestInput) =>
  callEndpoint(createApprovalRequest, { body });

export const getApprovalRequestCall = (
  requestId: string,
  signal?: AbortSignal,
) => callEndpoint(getApprovalRequest, { params: { requestId } }, { signal });
