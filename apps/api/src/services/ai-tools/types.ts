// Shared handler contract for WS-12 AI tools TL-01..TL-20 (beads legend-mfyo,
// legend-ktqc, legend-zw9r). See docs/briefs/sub-ws12-ai.md §Interfaces.
import type { AiToolCode } from "@starter/shared/ai";
import type { AccessSnapshot } from "../permission-resolver.ts";

export type AiChannel = "tanya_ai" | "mcp";

export type AiToolContext = {
  /** Caller's effective access (tenant + userId inside). Never widened. */
  readonly access: AccessSnapshot;
  readonly channel: AiChannel;
  /** Set only for channel "mcp". */
  readonly mcpClientId: string | null;
  /** The MCP token behind the call; set only for channel "mcp" (audit). */
  readonly mcpTokenId?: string | null;
  readonly now: Date;
};

/**
 * One tool implementation. `input` is already parsed by the catalog input
 * schema; the return value must satisfy the catalog output schema (the invoke
 * layer re-parses it). The handler itself must:
 * - mint the RLS context with `ctx.access.contextFor(permission, target)` and
 *   run every query through `withTenant` (throw `AiError("AI_TOOL_FORBIDDEN")`
 *   when it returns null): tenant/outlet RLS + user permission (tingkat K);
 * - enforce self-only rules (payslip, profit share, own schedule) by
 *   `ctx.access.userId`, never by an id from the input;
 * - call existing module services / metric queries only, never raw cross-
 *   tenant SQL, and cap rows at the tool's `maxRows`.
 */
export type AiToolHandler = (
  ctx: AiToolContext,
  input: unknown,
) => Promise<unknown>;

export type AiToolHandlerMap = Partial<Record<AiToolCode, AiToolHandler>>;
