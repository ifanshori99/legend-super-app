// Tool invoke layer (AIG-01 enforcement point; part I, bead legend-zfi4) against
// PostgreSQL with the restricted app role: kill switch, MCP scope, permission,
// input/output validation, row cap, redacted audit row, tenant isolation.
// Handlers are stubs (vi.mock); the real TL-xx handlers have their own tests.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cafeLegendAiFixtures, getAiTool } from "@starter/shared/ai";
import type { AiToolCode } from "@starter/shared/ai";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { TenantId } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { aiToolCalls } from "../db/schema/ai.ts";
import { withTenant } from "../db/tenant.ts";
import type { AccessSnapshot } from "../services/permission-resolver.ts";
import type { AiToolContext } from "../services/ai-tools/types.ts";

const handlers = vi.hoisted(() => ({
  map: {} as Record<string, (ctx: unknown, input: unknown) => Promise<unknown>>,
}));
vi.mock("../services/ai-tools/handlers.ts", () => ({
  aiToolHandlers: handlers.map,
  getAiToolHandler: (code: string) => handlers.map[code],
}));

const {
  invokeAiTool,
  listCallableTools,
  toToolSpecs,
} = await import("../services/ai-tool-invoke.service.ts");

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const otherTenant = randomUUID();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const STOCK: AiToolCode = "TL-03";
const stockTool = getAiTool(STOCK)!;
const sample = cafeLegendAiFixtures.toolSamples[STOCK];
const userId = randomUUID();

function access(
  tenant: string,
  permissions: string[],
  templateKeys: string[] = [],
  extra: Partial<Record<keyof AccessSnapshot, unknown>> = {},
): AccessSnapshot {
  return {
    tenant: establishTenantContext({
      tenantId: tenant,
      brandId: null,
      source: "session",
    }),
    userId,
    permissions,
    templateKeys,
    mfaRequired: false,
    mfaVerified: true,
    allows: () => true,
    // Every listed template holds every listed permission unless overridden.
    allowsVia: (key: string) => templateKeys.includes(key),
    permissionsVia: (key: string) =>
      templateKeys.includes(key) ? permissions : [],
    contextFor: () => null,
    stationsFor: () => [],
    ...extra,
  } as unknown as AccessSnapshot;
}

const ctxOf = (
  snapshot: AccessSnapshot,
  channel: "tanya_ai" | "mcp" = "tanya_ai",
): AiToolContext => ({
  access: snapshot,
  channel,
  mcpClientId: null,
  now: new Date(),
});

const warehouse = () =>
  access(tenantId, ["inventory.stock.view"], ["warehouse"]);

const callsOf = (tenant: string) =>
  withTenant(
    db,
    establishScopedTenantContext(
      establishTenantContext({ tenantId: tenant, brandId: null, source: "session" }),
      { kind: "tenant" },
    ),
    (tx) =>
      tx
        .select()
        .from(aiToolCalls)
        .where(eq(aiToolCalls.tenantId, tenant as TenantId)),
  );

async function setSettings(disabled: string[], maxRows = 200) {
  await owner.query(`DELETE FROM ai_settings WHERE tenant_id = $1`, [tenantId]);
  await owner.query(
    `INSERT INTO ai_settings (tenant_id, disabled_tool_codes, max_rows_per_response, updated_by)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, disabled, maxRows, userId],
  );
}

beforeAll(async () => {
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'AI invoke', $2)`,
    [userId, `${userId}@example.test`],
  );
});

beforeEach(async () => {
  await owner.query(`DELETE FROM ai_settings WHERE tenant_id = $1`, [tenantId]);
  for (const key of Object.keys(handlers.map)) delete handlers.map[key];
  handlers.map[STOCK] = async () => sample.output;
});

afterAll(async () => {
  await owner.query(`DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND event->>'name' = 'ai_tool.invoked'`, [tenantId]);
  await owner.query(`DELETE FROM ai_tool_calls WHERE user_id = $1`, [userId]);
  await owner.query(`DELETE FROM ai_settings WHERE tenant_id = $1`, [tenantId]);
  await owner.query(`DELETE FROM "user" WHERE id = $1`, [userId]);
  await owner.end();
});

describe("invokeAiTool", () => {
  it("runs an allowed tool, audits it and emits ai_tool.invoked", async () => {
    const result = await invokeAiTool(ctxOf(warehouse()), stockTool.name, sample.input);
    expect(result).toMatchObject({ ok: true, toolCode: STOCK, rowCount: 2 });
    const rows = (await callsOf(tenantId)).filter((row) => row.userId === userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ toolCode: STOCK, channel: "app", status: "ok", rowCount: 2 });
    const events = await owner.query(
      `SELECT 1 FROM domain_event_outbox WHERE tenant_id = $1 AND event->>'name' = 'ai_tool.invoked' AND event->'payload'->>'toolCallId' = $2`,
      [tenantId, rows[0]!.id],
    );
    expect(events.rowCount).toBe(1);
  });

  it("denies a caller without the permission, audits it, never runs the handler", async () => {
    const handler = vi.fn(async () => sample.output);
    handlers.map[STOCK] = handler;
    const result = await invokeAiTool(ctxOf(access(tenantId, ["pos.order.create"], ["cashier"])), stockTool.name, sample.input);
    expect(result).toMatchObject({ ok: false, errorCode: "AI_TOOL_FORBIDDEN" });
    expect(handler).not.toHaveBeenCalled();
    const denied = (await callsOf(tenantId)).filter((r) => r.errorCode === "AI_TOOL_FORBIDDEN");
    expect(denied.at(-1)).toMatchObject({ status: "denied", rowCount: 0 });
  });

  it("kill switch returns AI_TOOL_DISABLED and hides the tool", async () => {
    await setSettings([STOCK]);
    const handler = vi.fn(async () => sample.output);
    handlers.map[STOCK] = handler;
    const result = await invokeAiTool(ctxOf(warehouse()), stockTool.name, sample.input);
    expect(result).toMatchObject({ ok: false, errorCode: "AI_TOOL_DISABLED" });
    expect(handler).not.toHaveBeenCalled();
    const listed = await listCallableTools(ctxOf(warehouse()));
    expect(listed.map((tool) => tool.code)).not.toContain(STOCK);
  });

  it("MCP scope missing returns MCP_SCOPE_INSUFFICIENT and filters the list", async () => {
    const ctx = ctxOf(warehouse(), "mcp");
    const result = await invokeAiTool(ctx, stockTool.name, sample.input, { scopes: ["mcp:sales:read"] });
    expect(result).toMatchObject({ ok: false, errorCode: "MCP_SCOPE_INSUFFICIENT" });
    expect((await listCallableTools(ctx, { scopes: ["mcp:sales:read"] })).map((t) => t.code)).not.toContain(STOCK);
    const ok = await invokeAiTool(ctx, stockTool.name, sample.input, { scopes: [stockTool.scope] });
    expect(ok.ok).toBe(true);
    expect((await listCallableTools(ctx, { scopes: [stockTool.scope] })).map((t) => t.code)).toContain(STOCK);
  });

  it("invalid input is ok:false INVALID_INPUT and the handler does not run", async () => {
    const handler = vi.fn(async () => sample.output);
    handlers.map[STOCK] = handler;
    const result = await invokeAiTool(ctxOf(warehouse()), stockTool.name, { onlyBelowPar: "yes" });
    expect(result).toMatchObject({ ok: false, errorCode: "INVALID_INPUT" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("an output schema violation is an error, not a leak", async () => {
    handlers.map[STOCK] = async () => ({ items: [], secret: "other-tenant-data" });
    const result = await invokeAiTool(ctxOf(warehouse()), stockTool.name, sample.input);
    expect(result).toMatchObject({ ok: false, errorCode: "TOOL_OUTPUT_INVALID" });
    expect(JSON.stringify(result)).not.toContain("other-tenant-data");
  });

  it("a handler AiError is passed on; any other crash is TOOL_ERROR without detail", async () => {
    const { AiError } = await import("@starter/shared/ai");
    handlers.map[STOCK] = async () => {
      throw new AiError("AI_TOOL_FORBIDDEN");
    };
    expect(await invokeAiTool(ctxOf(warehouse()), stockTool.name, sample.input)).toMatchObject({ ok: false, errorCode: "AI_TOOL_FORBIDDEN" });
    handlers.map[STOCK] = async () => {
      throw new Error("select * from secrets failed");
    };
    const crashed = await invokeAiTool(ctxOf(warehouse()), stockTool.name, sample.input);
    expect(crashed).toMatchObject({ ok: false, errorCode: "TOOL_ERROR" });
    expect(JSON.stringify(crashed)).not.toContain("secrets");
  });

  it("missing handler answers AI_TOOL_DISABLED; unknown tool answers AI_TOOL_NOT_FOUND", async () => {
    delete handlers.map[STOCK];
    expect(await invokeAiTool(ctxOf(warehouse()), stockTool.name, sample.input)).toMatchObject({ ok: false, errorCode: "AI_TOOL_DISABLED" });
    expect(await invokeAiTool(ctxOf(warehouse()), "drop_database", {})).toMatchObject({ ok: false, toolCode: null, errorCode: "AI_TOOL_NOT_FOUND" });
  });

  it("caps rows at the tenant setting (schema already bounds the tool maxRows)", async () => {
    const item = sample.output.items[0]!;
    handlers.map[STOCK] = async () => ({
      ...sample.output,
      items: Array.from({ length: stockTool.maxRows }, () => item),
    });
    const capped = await invokeAiTool(ctxOf(warehouse()), stockTool.name, sample.input);
    expect(capped).toMatchObject({ ok: true, rowCount: stockTool.maxRows });
    await setSettings([], 3);
    const small = await invokeAiTool(ctxOf(warehouse()), stockTool.name, sample.input);
    expect(small).toMatchObject({ ok: true, rowCount: 3 });
    if (small.ok) {
      expect((small.output as { items: unknown[] }).items).toHaveLength(3);
      expect(small.output).toMatchObject({ truncated: true });
    }
  });

  it("audit params are redacted, scalar and bounded", async () => {
    await invokeAiTool(ctxOf(warehouse()), stockTool.name, { search: "budi@example.com", onlyBelowPar: true });
    const row = (await callsOf(tenantId)).filter((r) => r.userId === userId).at(-1)!;
    expect(JSON.stringify(row.params)).not.toContain("budi@example.com");
    expect(row.params).toMatchObject({ onlyBelowPar: true });
  });

  it("a template's own permissions qualify it, not another role's (role-scoped grant)", async () => {
    const handler = vi.fn(async () => sample.output);
    handlers.map[STOCK] = handler;
    // Holds the warehouse template, but inventory.stock.view comes from a
    // custom role: the warehouse grant itself lacks it.
    const mixed = access(tenantId, ["inventory.stock.view"], ["warehouse"], {
      permissionsVia: () => [],
    });
    expect(await invokeAiTool(ctxOf(mixed), stockTool.name, sample.input)).toMatchObject({ ok: false, errorCode: "AI_TOOL_FORBIDDEN" });
    expect(handler).not.toHaveBeenCalled();
    expect((await listCallableTools(ctxOf(mixed))).map((t) => t.code)).not.toContain(STOCK);
  });

  it("a custom role outside minRoles is neither listed nor invokable (same rule as handlers)", async () => {
    const custom = access(tenantId, ["inventory.stock.view"], []);
    expect((await listCallableTools(ctxOf(custom))).map((t) => t.code)).not.toContain(STOCK);
    expect(await invokeAiTool(ctxOf(custom), stockTool.name, sample.input)).toMatchObject({ ok: false, errorCode: "AI_TOOL_FORBIDDEN" });
  });

  it("does not list a tool without a registered handler", async () => {
    delete handlers.map[STOCK];
    expect((await listCallableTools(ctxOf(warehouse()))).map((t) => t.code)).not.toContain(STOCK);
  });

  it("HRIS/finance tools need a verified second factor when the role requires MFA", async () => {
    const FIN: AiToolCode = "TL-06";
    const finTool = getAiTool(FIN)!;
    const finSample = cafeLegendAiFixtures.toolSamples[FIN];
    const handler = vi.fn(async () => finSample.output);
    handlers.map[FIN] = handler;
    const finance = (mfaVerified: boolean) =>
      access(tenantId, ["report.financial.view"], ["finance"], {
        mfaRequired: true,
        mfaVerified,
      });
    expect(await invokeAiTool(ctxOf(finance(false)), finTool.name, finSample.input)).toMatchObject({ ok: false, errorCode: "AI_TOOL_FORBIDDEN" });
    expect(handler).not.toHaveBeenCalled();
    expect(await invokeAiTool(ctxOf(finance(true)), finTool.name, finSample.input)).toMatchObject({ ok: true, toolCode: FIN });
    // Listing (and the orchestrator's re-check through it) hides the tool too.
    expect((await listCallableTools(ctxOf(finance(false)))).map((t) => t.code)).not.toContain(FIN);
    expect((await listCallableTools(ctxOf(finance(true)))).map((t) => t.code)).toContain(FIN);
    // SOP search (TL-10) is not personal or financial data: never gated.
    const SOP: AiToolCode = "TL-10";
    const sopTool = getAiTool(SOP)!;
    const sopSample = cafeLegendAiFixtures.toolSamples[SOP];
    handlers.map[SOP] = async () => sopSample.output;
    const asker = access(tenantId, ["self.sop.read"], ["employee"], { mfaRequired: true, mfaVerified: false });
    expect(await invokeAiTool(ctxOf(asker), sopTool.name, sopSample.input)).toMatchObject({ ok: true, toolCode: SOP });
    expect((await listCallableTools(ctxOf(asker))).map((t) => t.code)).toContain(SOP);
    // Non-HRIS/finance tools are not gated.
    const stock = access(tenantId, ["inventory.stock.view"], ["warehouse"], { mfaRequired: true, mfaVerified: false });
    expect(await invokeAiTool(ctxOf(stock), stockTool.name, sample.input)).toMatchObject({ ok: true });
  });

  it("another tenant never sees this tenant's audit rows or kill switches", async () => {
    await setSettings([STOCK]);
    await invokeAiTool(ctxOf(warehouse()), stockTool.name, sample.input);
    expect((await callsOf(otherTenant)).length).toBe(0);
    const foreign = access(otherTenant, ["inventory.stock.view"], ["warehouse"]);
    const listed = await listCallableTools(ctxOf(foreign));
    expect(listed.map((t) => t.code)).toContain(STOCK); // tenant A's switch does not apply
  });
});

describe("toToolSpecs", () => {
  it("emits a JSON schema per tool without $schema", () => {
    const specs = toToolSpecs([stockTool]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ name: stockTool.name, description: stockTool.description });
    expect(specs[0]!.inputSchema).toMatchObject({ type: "object" });
    expect(specs[0]!.inputSchema).not.toHaveProperty("$schema");
  });
});
