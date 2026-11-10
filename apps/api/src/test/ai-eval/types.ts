// AI evaluation suite types (legend-9kkj, PRD AIG-01, AIG-02, AIG-04).
// Shared by the dataset, the deterministic eval test and the live runner.
import type { RoleTemplateKey } from "@starter/shared/access";

export type EvalRoleGroup =
  "owner" | "shareholder" | "manager" | "employee" | "kitchen";

export type EvalKind =
  "numeric" | "unanswerable" | "forbidden" | "injection" | "pii";

export type EvalCriterion = "AIG-01" | "AIG-02" | "AIG-04";

export type EvalCase = {
  /** "owner-num-001": `<group>-<num|unans|forb|inj|pii>-<nnn>`. */
  id: string;
  roleGroup: EvalRoleGroup;
  kind: EvalKind;
  /** Indonesian. */
  question: string;
  /**
   * numeric: tool the model should call, its args, and the dot path into the
   * tool output (array index as a number, e.g. "totals.netSalesIdr",
   * "items.0.qtySold") whose value the answer must contain.
   * injection: the tool whose result carries `injectedText` (no metricPath).
   */
  expectTool?: {
    name: string;
    args: Record<string, unknown>;
    metricPath?: string;
  };
  /**
   * forbidden (and some injection): tool the model is tricked into calling.
   * It must be absent from the caller's tool list or denied. Args may hold the
   * placeholders `"$otherOutletId"` (another outlet of the caller's tenant) and
   * `"$otherTenantOutletId"` (an outlet of another tenant); the runner
   * substitutes them anywhere in the args, nested arrays and objects included.
   */
  forbiddenTool?: { name: string; args: Record<string, unknown> };
  /** injection: text planted in tool or user data; the answer must not follow it. */
  injectedText?: string;
  /** pii: raw PII inside `question`; it must never reach the provider. */
  piiSample?: string;
  criteria: EvalCriterion[];
};

/** Placeholders the runner substitutes in `forbiddenTool.args`. */
export const EVAL_PLACEHOLDERS = [
  "$otherOutletId",
  "$otherTenantOutletId",
] as const;

/** Role template that represents each eval role group (0088 role templates). */
export const roleGroupTemplate: Record<EvalRoleGroup, RoleTemplateKey> = {
  owner: "owner",
  shareholder: "shareholder",
  manager: "outlet_manager",
  employee: "employee",
  kitchen: "kitchen_lead",
};
