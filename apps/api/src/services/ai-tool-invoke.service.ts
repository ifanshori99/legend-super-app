// Tool invoke layer: the one enforcement point of AIG-01 for Tanya AI and MCP
// (PRD v1.7 §3 Fitur 38/39/40, MCP-01..03; bead legend-zfi4 part I).
//
// Order per call: resolve tool -> kill switch -> MCP scope -> caller holds the
// tool permissions -> parse input -> handler -> parse output with the catalog
// schema -> row cap -> audit row (redacted params) + `ai_tool.invoked` event.
//
// - Tool-level denials never throw: they return `ok: false` so the model loop
//   can tell the model. Only infrastructure errors (audit insert, settings
//   read) throw. A handler crash is reported as `TOOL_ERROR` without detail.
// - The handler gets the caller's own `AccessSnapshot` and mints its RLS
//   context itself (see `ai-tools/types.ts`). This layer never widens it.
// - The audit row and the outbox event use a tenant-wide context minted from
//   the caller's trusted tenant. RLS on `ai_tool_calls` is tenant-only, and
//   the audit must be written whatever the caller's outlet reach is.
// - Settings (kill switch, row cap) are read straight from `ai_settings`;
//   no row means defaults (nothing disabled, 200 rows).
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  AI_TOOL_CATALOG,
  AiError,
  aiEvents,
  getAiTool,
  type AiToolCallOutcome,
  type AiToolCode,
  type AiToolDefinition,
} from "@starter/shared/ai";
import { createUlid } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { aiSettings, aiToolCalls } from "../db/schema/ai.ts";
import { withTenant } from "../db/tenant.ts";
import { redactJson } from "../lib/ai/pii.ts";
import { logger } from "../lib/logger.ts";
import { appendOutbox } from "./core-outbox.ts";
import type { AccessSnapshot } from "./permission-resolver.ts";
import { getAiToolHandler } from "./ai-tools/handlers.ts";
import { callerToolMatches } from "./ai-metrics/scope.ts";
import type { AiToolContext } from "./ai-tools/types.ts";
import type { AiToolSpec } from "../lib/ai/types.ts";

const EVENT_DESTINATION = "cloud-sync";
const DEFAULT_MAX_ROWS = 200;
const PARAM_VALUE_MAX = 200;
const PARAM_KEY_MAX = 60;

type ToolSettings = {
  readonly disabled: ReadonlySet<string>;
  readonly maxRows: number;
};

export type InvokeAiToolOptions = {
  /** MCP token scopes. Omit for the app channel (no scope check). */
  readonly scopes?: readonly string[];
  readonly conversationId?: string | null;
};

export type InvokeAiToolResult =
  | {
      ok: true;
      toolCode: AiToolCode;
      output: unknown;
      rowCount: number;
      toolCallId: string;
    }
  | {
      ok: false;
      toolCode: AiToolCode | null;
      errorCode: string;
      message: string;
      toolCallId: string;
    };

/** Tenant-wide context for infra reads/writes (settings, audit, outbox). */
function infraContext(access: AccessSnapshot) {
  return establishScopedTenantContext(access.tenant, { kind: "tenant" });
}

async function loadToolSettings(access: AccessSnapshot): Promise<ToolSettings> {
  const [row] = await withTenant(db, infraContext(access), (tx) =>
    tx
      .select({
        disabled: aiSettings.disabledToolCodes,
        maxRows: aiSettings.maxRowsPerResponse,
      })
      .from(aiSettings)
      .where(eq(aiSettings.tenantId, access.tenant.tenantId))
      .limit(1),
  );
  return {
    disabled: new Set(row?.disabled ?? []),
    maxRows: row?.maxRows ?? DEFAULT_MAX_ROWS,
  };
}

/**
 * Tools that read HRIS or finance data (labor, financial statements, schedules,
 * payslips, profit share). TL-10 (SOP search) is not gated: procedures are
 * neither personal nor financial data. A caller whose role requires MFA (AUTH-05)
 * may only run them with a verified second factor.
 */
const MFA_GATED_TOOLS: ReadonlySet<AiToolCode> = new Set<AiToolCode>([
  "TL-05",
  "TL-06",
  "TL-08",
  "TL-09",
  "TL-12",
]);

function mfaBlocks(access: AccessSnapshot, tool: AiToolDefinition): boolean {
  return (
    MFA_GATED_TOOLS.has(tool.code) && access.mfaRequired && !access.mfaVerified
  );
}

/**
 * The caller may use the tool when one of their role templates listed in the
 * catalog `minRoles` holds that role's permissions (override included)
 * through its own assignments. Same rule as the handlers (`toolMatches`), so
 * a listed tool is never forbidden by its handler for role reasons. Outlet
 * reach and self-only rules stay with the handler (`contextFor`).
 */
function callerHoldsToolPermissions(
  access: AccessSnapshot,
  tool: AiToolDefinition,
): boolean {
  return callerToolMatches(access, tool).length > 0;
}

/**
 * Catalog minus tools that are switched off, minus tools without a registered
 * handler, minus HRIS/finance tools blocked by an unverified second factor,
 * minus tools the caller lacks the permission for, minus (MCP) tools whose
 * scope the token does not carry.
 */
export async function listCallableTools(
  ctx: AiToolContext,
  opts: { scopes?: readonly string[] } = {},
): Promise<AiToolDefinition[]> {
  const settings = await loadToolSettings(ctx.access);
  return AI_TOOL_CATALOG.filter(
    (tool) =>
      !settings.disabled.has(tool.code) &&
      (!opts.scopes || opts.scopes.includes(tool.scope)) &&
      getAiToolHandler(tool.code) !== undefined &&
      !mfaBlocks(ctx.access, tool) &&
      callerHoldsToolPermissions(ctx.access, tool),
  );
}

/** Catalog tools as provider tool specs (zod 4 JSON Schema). */
export function toToolSpecs(tools: readonly AiToolDefinition[]): AiToolSpec[] {
  return tools.map((tool) => {
    const inputSchema = {
      ...(z.toJSONSchema(tool.input as z.ZodType, {
        unrepresentable: "any",
      }) as Record<string, unknown>),
    };
    delete inputSchema.$schema;
    return {
      name: tool.name,
      description: tool.description,
      inputSchema,
    };
  });
}

/** Scalar-only, PII-redacted, size-bounded copy of the raw input for audit. */
function auditParams(rawInput: unknown): Record<string, unknown> {
  const redacted = redactJson(rawInput);
  if (!redacted || typeof redacted !== "object" || Array.isArray(redacted))
    return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(redacted)) {
    const name = key.slice(0, PARAM_KEY_MAX);
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      out[name] = value;
    else if (typeof value === "string")
      out[name] = value.slice(0, PARAM_VALUE_MAX);
    else out[name] = JSON.stringify(value).slice(0, PARAM_VALUE_MAX);
  }
  return out;
}

/** Cap row arrays (never `sources`) and count them. A scalar output is 1 row. */
function capRows(
  output: unknown,
  cap: number,
): { output: unknown; rowCount: number } {
  if (!output || typeof output !== "object" || Array.isArray(output))
    return { output, rowCount: 1 };
  const next: Record<string, unknown> = { ...output };
  let rows = 0;
  let arrays = 0;
  let trimmed = false;
  for (const [key, value] of Object.entries(next)) {
    if (key === "sources" || !Array.isArray(value)) continue;
    arrays += 1;
    if (value.length > cap) {
      next[key] = value.slice(0, cap);
      trimmed = true;
    }
    rows += (next[key] as unknown[]).length;
  }
  if (trimmed && "truncated" in next) next.truncated = true;
  return { output: next, rowCount: arrays === 0 ? 1 : rows };
}

type Failure = { code: string; message: string; outcome: AiToolCallOutcome };

function outcomeOfError(code: string): AiToolCallOutcome {
  if (code === "AI_TOOL_FORBIDDEN" || code === "MCP_SCOPE_INSUFFICIENT")
    return "denied";
  if (code === "AI_TOOL_DISABLED") return "disabled";
  return "error";
}

async function recordCall(
  ctx: AiToolContext,
  record: {
    id: string;
    tool: AiToolDefinition;
    outcome: AiToolCallOutcome;
    rawInput: unknown;
    outletId: string | null;
    rowCount: number;
    durationMs: number;
    errorCode: string | null;
    conversationId: string | null;
  },
): Promise<void> {
  const { access } = ctx;
  const context = infraContext(access);
  const now = ctx.now;
  const channel = ctx.channel === "mcp" ? "mcp" : "app";
  await withTenant(db, context, async (tx) => {
    await tx.insert(aiToolCalls).values({
      id: record.id,
      tenantId: access.tenant.tenantId,
      outletId: record.outletId as never,
      toolCode: record.tool.code,
      channel,
      userId: access.userId as never,
      mcpClientId: channel === "mcp" ? ctx.mcpClientId : null,
      mcpTokenId: channel === "mcp" ? (ctx.mcpTokenId ?? null) : null,
      conversationId: record.conversationId,
      params: auditParams(record.rawInput),
      // The table allows ok/denied/error; the event keeps the finer outcome.
      status:
        record.outcome === "ok"
          ? "ok"
          : record.outcome === "error" || record.outcome === "rate_limited"
            ? "error"
            : "denied",
      rowCount: record.rowCount,
      durationMs: record.durationMs,
      errorCode: record.errorCode,
    });
    const definition = aiEvents["ai_tool.invoked"];
    const event = definition.envelopeSchema.parse({
      id: createUlid(now.getTime()),
      tenantId: access.tenant.tenantId,
      outletId: null,
      name: definition.name,
      version: definition.version,
      aggregateType: definition.entry.aggregateType,
      aggregateId: record.id,
      sequence: 1,
      occurredAt: now.toISOString(),
      actor: { type: "user", id: access.userId },
      deviceId: null,
      idempotencyKey: `${definition.name}:${record.id}:1`,
      payloadSchemaRef: definition.payloadSchemaRef,
      payload: {
        toolCallId: record.id,
        toolCode: record.tool.code,
        channel,
        userId: access.userId,
        outcome: record.outcome,
        rowCount: record.rowCount,
        durationMs: record.durationMs,
        occurredAt: now.toISOString(),
      },
    });
    await appendOutbox(tx, context, {
      id: createUlid(now.getTime()),
      event,
      destination: EVENT_DESTINATION,
      direction: null,
      peerId: null,
    });
  });
}

function singleOutletOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const id = (input as { outletId?: unknown }).outletId;
  return typeof id === "string" ? id : null;
}

/**
 * Run one tool for the caller. Never throws for tool-level denials or handler
 * failures; throws only when settings or the audit row cannot be written.
 */
export async function invokeAiTool(
  ctx: AiToolContext,
  toolName: string,
  rawInput: unknown,
  opts: InvokeAiToolOptions = {},
): Promise<InvokeAiToolResult> {
  const startedAt = Date.now();
  const toolCallId = createUlid(startedAt);
  const tool = getAiTool(toolName);
  if (!tool) {
    // No catalog code, so no audit row (ai_tool_calls.tool_code is TL-xx).
    return {
      ok: false,
      toolCode: null,
      errorCode: "AI_TOOL_NOT_FOUND",
      message: "Alat AI tidak dikenal.",
      toolCallId,
    };
  }

  let result:
    | { ok: true; output: unknown; rowCount: number }
    | { ok: false; failure: Failure };
  let parsedInput: unknown = rawInput;

  const deny = (code: string, message: string) =>
    ({
      ok: false,
      failure: { code, message, outcome: outcomeOfError(code) },
    }) as const;

  const settings = await loadToolSettings(ctx.access);
  if (settings.disabled.has(tool.code)) {
    result = deny("AI_TOOL_DISABLED", new AiError("AI_TOOL_DISABLED").message);
  } else if (opts.scopes && !opts.scopes.includes(tool.scope)) {
    result = deny(
      "MCP_SCOPE_INSUFFICIENT",
      new AiError("MCP_SCOPE_INSUFFICIENT").message,
    );
  } else if (
    !callerHoldsToolPermissions(ctx.access, tool) ||
    mfaBlocks(ctx.access, tool)
  ) {
    result = deny(
      "AI_TOOL_FORBIDDEN",
      new AiError("AI_TOOL_FORBIDDEN").message,
    );
  } else {
    const parsed = (tool.input as z.ZodType).safeParse(rawInput ?? {});
    const handler = getAiToolHandler(tool.code);
    if (!parsed.success) {
      result = deny(
        "INVALID_INPUT",
        `Input tidak valid: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".") || "input"} ${issue.message}`)
          .join("; ")}`,
      );
    } else if (!handler) {
      result = deny(
        "AI_TOOL_DISABLED",
        new AiError("AI_TOOL_DISABLED").message,
      );
    } else {
      parsedInput = parsed.data;
      try {
        const raw = await handler(ctx, parsed.data);
        const checked = (tool.output as z.ZodType).safeParse(raw);
        if (!checked.success) {
          // Never hand an unvalidated payload to the model or MCP client.
          logger.error(
            { toolCode: tool.code, issues: checked.error.issues.length },
            "AI tool output violated its schema",
          );
          result = deny("TOOL_OUTPUT_INVALID", "Hasil alat tidak valid.");
        } else {
          const cap =
            tool.maxRows === 0
              ? Number.POSITIVE_INFINITY
              : Math.min(tool.maxRows, settings.maxRows);
          const capped = capRows(checked.data, cap);
          result = {
            ok: true,
            output: capped.output,
            rowCount: tool.maxRows === 0 ? 0 : capped.rowCount,
          };
        }
      } catch (error) {
        if (error instanceof AiError) {
          result = deny(error.code, error.message);
        } else {
          logger.error({ toolCode: tool.code }, "AI tool handler failed");
          result = deny("TOOL_ERROR", "Alat AI gagal dijalankan.");
        }
      }
    }
  }

  const outcome = result.ok ? "ok" : result.failure.outcome;
  await recordCall(ctx, {
    id: toolCallId,
    tool,
    outcome,
    rawInput: parsedInput,
    outletId: result.ok ? singleOutletOf(parsedInput) : null,
    rowCount: result.ok ? result.rowCount : 0,
    durationMs: Date.now() - startedAt,
    errorCode: result.ok ? null : result.failure.code,
    conversationId: opts.conversationId ?? null,
  });

  if (result.ok)
    return {
      ok: true,
      toolCode: tool.code,
      output: result.output,
      rowCount: result.rowCount,
      toolCallId,
    };
  return {
    ok: false,
    toolCode: tool.code,
    errorCode: result.failure.code,
    message: result.failure.message,
    toolCallId,
  };
}
