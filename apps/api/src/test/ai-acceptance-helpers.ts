// Shared helpers for the WS-12 acceptance suites (ai-acceptance.test.ts and
// ai-mcp-acceptance.test.ts). Black-box only: users, roles and rows are made
// through the HTTP contract (@starter/shared/ai, identity, menu) or plain SQL
// for fixtures the contract has no endpoint for. Nothing here reads the AI
// implementation.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { ROLE_TEMPLATES, type RoleTemplateKey } from "@starter/shared/access";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiContentBlock,
  AiProvider,
} from "../lib/ai/types.ts";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { seedTenantRoleTemplates } from "../services/access.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner as floorPool,
  seededTenantId,
} from "./floor-test-helpers.ts";

export const app = createApp();

export const ownerPool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

// The AI suites never write into the shared seeded tenant (other suites assert
// its exact rows, e.g. guest-menu-api Q23). Each test file gets a tenant of its
// own: one brand, two outlets of that brand (the availability toggle refuses an
// outlet of another brand), the seeded tenant's modules and limits, the role
// templates and the AI/MCP approval policies (migration 0089 only seeds tenants
// that already exist; seedTenantRoleTemplates does it for new ones). AI settings
// are written by resetGovernance through the governance endpoint.
async function createAiTenant() {
  const suffix = `ai${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const isolated = await createIsolatedTenant(suffix);
  const second = randomUUID();
  await floorPool.query(
    `UPDATE tenants t SET feature_flags = s.feature_flags, limits = s.limits
       FROM tenants s WHERE t.id = $1 AND s.id = $2`,
    [isolated.tenantId, seededTenantId],
  );
  await floorPool.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji 2', 'Asia/Jakarta', $7, 'active')`,
    [
      second,
      isolated.tenantId,
      isolated.brandId,
      isolated.legalEntityId,
      `OUT-${suffix}B`.slice(0, 20).toUpperCase(),
      `Outlet ${suffix} B`,
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: isolated.tenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
  await withTenant(db, context, (tx) =>
    seedTenantRoleTemplates(tx, isolated.tenantId),
  );
  return { ...isolated, outletB: second };
}

const aiTenant = await createAiTenant();
export const tenantId = aiTenant.tenantId;
export const brandId = aiTenant.brandId;
export const outletA = aiTenant.outletId;
export const outletB = aiTenant.outletB;
/** Requests resolve the tenant from this host (TEN-02); the dev fallback would pick the seeded tenant. */
export const tenantHost = aiTenant.hostname;

/** A supertest agent that reaches the AI tenant's host. Cookies persist like a browser. */
export function tenantAgent(): ReturnType<typeof agent> {
  const client = agent(app);
  client.set("Host", tenantHost);
  return client;
}

export const created = {
  users: [] as string[],
  roles: [] as string[],
};

export async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type Client = ReturnType<typeof agent>;
export type Actor = { client: Client; userId: string; email: string };
export type Scope = { type: "tenant" } | { type: "outlet"; id: string };

/** A signed-in user with a verified second factor (back-office gate, AUTH-05). */
export async function signedIn(name: string): Promise<Actor> {
  const client = agent(app);
  const email = await signUp(client, name);
  client.set("Host", tenantHost);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  created.users.push(userId);
  await verifySessionMfa(email);
  return { client, userId, email };
}

/** Custom role with exactly these permission codes. */
export async function grantCustomRole(
  userId: string,
  permissions: string[],
  scope: Scope,
): Promise<void> {
  const roleId = randomUUID();
  created.roles.push(roleId);
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenantId,
        `AI acceptance ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        tenantId,
        userId,
        roleId,
        scope.type,
        scope.type === "outlet" ? scope.id : null,
      ],
    );
  });
}

/**
 * Assigns the tenant's template role (e.g. `employee`, `outlet_manager`) so the
 * per-role-group quota and approval matrix see the real role key. The template
 * row is created from ROLE_TEMPLATES when the tenant has none.
 */
export async function grantTemplateRole(
  userId: string,
  key: RoleTemplateKey,
  scope: Scope,
): Promise<void> {
  const template = ROLE_TEMPLATES.find((entry) => entry.key === key)!;
  await asTenant(async (db) => {
    const existing = await db.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND is_template AND template_key = $2",
      [tenantId, key],
    );
    let roleId = existing.rows[0]?.id;
    if (!roleId) {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO roles
           (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
         VALUES ($1, $2, true, $3, $4::jsonb, false, $5::jsonb)
         RETURNING id`,
        [
          tenantId,
          template.defaultName,
          key,
          JSON.stringify(template.permissions),
          JSON.stringify(template.allowedScopeTypes),
        ],
      );
      roleId = inserted.rows[0]!.id;
    }
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        tenantId,
        userId,
        roleId,
        scope.type,
        scope.type === "outlet" ? scope.id : null,
      ],
    );
  });
}

export async function removeAssignments(userId: string): Promise<void> {
  await asTenant((db) =>
    db.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2",
      [tenantId, userId],
    ),
  );
}

/** Everything the owner persona in these suites needs, tenant-wide. */
export const OWNER_PERMISSIONS = [
  "ai.ask",
  "ai.action.propose",
  "ai.governance.manage",
  "mcp.client.manage",
  "report.sales.view",
  "menu.item.view",
  "menu.item.manage",
  "menu.availability.toggle",
  "approval.inbox.view",
  "approval.request.decide",
];

export async function newOwner(name = "Owner AI"): Promise<Actor> {
  const actor = await signedIn(name);
  // AI tools match role templates only (catalog `minRoles`), so the owner
  // holds the owner template; the custom role adds the remaining AI codes.
  await grantTemplateRole(actor.userId, "owner", { type: "tenant" });
  await grantCustomRole(actor.userId, OWNER_PERMISSIONS, { type: "tenant" });
  return actor;
}

export async function cleanupAcceptance(): Promise<void> {
  await asTenant(async (db) => {
    await db.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenantId, created.users],
    );
    await db.query("DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)", [
      tenantId,
      created.roles,
    ]);
  });
}

// ---- Governance -------------------------------------------------------------

export const BIG_BUDGET_IDR = 100_000_000_000;

/** Known-good baseline so a test never inherits another test's switches. */
export async function resetGovernance(admin: Actor): Promise<void> {
  const res = await admin.client
    .patch("/api/ai/governance")
    .set(originHeader)
    .send({
      aiEnabled: true,
      mcpEnabled: true,
      dynamicClientRegistrationEnabled: false,
      monthlyBudgetIdr: BIG_BUDGET_IDR,
      budgetWarnPct: 80,
      budgetStopPct: 100,
      features: [],
      disabledToolCodes: [],
      mcpRateLimitPerMinute: 600,
      maxRowsPerResponse: 200,
    });
  if (res.status !== 200)
    throw new Error(`resetGovernance failed: ${res.status} ${res.text}`);
}

export async function patchGovernance(
  admin: Actor,
  patch: Record<string, unknown>,
) {
  return admin.client.patch("/api/ai/governance").set(originHeader).send(patch);
}

// ---- Scripted AI provider (stands in for the `fake` adapter) ------------------

export type Usage = { inputTokens: number; outputTokens: number };
export const SMALL_USAGE: Usage = { inputTokens: 20, outputTokens: 10 };

export function textResult(
  text: string,
  usage: Usage = SMALL_USAGE,
): AiCompletionResult {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage,
    model: "scripted-model",
  };
}

export function toolUseResult(
  name: string,
  input: unknown,
  usage: Usage = SMALL_USAGE,
): AiCompletionResult {
  return {
    content: [{ type: "tool_use", id: `toolu_${randomUUID()}`, name, input }],
    stopReason: "tool_use",
    usage,
    model: "scripted-model",
  };
}

export type ScriptFn = (
  request: AiCompletionRequest,
  callIndex: number,
) => AiCompletionResult | Promise<AiCompletionResult>;

export class ScriptedProvider implements AiProvider {
  readonly name = "scripted";
  readonly requests: AiCompletionRequest[] = [];
  constructor(private readonly script: ScriptFn) {}
  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    this.requests.push(structuredClone(request));
    return this.script(request, this.requests.length - 1);
  }
  /** Every string the provider was ever sent (system, text, tool results). */
  allSentText(): string {
    return JSON.stringify(this.requests);
  }
}

/** tool_result blocks in the last message of a request (the tool loop). */
export function toolResultsIn(
  request: AiCompletionRequest,
): Extract<AiContentBlock, { type: "tool_result" }>[] {
  const last = request.messages[request.messages.length - 1];
  return (last?.content ?? []).filter(
    (block): block is Extract<AiContentBlock, { type: "tool_result" }> =>
      block.type === "tool_result",
  );
}

/** All tool_result blocks the provider ever received, across all calls. */
export function allToolResults(provider: ScriptedProvider) {
  return provider.requests.flatMap(toolResultsIn);
}

/**
 * First turn: call `tool`. After the tool result comes back: answer with
 * `compose(resultBlocks)`. A model that obeys whatever the data says.
 */
export function callToolThenAnswer(
  tool: string,
  input: unknown,
  compose: (results: ReturnType<typeof toolResultsIn>) => string,
  usage: Usage = SMALL_USAGE,
): ScriptFn {
  return (request) => {
    const results = toolResultsIn(request);
    if (results.length > 0) return textResult(compose(results), usage);
    return toolUseResult(tool, input, usage);
  };
}

export function plainAnswer(text = "Jawaban uji.", usage = SMALL_USAGE) {
  return new ScriptedProvider(() => textResult(text, usage));
}

// ---- Misc ---------------------------------------------------------------------

export function codeOf(res: { body: unknown; text?: string }): string | null {
  const body = res.body as { code?: unknown; error?: { code?: unknown } };
  if (typeof body?.code === "string") return body.code;
  if (typeof body?.error?.code === "string") return body.error.code;
  return null;
}

export async function pollUntil<T>(
  produce: () => Promise<T>,
  done: (value: T) => boolean,
  { timeoutMs, intervalMs = 250 }: { timeoutMs: number; intervalMs?: number },
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await produce();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    value = await produce();
  }
  return value;
}

/** Outbox events of one name for this tenant, newest first. */
export async function outboxEvents(
  name: string,
): Promise<{ payload: Record<string, unknown> }[]> {
  const { rows } = await ownerPool.query<{
    event: { payload: Record<string, unknown> };
  }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = $2
      ORDER BY id DESC LIMIT 500`,
    [tenantId, name],
  );
  return rows.map((row) => ({ payload: row.event.payload }));
}

export async function createMenuItem(owner: Actor): Promise<string> {
  const category = await owner.client
    .post("/api/menu/categories")
    .set(originHeader)
    .send({ brandId, name: `Kategori AI ${randomUUID().slice(0, 8)}` });
  if (category.status !== 201)
    throw new Error(`category failed ${category.status}`);
  const item = await owner.client
    .post("/api/menu/items")
    .set(originHeader)
    .send({
      brandId,
      categoryId: category.body.data.id,
      name: `Menu AI ${randomUUID().slice(0, 8)}`,
    });
  if (item.status !== 201) throw new Error(`item failed ${item.status}`);
  return item.body.data.id as string;
}

/** What the outlet availability of an item looks like right now (any shape). */
export async function availabilityFingerprint(
  menuItemId: string,
): Promise<string> {
  const rows = await asTenant((db) =>
    db.query(
      "SELECT * FROM item_availability WHERE tenant_id = $1 AND menu_item_id = $2 ORDER BY 1",
      [tenantId, menuItemId],
    ),
  );
  return JSON.stringify(
    rows.rows.map((row) => {
      const rest: Record<string, unknown> = { ...row };
      delete rest.updated_at;
      delete rest.created_at;
      return rest;
    }),
  );
}

export { originHeader };
