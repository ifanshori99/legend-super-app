// Ids owned by the access contract (PRD v1.7 §6 B: roles, role_assignments,
// approval_policies). Stations belong to the menu/KDS domain (§6 C `stations`);
// the branded type is declared here too because a role assignment can be
// scoped to one station. Same brand name, so both declarations are one type.

import { uuidIdSchema } from "../core/index.ts";
import type { z } from "zod";

export const roleIdSchema = uuidIdSchema<"RoleId">();
export const roleAssignmentIdSchema = uuidIdSchema<"RoleAssignmentId">();
export const approvalPolicyIdSchema = uuidIdSchema<"ApprovalPolicyId">();
export const stationIdSchema = uuidIdSchema<"StationId">();

export type RoleId = z.infer<typeof roleIdSchema>;
export type RoleAssignmentId = z.infer<typeof roleAssignmentIdSchema>;
export type ApprovalPolicyId = z.infer<typeof approvalPolicyIdSchema>;
export type StationId = z.infer<typeof stationIdSchema>;
