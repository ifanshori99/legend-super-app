// Ids owned by the identity contract (PRD v1.7 §6 B: users,
// user_identities, login_challenges, sessions, mfa_factors, staff_pins,
// approval_requests). Every one is a UUID per docs/plan/contracts.md D-CORE-1,
// branded so mixing them is a type error.

import { uuidIdSchema } from "../core/index.ts";
import type { z } from "zod";

export const userIdentityIdSchema = uuidIdSchema<"UserIdentityId">();
export const loginChallengeIdSchema = uuidIdSchema<"LoginChallengeId">();
export const mfaFactorIdSchema = uuidIdSchema<"MfaFactorId">();
export const staffPinIdSchema = uuidIdSchema<"StaffPinId">();
export const sessionIdSchema = uuidIdSchema<"SessionId">();
export const approvalRequestIdSchema = uuidIdSchema<"ApprovalRequestId">();

export type UserIdentityId = z.infer<typeof userIdentityIdSchema>;
export type LoginChallengeId = z.infer<typeof loginChallengeIdSchema>;
export type MfaFactorId = z.infer<typeof mfaFactorIdSchema>;
export type StaffPinId = z.infer<typeof staffPinIdSchema>;
export type SessionId = z.infer<typeof sessionIdSchema>;
export type ApprovalRequestId = z.infer<typeof approvalRequestIdSchema>;
