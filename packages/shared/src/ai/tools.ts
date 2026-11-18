// Tool catalog TL-01..TL-21 (bead legend-1zxo, WS-12).
// PRD v1.7 §3 Fitur 38 (Tanya AI), 39 (MCP Server: tool table, MCP-01), 40
// (Tata Kelola). One catalog serves Tanya AI and MCP (D32): the same tools,
// annotated read or write. Write tools never change data: they only create an
// action request linked to an approval request (AIG-03).
//
// `requiredPermissions` is ALL-of and lists what every permitted caller of the
// tool holds. `ai.ask` (the channel gate) is checked by the API for every
// tool; it is listed only where it is the tool's sole requirement (TL-08),
// because that tool needs no data permission. `minRoles` is the PRD "Role Minimum" column mapped literally; access
// says how far the rows reach (own, the caller's outlets, whole tenant, or
// closed-period aggregates only). The server still intersects every outlet
// filter with the caller's real scope (AIG-01).
//
// A `minRoles` entry may carry `permissions`: they replace the tool's
// `requiredPermissions` for that role only. TL-06 uses it for the shareholder,
// who holds `report.aggregate.view` (closed-period aggregates), never
// `report.financial.view`. Use `requiredPermissionsFor` and
// `roleHoldsToolPermissions` instead of reading `requiredPermissions` directly.
// Every `minRoles` role template holds the permissions its tool needs (bead
// legend-9v9t, checked in tests/ai-contract.test.mjs). The server checks both
// the role and the permissions, so a tool is callable only when both pass.

import { z } from "../core/index.ts";
import type { OutletId, TenantId, UserId } from "../core/index.ts";
import { permissionCodeSchema } from "../access/permissions.ts";
import type { PermissionCode } from "../access/permissions.ts";
import { ROLE_TEMPLATE_KEYS } from "../access/roles.ts";
import type { RoleTemplateKey } from "../access/roles.ts";
import { roleTemplateKeySchema } from "../access/schemas.ts";
import type { ApprovalRequestId } from "../identity/ids.ts";
import {
  ACTION_REQUEST_TOOL_CODES,
  AI_FEATURE_CODES,
  AI_TOOLS,
  MCP_SCOPES,
  aiFeatureCodeSchema,
  aiToolCodeSchema,
  aiToolKindSchema,
  aiToolNameSchema,
  mcpScopeSchema,
} from "./ids.ts";
import type {
  AiFeatureCode,
  AiToolCode,
  AiToolKind,
  AiToolName,
  ActionRequestSource,
  McpClientId,
  McpScope,
} from "./ids.ts";
import { createActionRequestSchema } from "./schemas.ts";
import type {
  ActionRequestApprovalActionType,
  CreateActionRequest,
} from "./schemas.ts";
import { AI_TOOL_IO, TOOL_MAX_ROWS } from "./tool-io.ts";

// ---- Definition ------------------------------------------------------------

/** How far a role's rows reach through this tool. */
export const AI_TOOL_ACCESS_LEVELS = [
  "own",
  "assigned_outlets",
  "tenant",
  "closed_period_aggregate",
] as const;
export type AiToolAccessLevel = (typeof AI_TOOL_ACCESS_LEVELS)[number];
export const aiToolAccessLevelSchema = z.enum(AI_TOOL_ACCESS_LEVELS);

export const aiToolMinRoleSchema = z.strictObject({
  role: roleTemplateKeySchema,
  access: aiToolAccessLevelSchema,
  /** Replaces the tool `requiredPermissions` for this role only. */
  permissions: z.array(permissionCodeSchema).min(1).max(10).optional(),
});
export type AiToolMinRole = z.infer<typeof aiToolMinRoleSchema>;

/** MCP tool annotations (§3 Fitur 39 "diberi anotasi baca atau tulis"). */
export const aiToolMcpAnnotationsSchema = z.strictObject({
  readOnlyHint: z.boolean(),
  /** A tool never destroys data: drafts only add a pending request. */
  destructiveHint: z.literal(false),
  idempotentHint: z.boolean(),
  /** Tools only touch the tenant's own data, never the open world. */
  openWorldHint: z.literal(false),
});
export type AiToolMcpAnnotations = z.infer<typeof aiToolMcpAnnotationsSchema>;

const zodSchemaValue = z.custom<z.ZodType>(
  (value) => value instanceof z.ZodType,
);

export const aiToolDefinitionSchema = z.strictObject({
  code: aiToolCodeSchema,
  name: aiToolNameSchema,
  kind: aiToolKindSchema,
  /** Indonesian title for the app. */
  titleId: z.string().trim().min(1).max(120),
  /** English description sent to the model and MCP clients. */
  description: z.string().trim().min(1).max(600),
  /** AI-xx features that call this tool. */
  featureCodes: z
    .array(aiFeatureCodeSchema)
    .min(1)
    .max(AI_FEATURE_CODES.length),
  scope: mcpScopeSchema,
  requiredPermissions: z.array(permissionCodeSchema).min(1).max(10),
  minRoles: z.array(aiToolMinRoleSchema).min(1).max(ROLE_TEMPLATE_KEYS.length),
  /** True for every write tool (AIG-03). The approval action type (ai_action or mcp_action) follows the source at runtime. */
  requiresApproval: z.boolean(),
  mcpAnnotations: aiToolMcpAnnotationsSchema,
  input: zodSchemaValue,
  output: zodSchemaValue,
  /** Row cap of the output; write tools return a receipt, not rows. */
  maxRows: z.number().int().min(0).max(TOOL_MAX_ROWS),
});
export type AiToolDefinition = z.infer<typeof aiToolDefinitionSchema>;

// ---- Catalog data ----------------------------------------------------------

type ToolSeed = {
  code: AiToolCode;
  name: AiToolName;
  titleId: string;
  description: string;
  featureCodes: readonly AiFeatureCode[];
  scope: McpScope;
  requiredPermissions: readonly PermissionCode[];
  minRoles: readonly AiToolMinRole[];
  maxRows?: number;
};

function role(
  roleKey: RoleTemplateKey,
  access: AiToolAccessLevel,
  permissions?: readonly PermissionCode[],
): AiToolMinRole {
  return permissions
    ? { role: roleKey, access, permissions: [...permissions] }
    : { role: roleKey, access };
}

function freezeTool(tool: AiToolDefinition): AiToolDefinition {
  return Object.freeze({
    ...tool,
    featureCodes: Object.freeze([...tool.featureCodes]),
    requiredPermissions: Object.freeze([...tool.requiredPermissions]),
    minRoles: Object.freeze(
      tool.minRoles.map((entry) =>
        Object.freeze({
          ...entry,
          ...(entry.permissions && {
            permissions: Object.freeze([...entry.permissions]),
          }),
        }),
      ),
    ),
    mcpAnnotations: Object.freeze({ ...tool.mcpAnnotations }),
  }) as AiToolDefinition;
}

function defineTool(kind: AiToolKind, seed: ToolSeed): AiToolDefinition {
  const isWrite = kind === "write";
  return freezeTool({
    code: seed.code,
    name: seed.name,
    kind,
    titleId: seed.titleId,
    description: seed.description,
    featureCodes: [...seed.featureCodes],
    scope: seed.scope,
    requiredPermissions: [...seed.requiredPermissions],
    minRoles: [...seed.minRoles],
    requiresApproval: isWrite,
    mcpAnnotations: {
      readOnlyHint: !isWrite,
      destructiveHint: false,
      // A repeated draft makes a second pending request, so it is not idempotent.
      idempotentHint: !isWrite,
      openWorldHint: false,
    },
    input: AI_TOOL_IO[seed.code].input,
    output: AI_TOOL_IO[seed.code].output,
    maxRows: isWrite ? 0 : (seed.maxRows ?? TOOL_MAX_ROWS),
  });
}

const read = (seed: ToolSeed) => defineTool("read", seed);
const write = (seed: ToolSeed) => defineTool("write", seed);

const WRITE_TOOLS: readonly AiToolDefinition[] = [
  write({
    code: "TL-13",
    name: "draft_purchase_order",
    titleId: "Draf Pesanan Pembelian",
    description:
      "Draft a purchase order for one outlet and one supplier. Creates a pending action request for human approval. Never places the order itself.",
    featureCodes: ["AI-05", "AI-08"],
    scope: "mcp:purchasing:draft",
    requiredPermissions: ["purchasing.request.create", "ai.action.propose"],
    minRoles: [role("purchasing", "tenant")],
  }),
  write({
    code: "TL-14",
    name: "draft_stock_adjustment",
    titleId: "Draf Penyesuaian Stok",
    description:
      "Draft a stock quantity adjustment (positive or negative) for one outlet with a reason. Creates a pending action request for human approval. Never changes stock itself.",
    featureCodes: ["AI-05", "AI-08"],
    scope: "mcp:inventory:draft",
    requiredPermissions: ["inventory.stock.view", "ai.action.propose"],
    minRoles: [
      role("warehouse", "assigned_outlets"),
      role("kitchen_lead", "assigned_outlets"),
    ],
  }),
  write({
    code: "TL-15",
    name: "draft_promotion",
    titleId: "Draf Promo",
    description:
      "Draft a promotion (percent or amount discount) for selected outlets and a date range. Creates a pending action request for human approval. Never publishes the promotion itself.",
    featureCodes: ["AI-05", "AI-12"],
    scope: "mcp:promotion:draft",
    requiredPermissions: ["promo.manage", "ai.action.propose"],
    minRoles: [role("marketing", "tenant")],
  }),
  write({
    code: "TL-16",
    name: "draft_shift_schedule",
    titleId: "Draf Jadwal Shift",
    description:
      "Draft a weekly shift schedule for one outlet. Creates a pending action request for human approval. Never publishes the schedule itself.",
    featureCodes: ["AI-05", "AI-13"],
    scope: "mcp:schedule:draft",
    requiredPermissions: ["hr.schedule.manage", "ai.action.propose"],
    minRoles: [
      role("outlet_manager", "assigned_outlets"),
      role("hr", "tenant"),
    ],
  }),
  write({
    code: "TL-17",
    name: "draft_price_change",
    titleId: "Draf Perubahan Harga",
    description:
      "Draft menu price changes with an effective time. Creates a pending action request for human approval. Never changes prices itself.",
    featureCodes: ["AI-02", "AI-05"],
    scope: "mcp:pricing:draft",
    requiredPermissions: ["menu.price.manage", "ai.action.propose"],
    minRoles: [role("general_manager", "tenant"), role("owner", "tenant")],
  }),
  write({
    code: "TL-18",
    name: "draft_menu_availability",
    titleId: "Draf Ketersediaan Menu",
    description:
      "Draft turning menu items on or off for one outlet, optionally until a time, with a reason. Creates a pending action request for human approval. Never changes availability itself.",
    featureCodes: ["AI-05"],
    scope: "mcp:menu:draft",
    requiredPermissions: ["menu.availability.toggle", "ai.action.propose"],
    minRoles: [
      role("kitchen_lead", "assigned_outlets"),
      role("supervisor", "assigned_outlets"),
    ],
  }),
];

/** TL-19 "Pemohon action request": every role that can request any write tool. */
const REQUESTER_ROLES: readonly AiToolMinRole[] = ROLE_TEMPLATE_KEYS.filter(
  (key) =>
    WRITE_TOOLS.some((tool) =>
      tool.minRoles.some((entry) => entry.role === key),
    ),
).map((key) => role(key, "own"));

const writeTool = (code: AiToolCode): AiToolDefinition => {
  const tool = WRITE_TOOLS.find((entry) => entry.code === code);
  if (!tool) throw new RangeError(`Missing write tool ${code}`);
  return tool;
};

const READ_TOOLS = {
  "TL-01": read({
    code: "TL-01",
    name: "get_sales_summary",
    titleId: "Ringkasan Penjualan",
    description:
      "Sales summary for a period, grouped by day, outlet or channel: net and gross sales, transactions, guests and average spend per guest, with sources.",
    featureCodes: ["AI-02", "AI-05", "AI-10"],
    scope: "mcp:sales:read",
    requiredPermissions: ["report.sales.view"],
    minRoles: [
      role("outlet_manager", "assigned_outlets"),
      role("owner", "tenant"),
    ],
  }),
  "TL-02": read({
    code: "TL-02",
    name: "get_menu_performance",
    titleId: "Performa Menu",
    description:
      "Top menu items by quantity, revenue or margin for a period. Margin is null when the caller lacks cost permission.",
    featureCodes: ["AI-02", "AI-05", "AI-12"],
    scope: "mcp:menu:read",
    requiredPermissions: ["report.sales.view"],
    minRoles: [
      role("outlet_manager", "assigned_outlets"),
      // Kitchen lead and marketing hold no report.sales.view (it opens the
      // whole sales report group in the app, beyond the PRD tool table):
      // TL-02 only needs the menu or promo permission they already have.
      role("kitchen_lead", "assigned_outlets", ["menu.item.view"]),
      role("marketing", "tenant", ["promo.manage"]),
    ],
    maxRows: 50,
  }),
  "TL-03": read({
    code: "TL-03",
    name: "get_stock_levels",
    titleId: "Level Stok",
    description:
      "Current stock on hand against par level per inventory item, with status ok, low, critical or out.",
    featureCodes: ["AI-05", "AI-08"],
    scope: "mcp:inventory:read",
    requiredPermissions: ["inventory.stock.view"],
    minRoles: [
      role("warehouse", "assigned_outlets"),
      role("kitchen_lead", "assigned_outlets"),
      role("purchasing", "tenant"),
    ],
  }),
  "TL-04": read({
    code: "TL-04",
    name: "get_food_cost",
    titleId: "Food Cost",
    description:
      "Food cost, net sales and food cost percent for a period, per outlet.",
    featureCodes: ["AI-02", "AI-05"],
    scope: "mcp:food_cost:read",
    requiredPermissions: ["inventory.cost.view"],
    minRoles: [
      // Kitchen lead holds no inventory.cost.view (MFA-sensitive): TL-04 returns
      // aggregate food cost only, no unit costs, so recipe.manage is enough.
      role("kitchen_lead", "assigned_outlets", ["recipe.manage"]),
      role("finance", "tenant"),
      role("owner", "tenant"),
    ],
  }),
  "TL-05": read({
    code: "TL-05",
    name: "get_labor_summary",
    titleId: "Ringkasan Tenaga Kerja",
    description:
      "Aggregate labor cost, labor cost percent, scheduled, worked and overtime hours and headcount. Never returns individual pay.",
    featureCodes: ["AI-02", "AI-05", "AI-13"],
    scope: "mcp:labor:read",
    requiredPermissions: ["dashboard.management.view"],
    minRoles: [
      role("hr", "tenant"),
      role("outlet_manager", "assigned_outlets"),
      role("owner", "tenant"),
    ],
  }),
  "TL-06": read({
    code: "TL-06",
    name: "get_financial_statement",
    titleId: "Laporan Keuangan",
    description:
      "Profit and loss, balance sheet or cash flow lines for a period. Shareholders only see closed periods.",
    featureCodes: ["AI-02", "AI-03", "AI-05"],
    scope: "mcp:finance:read",
    requiredPermissions: ["report.financial.view"],
    minRoles: [
      role("finance", "tenant"),
      role("owner", "tenant"),
      role("shareholder", "closed_period_aggregate", ["report.aggregate.view"]),
    ],
  }),
  "TL-07": read({
    code: "TL-07",
    name: "get_customer_segments",
    titleId: "Segmen Pelanggan",
    description:
      "Aggregate customer segments by tier, recency, frequency or spend. Counts and averages only: no customer identity or contact data.",
    featureCodes: ["AI-02", "AI-05"],
    scope: "mcp:customers:read",
    requiredPermissions: ["crm.customer.view"],
    minRoles: [role("marketing", "tenant"), role("owner", "tenant")],
  }),
  "TL-08": read({
    code: "TL-08",
    name: "get_shift_schedule",
    titleId: "Jadwal Shift",
    description:
      "Shift schedule for a period. Employees see only their own shifts; managers see their outlets.",
    featureCodes: ["AI-04", "AI-05", "AI-13"],
    scope: "mcp:schedule:read",
    requiredPermissions: ["ai.ask"],
    minRoles: [
      role("employee", "own"),
      role("outlet_manager", "assigned_outlets"),
      role("hr", "tenant"),
    ],
  }),
  "TL-09": read({
    code: "TL-09",
    name: "get_my_payslip",
    titleId: "Slip Gaji Saya",
    description:
      "The caller's own payslip for one month. There is no employee input: it always reads the caller's own record.",
    featureCodes: ["AI-04"],
    scope: "mcp:payslip:read",
    requiredPermissions: ["self.payslip.view"],
    minRoles: [role("employee", "own")],
  }),
  "TL-10": read({
    code: "TL-10",
    name: "search_sop",
    titleId: "Cari SOP",
    description:
      "Search internal SOP and policy documents. Returns short snippets with the source version and a link.",
    featureCodes: ["AI-04", "AI-06"],
    scope: "mcp:sop:read",
    requiredPermissions: ["self.sop.read"],
    minRoles: [
      role("owner", "tenant", ["hr.sop.manage"]),
      role("general_manager", "tenant", ["hr.sop.manage"]),
      role("hr", "tenant", ["hr.sop.manage"]),
      role("kitchen_lead", "assigned_outlets", ["hr.sop.manage"]),
      role("employee", "own"),
    ],
    maxRows: 10,
  }),
  "TL-11": read({
    code: "TL-11",
    name: "get_anomalies",
    titleId: "Anomali",
    description:
      "Unusual voids, discounts, refunds, cash variances or ingredient usage in a period, with observed and baseline values.",
    featureCodes: ["AI-02", "AI-09", "AI-10"],
    scope: "mcp:anomalies:read",
    requiredPermissions: ["report.operational.view"],
    minRoles: [
      role("outlet_manager", "assigned_outlets"),
      role("owner", "tenant"),
    ],
  }),
  "TL-12": read({
    code: "TL-12",
    name: "get_my_profit_share",
    titleId: "Bagi Hasil Saya",
    description:
      "The caller's own profit share distributions. Never returns other shareholders' data.",
    featureCodes: ["AI-03"],
    scope: "mcp:profit_share:read",
    requiredPermissions: ["profit_share.own.view"],
    minRoles: [role("shareholder", "own")],
  }),
  "TL-19": read({
    code: "TL-19",
    name: "get_action_request_status",
    titleId: "Status Permintaan Aksi",
    description:
      "Status of an action request the caller made: approval status, decision time, result reference or failure reason.",
    featureCodes: ["AI-02", "AI-05"],
    scope: "mcp:actions:read",
    requiredPermissions: ["ai.action.propose"],
    minRoles: REQUESTER_ROLES,
    maxRows: 1,
  }),
  "TL-20": read({
    code: "TL-20",
    name: "get_facility_utilization",
    titleId: "Pemakaian Fasilitas",
    description:
      "Facility sessions, utilization percent and revenue per facility for a period.",
    featureCodes: ["AI-02", "AI-05"],
    scope: "mcp:facility:read",
    requiredPermissions: ["report.operational.view"],
    minRoles: [
      role("outlet_manager", "assigned_outlets"),
      role("owner", "tenant"),
    ],
  }),
  "TL-21": read({
    code: "TL-21",
    name: "get_review_summary",
    titleId: "Ringkasan Ulasan",
    description:
      "Aggregate customer review summary per outlet for a period: review count, average rating, 1 to 5 star distribution and mention counts for fixed themes. Aggregates only: no review text, customer name, phone or customer id.",
    featureCodes: ["AI-11"],
    scope: "mcp:reviews:read",
    requiredPermissions: ["review.respond"],
    minRoles: [
      role("outlet_manager", "assigned_outlets"),
      role("general_manager", "tenant"),
      role("marketing", "tenant"),
      role("owner", "tenant"),
    ],
  }),
} as const;

// ---- Catalog ---------------------------------------------------------------

function toolFor(code: AiToolCode): AiToolDefinition {
  return code in READ_TOOLS
    ? READ_TOOLS[code as keyof typeof READ_TOOLS]
    : writeTool(code);
}

/** Frozen, 21 entries, PRD order (TL-01..TL-21). */
export const AI_TOOL_CATALOG: readonly AiToolDefinition[] = Object.freeze(
  AI_TOOLS.map(([code]) => toolFor(code)),
);

const toolByCode = new Map<string, AiToolDefinition>(
  AI_TOOL_CATALOG.map((tool) => [tool.code, tool]),
);
const toolByName = new Map<string, AiToolDefinition>(
  AI_TOOL_CATALOG.map((tool) => [tool.name, tool]),
);

/** Look up by code (`TL-01`) or MCP tool name (`get_sales_summary`). */
export function getAiTool(codeOrName: string): AiToolDefinition | undefined {
  return toolByCode.get(codeOrName) ?? toolByName.get(codeOrName);
}

// ---- Invariants (checked at module load) -----------------------------------

function assertCatalog(): void {
  const fail = (message: string): never => {
    throw new Error(`AI tool catalog: ${message}`);
  };
  if (AI_TOOL_CATALOG.length !== AI_TOOLS.length) fail("must have 21 entries");
  const writeCodes = new Set<string>(ACTION_REQUEST_TOOL_CODES);
  const usedScopes = new Set<string>();
  AI_TOOL_CATALOG.forEach((tool, index) => {
    const [code, name] = AI_TOOLS[index];
    if (tool.code !== code || tool.name !== name)
      fail(`${tool.code} is out of PRD order`);
    const parsed = aiToolDefinitionSchema.safeParse(tool);
    if (!parsed.success)
      fail(`${tool.code} is invalid: ${parsed.error.message}`);
    if (!mcpScopeSchema.safeParse(tool.scope).success)
      fail(`${tool.code} scope is not a known MCP scope`);
    usedScopes.add(tool.scope);
    const isWrite = tool.kind === "write";
    if (isWrite !== writeCodes.has(tool.code))
      fail(`${tool.code} kind disagrees with ACTION_REQUEST_TOOL_CODES`);
    if (!tool.scope.endsWith(isWrite ? ":draft" : ":read"))
      fail(`${tool.code} scope suffix does not match kind`);
    if (tool.mcpAnnotations.readOnlyHint === isWrite)
      fail(`${tool.code} readOnlyHint does not match kind`);
    if (tool.requiresApproval !== isWrite)
      fail(`${tool.code} requiresApproval does not match kind`);
    if (isWrite && !tool.requiredPermissions.includes("ai.action.propose"))
      fail(`${tool.code} must require ai.action.propose`);
    if (
      isWrite &&
      tool.minRoles.some(
        (entry) =>
          entry.permissions && !entry.permissions.includes("ai.action.propose"),
      )
    )
      fail(`${tool.code} role override must keep ai.action.propose`);
    if (
      tool.input !== AI_TOOL_IO[tool.code].input ||
      tool.output !== AI_TOOL_IO[tool.code].output
    )
      fail(`${tool.code} input or output differs from AI_TOOL_IO`);
  });
  if (
    new Set(AI_TOOL_CATALOG.map((tool) => tool.name)).size !==
    AI_TOOL_CATALOG.length
  )
    fail("tool names must be unique");
  for (const scope of MCP_SCOPES)
    if (!usedScopes.has(scope)) fail(`scope ${scope} is not used by any tool`);
}
assertCatalog();

// ---- Scope and role helpers ------------------------------------------------

/** Permissions the role needs for the tool: the role override, else the tool `requiredPermissions`. */
export function requiredPermissionsFor(
  tool: AiToolDefinition,
  roleKey: RoleTemplateKey,
): readonly PermissionCode[] {
  const entry = tool.minRoles.find((item) => item.role === roleKey);
  return entry?.permissions ?? tool.requiredPermissions;
}

/** True when `granted` holds every permission the role needs for the tool (ALL-of). */
export function roleHoldsToolPermissions(
  tool: AiToolDefinition,
  roleKey: RoleTemplateKey,
  granted: readonly string[],
): boolean {
  return requiredPermissionsFor(tool, roleKey).every((code) =>
    granted.includes(code),
  );
}

/** Scopes a token may carry for these roles: scopes of every tool the roles may use (MCP-01). */
export function mcpScopesForRoles(
  roles: readonly RoleTemplateKey[],
): McpScope[] {
  const wanted = new Set<McpScope>();
  for (const tool of AI_TOOL_CATALOG)
    if (tool.minRoles.some((entry) => roles.includes(entry.role)))
      wanted.add(tool.scope);
  return MCP_SCOPES.filter((scope) => wanted.has(scope));
}

export type ToolFilterOptions = {
  /** Per-tool kill switch from governance settings (§40). */
  disabledToolCodes?: readonly AiToolCode[];
};

/** MCP-01: a token without the scope neither sees nor calls the tool. Unknown scope strings are ignored. */
export function toolsVisibleForScopes(
  scopes: readonly string[],
  options: ToolFilterOptions = {},
): AiToolDefinition[] {
  const disabled = new Set<AiToolCode>(options.disabledToolCodes ?? []);
  return AI_TOOL_CATALOG.filter(
    (tool) => scopes.includes(tool.scope) && !disabled.has(tool.code),
  );
}

export type CanCallToolDenyReason =
  "tool_disabled" | "scope_missing" | "role_not_allowed";
export type CanCallToolResult =
  { allowed: true } | { allowed: false; reason: CanCallToolDenyReason };

/** Static gate only: permissions, outlet scope and quotas are checked by the server. */
export function canCallTool(input: {
  tool: AiToolDefinition;
  scopes: readonly string[];
  roles: readonly RoleTemplateKey[];
  disabledToolCodes?: readonly AiToolCode[];
}): CanCallToolResult {
  const { tool } = input;
  if (input.disabledToolCodes?.includes(tool.code))
    return { allowed: false, reason: "tool_disabled" };
  if (!input.scopes.includes(tool.scope))
    return { allowed: false, reason: "scope_missing" };
  if (!tool.minRoles.some((entry) => input.roles.includes(entry.role)))
    return { allowed: false, reason: "role_not_allowed" };
  return { allowed: true };
}

// ---- Action request draft (AIG-03) -----------------------------------------

/**
 * Row outlet of an action request, derived from the parsed payload (never
 * trusted from the caller). Single-outlet tools (TL-13, 14, 16, 18) use
 * `payload.outletId`. Multi-outlet tools (TL-15 `outletIds`, TL-17 optional
 * `outletIds`) use the one outlet when there is exactly one, else null
 * (tenant-level approval). A given `outletId` that disagrees throws.
 */
function actionRequestOutletId(
  toolCode: AiToolCode,
  payload: Record<string, unknown>,
  given: OutletId | null | undefined,
): OutletId | null {
  let derived: OutletId | null;
  if (typeof payload.outletId === "string") {
    derived = payload.outletId as OutletId;
  } else if (Array.isArray(payload.outletIds)) {
    const distinct = new Set(payload.outletIds as OutletId[]);
    derived = distinct.size === 1 ? [...distinct][0]! : null;
  } else {
    derived = null;
  }
  if (given != null && given !== derived)
    throw new RangeError(
      `${toolCode} outletId does not match the outlet in the payload`,
    );
  return derived;
}

/**
 * Build the insert input for a write tool call. Throws for read tools, parses
 * `input` with the tool input schema, and picks the approval action type from
 * the source (ai -> ai_action, mcp -> mcp_action). The row outlet comes from
 * the payload; `outletId` is an optional cross-check and throws RangeError on
 * mismatch. Does not mutate anything.
 */
export function toActionRequestDraft(args: {
  toolCode: AiToolCode;
  input: unknown;
  tenantId: TenantId;
  outletId?: OutletId | null;
  requestedByUserId: UserId;
  source: ActionRequestSource;
  mcpClientId: McpClientId | null;
  approvalRequestId: ApprovalRequestId;
  /** Default: ai_action for ai, mcp_action for mcp. A module action is allowed. */
  approvalActionType?: ActionRequestApprovalActionType;
  now: string;
  expiresAt: string;
}): CreateActionRequest {
  const tool = getAiTool(args.toolCode);
  if (!tool) throw new RangeError(`Unknown tool code: ${args.toolCode}`);
  if (tool.kind !== "write")
    throw new RangeError(
      `${tool.code} is a read tool and cannot make an action request`,
    );
  if (!(Date.parse(args.expiresAt) > Date.parse(args.now)))
    throw new RangeError("expiresAt must be after now");
  const payload = tool.input.parse(args.input);
  const outletId = actionRequestOutletId(
    args.toolCode,
    payload as Record<string, unknown>,
    args.outletId,
  );
  return createActionRequestSchema.parse({
    tenantId: args.tenantId,
    outletId,
    toolCode: args.toolCode,
    requestedByUserId: args.requestedByUserId,
    source: args.source,
    mcpClientId: args.mcpClientId,
    payload,
    approvalRequestId: args.approvalRequestId,
    approvalActionType:
      args.approvalActionType ??
      (args.source === "ai" ? "ai_action" : "mcp_action"),
    expiresAt: args.expiresAt,
  });
}
