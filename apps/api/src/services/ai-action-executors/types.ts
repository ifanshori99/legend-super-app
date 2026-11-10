// Shared executor contract for approved AI/MCP action requests (WS-12 part W,
// bead legend-zw9r). An executor runs only after the approval chain ended
// `approved`, as the REQUESTER (their own access, re-read at execution time),
// and only through the owning module's service.
import type { ScopedTenantContext } from "@starter/shared/core";
import type { actionRequests } from "../../db/schema/ai.ts";
import type { AccessSnapshot, Tx } from "../permission-resolver.ts";

export type ActionRequestRow = typeof actionRequests.$inferSelect;

export type ExecutorArgs = {
  /** Open settle transaction (worker tenant context). Only in-transaction module calls may use it. */
  readonly tx: Tx;
  /** Worker tenant-wide context; never used to widen the requester's rights. */
  readonly context: ScopedTenantContext;
  /** The requester's access, re-read inside `tx` at execution time. */
  readonly access: AccessSnapshot;
  readonly row: ActionRequestRow;
  readonly now: Date;
};

/** `resultRef` points at the record the action produced (max 200 chars). */
export type ExecutorResult = { readonly resultRef: string };
export type ActionExecutor = (args: ExecutorArgs) => Promise<ExecutorResult>;

/** A failure whose message is safe to store and show (no payload, no PII). */
export class ActionExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionExecutionError";
  }
}
