// legend-cot3 ai: MCP scope. Can a principal whose assignments are only outlet-
// or station-scoped read outside its reach through the MCP read tools?
//
// Runs the real Express app over HTTP (Streamable HTTP, JSON-RPC) like
// ai-mcp-acceptance.test.ts. Every read tool of the catalog is called by name
// (not only the ones tools/list shows) with arguments aimed at outlet B, at
// both outlets and at no outlet. Data is seeded in outlet A and outlet B with
// distinct markers, so a leak shows up as a B marker in a successful reply.
//
// Rules: a positive control comes before every denial (the tenant-wide
// principal reads the same call, outlet-A reads its own outlet). A call that
// fails with INVALID_INPUT never counts as a denial. The assertions state the
// SECURE behaviour; a failing one is a leak in product code.
//
// Seeded and checked for leaks: TL-01 sales, TL-02 menu performance, TL-03
// stock, TL-04 food cost, TL-11 anomalies. Not seeded (denial or "no outlet B
// id/name in the reply" only): TL-05 labor, TL-08 shifts, TL-20 facility. TL-05,
// TL-06, TL-08, TL-09 and TL-12 are also behind the MFA gate for MCP callers,
// so their refusals here come from that gate, not from outlet scope. TL-10 SOP
// search is seeded with a tenant-wide SOP and an outlet-B station SOP.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AI_TOOL_CATALOG,
  MCP_READ_SCOPES,
  type McpScope,
} from "@starter/shared/ai";
import {
  app,
  asTenant,
  brandId,
  cleanupAcceptance,
  grantTemplateRole,
  newOwner,
  originHeader,
  outletA,
  outletB,
  ownerPool,
  removeAssignments,
  resetGovernance,
  signedIn,
  tenantAgent,
  tenantId,
  type Actor,
} from "./ai-acceptance-helpers.ts";

const MCP_PATH = "/mcp";
const METADATA_PATH = "/.well-known/oauth-authorization-server";
const REDIRECT_URI = "http://localhost:8123/callback";
const READ_SCOPES: McpScope[] = [...MCP_READ_SCOPES];

const PERIOD = { from: "2026-09-15", to: "2026-09-21" };
const BUSINESS_DATE = "2026-09-16";
const NET_A = 111_456;
const NET_B = 777_123;
const MENU_A = "Menu Marker Alfa";
const MENU_B = "Menu Marker Bravo";
const STOCK_A = "Stok Marker Alfa";
const STOCK_B = "Stok Marker Bravo";
/** SOP titles; TL-10 searches "prosedur". */
const SOP_GLOBAL = "Prosedur Marker Global";
const SOP_B = "Prosedur Marker Bravo";
/** Self-only tools: they read the caller's own rows, never an outlet's. */
const SELF_TOOL_CODES = new Set(["TL-09", "TL-12"]);

const READ_TOOLS = AI_TOOL_CATALOG.filter((tool) => tool.kind === "read");
/** Tools that read operational rows of one or more outlets (they take `outletIds`). */
const OUTLET_TOOL_CODES = new Set([
  "TL-01",
  "TL-02",
  "TL-03",
  "TL-04",
  "TL-05",
  "TL-08",
  "TL-11",
  "TL-20",
  "TL-21",
]);
/** Tools whose seeded outlet-B data the tenant-wide control must show. */
const SEEDED_CODES = ["TL-01", "TL-02", "TL-03", "TL-04", "TL-11"];

let admin: Actor;
let wide: Actor;
let outletUser: Actor;
let stationUser: Actor;
let stationElevatedUser: Actor;
let outletBName = "";
let stationId = "";
const stationIds: string[] = [];
const sopIds: string[] = [];

// ---- Protocol helpers (same wire format as ai-mcp-acceptance.test.ts) --------

type Rpc = { result?: RpcResult; error?: unknown };
type RpcResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
  tools?: { name: string }[];
};
type Reply = { status: number; rpc: Rpc; raw: string };

function parseRpc(res: request.Response): Rpc {
  const body = res.body as Record<string, unknown> | undefined;
  if (body && typeof body === "object" && ("result" in body || "error" in body))
    return body as Rpc;
  for (const line of (res.text ?? "").split("\n"))
    if (line.startsWith("data:")) {
      try {
        return JSON.parse(line.slice(5).trim()) as Rpc;
      } catch {
        /* keep looking */
      }
    }
  return {};
}

async function call(
  token: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<Reply> {
  const res = await request(app)
    .post(MCP_PATH)
    .set("Accept", "application/json, text/event-stream")
    .set("Content-Type", "application/json")
    .set("Authorization", `Bearer ${token}`)
    .send({ jsonrpc: "2.0", id: 1, method, params });
  return {
    status: res.status,
    rpc: parseRpc(res),
    raw: `${res.text ?? ""}${JSON.stringify(res.body ?? "")}`,
  };
}

const callTool = (token: string, name: string, args: Record<string, unknown>) =>
  call(token, "tools/call", { name, arguments: args });

const denied = (reply: Reply) =>
  reply.status >= 400 ||
  reply.rpc.error !== undefined ||
  reply.rpc.result?.isError === true;

/** AiError code of a refused tools/call, else null. */
function errorCodeOf(reply: Reply): string | null {
  const text = reply.rpc.result?.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return (JSON.parse(text) as { errorCode?: string }).errorCode ?? null;
  } catch {
    return null;
  }
}

async function toolNames(token: string): Promise<string[]> {
  const reply = await call(token, "tools/list");
  expect(reply.status).toBe(200);
  return (reply.rpc.result!.tools ?? []).map((t) => t.name);
}

// ---- OAuth helpers -----------------------------------------------------------

const pathOf = (url: string) => new URL(url, "http://localhost").pathname;

async function metadata(): Promise<Record<string, string>> {
  const res = await tenantAgent().get(METADATA_PATH);
  expect(res.status, "RFC 8414 metadata").toBe(200);
  return res.body;
}

/** GET authorize -> consent redirect -> POST approve -> redirect parameters (code or error). */
async function authorizeCode(
  user: Actor,
  clientId: string,
  challenge: string,
): Promise<URLSearchParams> {
  const meta = await metadata();
  const res = await user.client
    .get(pathOf(meta.authorization_endpoint!))
    .query({
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      scope: READ_SCOPES.join(" "),
      state: "scope-test",
      code_challenge: challenge,
      code_challenge_method: "S256",
    })
    .redirects(0);
  expect(res.status, "authorize redirect").toBeGreaterThanOrEqual(300);
  const consent = new URL(res.headers.location as string, REDIRECT_URI);
  expect(consent.pathname).toBe("/mcp/consent");
  const approve = await user.client
    .post("/api/ai/mcp/authorize")
    .set(originHeader)
    .send({
      ...Object.fromEntries(consent.searchParams.entries()),
      approve: true,
    });
  expect(approve.status, JSON.stringify(approve.body)).toBe(200);
  return new URL(approve.body.redirectTo as string, REDIRECT_URI).searchParams;
}

async function approvedClient(): Promise<string> {
  const clientId = `scope-${randomUUID().slice(0, 12)}`;
  const created = await admin.client
    .post("/api/ai/mcp-clients")
    .set(originHeader)
    .send({
      name: `Klien uji ${clientId}`,
      clientId,
      redirectUris: [REDIRECT_URI],
      allowedScopes: READ_SCOPES,
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const approve = await admin.client
    .post(`/api/ai/mcp-clients/${created.body.data.id as string}/approve`)
    .set(originHeader)
    .send({});
  expect(approve.status).toBe(200);
  return clientId;
}

/** Asks for every read scope. `token` is null when the server refuses to issue one. */
async function tryToken(
  user: Actor,
  clientId: string,
): Promise<{ token: string | null; error: string | null }> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = await authorizeCode(user, clientId, challenge);
  const code = params.get("code");
  if (!code) return { token: null, error: params.get("error") ?? "no code" };
  const meta = await metadata();
  const res = await tenantAgent()
    .post(pathOf(meta.token_endpoint!))
    .type("form")
    .send({
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      code,
      client_id: clientId,
      code_verifier: verifier,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { token: res.body.access_token as string, error: null };
}

async function tokenFor(user: Actor, clientId: string): Promise<string> {
  const issued = await tryToken(user, clientId);
  expect(issued.error, "token refused").toBeNull();
  return issued.token!;
}

// ---- Seeding -------------------------------------------------------------------

/** Like asTenant, with triggers off for append-only event rows (voids). */
async function asTenantReplica<T>(
  run: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    await client.query("SET LOCAL session_replication_role = replica");
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

async function seedData(): Promise<void> {
  const categoryId = randomUUID();
  const uomId = randomUUID();
  const sides = [
    { outlet: outletA, net: NET_A, qty: 2, menu: MENU_A, stock: STOCK_A },
    { outlet: outletB, net: NET_B, qty: 3, menu: MENU_B, stock: STOCK_B },
  ];
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Marker')`,
      [categoryId, tenantId, brandId],
    );
    await db.query(
      `INSERT INTO uoms (id, tenant_id, code, name) VALUES ($1, $2, $3, 'Kilogram')`,
      [uomId, tenantId, `k${randomUUID().slice(0, 6)}`],
    );
    for (const side of sides) {
      const menuId = randomUUID();
      const orderId = randomUUID();
      const locationId = randomUUID();
      const itemId = randomUUID();
      await db.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name) VALUES ($1, $2, $3, $4, $5)`,
        [menuId, tenantId, brandId, categoryId, side.menu],
      );
      await db.query(
        `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
           subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
           status, business_date, placed_at)
         VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', $5, 0, 0, 0, 0, $5, 'completed', $6, $7)`,
        [
          orderId,
          tenantId,
          side.outlet,
          `SC-${randomUUID().slice(0, 8)}`,
          side.net,
          BUSINESS_DATE,
          `${BUSINESS_DATE}T05:00:00.000Z`,
        ],
      );
      await db.query(
        `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, name, quantity,
           unit_price_idr, modifiers_total_idr, line_total_idr, fire_status, status,
           reserved_business_date, cost_snapshot_idr)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, 'fired', 'served', $10, 20000)`,
        [
          randomUUID(),
          tenantId,
          side.outlet,
          orderId,
          menuId,
          side.menu,
          side.qty,
          side.net / side.qty,
          side.net,
          BUSINESS_DATE,
        ],
      );
      await db.query(
        `INSERT INTO stock_locations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'Gudang', 'warehouse')`,
        [locationId, tenantId, side.outlet],
      );
      await db.query(
        `INSERT INTO inventory_items (id, tenant_id, name, category, base_uom_id, par_min)
         VALUES ($1, $2, $3, 'bahan', $4, '10')`,
        [itemId, tenantId, side.stock, uomId],
      );
      await db.query(
        `INSERT INTO stock_balances (tenant_id, outlet_id, location_id, inventory_item_id, quantity, avg_cost_idr)
         VALUES ($1, $2, $3, $4, '3', 1000)`,
        [tenantId, side.outlet, locationId, itemId],
      );
    }
  });
  // A void spike in both outlets: 4 in the period, 1 in the previous period.
  await asTenantReplica(async (db) => {
    for (const outlet of [outletA, outletB])
      for (const at of [
        "2026-09-16T05:00:00Z",
        "2026-09-17T05:00:00Z",
        "2026-09-18T05:00:00Z",
        "2026-09-19T05:00:00Z",
        "2026-09-10T05:00:00Z",
      ])
        await db.query(
          `INSERT INTO pos_order_voids (id, tenant_id, outlet_id, order_id, receipt_number, amount_idr, reason,
                                        reason_note, requested_by, approved_by, approval_request_id, voided_at)
           VALUES ($1, $2, $3, $4, $5, 25000, 'wrong_item', 'salah input', 'kasir-a', 'spv-b', $6, $7)`,
          [
            randomUUID(),
            tenantId,
            outlet,
            randomUUID(),
            `SC-${randomUUID().slice(0, 8)}`,
            randomUUID(),
            at,
          ],
        );
  });
}

async function createStation(outlet = outletA): Promise<string> {
  const id = randomUUID();
  await asTenant((db) =>
    db.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, $4, 'coffee_bar')`,
      [id, tenantId, outlet, `Stasiun scope ${id.slice(0, 6)}`],
    ),
  );
  stationIds.push(id);
  return id;
}

/** One live SOP per row: tenant-wide (no station) and one at an outlet-B station. */
async function seedSops(): Promise<void> {
  const stationB = await createStation(outletB);
  for (const [title, station] of [
    [SOP_GLOBAL, null],
    [SOP_B, stationB],
  ] as const) {
    const id = randomUUID();
    await asTenant((db) =>
      db.query(
        `INSERT INTO sop_documents (id, tenant_id, lineage_id, version, station_id,
           title, body, requires_acknowledgement, effective_from, published_by)
         VALUES ($1, $2, $1, 1, $3, $4, $5, false, '2026-01-01', $6)`,
        [id, tenantId, station, title, `${title} langkah kerja`, admin.userId],
      ),
    );
    sopIds.push(id);
  }
}

/** Assigns a seeded role template at STATION scope (direct insert, as the role editor would not). */
async function grantAtStation(
  userId: string,
  templateKey: string,
  station: string,
): Promise<void> {
  await asTenant(async (db) => {
    const role = await db.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND is_template AND template_key = $2",
      [tenantId, templateKey],
    );
    const roleId = role.rows[0]?.id;
    if (!roleId) throw new Error(`template ${templateKey} is not seeded`);
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'station', $4, now() - interval '1 minute', $2)`,
      [tenantId, userId, roleId, station],
    );
  });
}

// ---- Tool calls ----------------------------------------------------------------

const outletTools = (outletIds?: string[]) => ({
  period: PERIOD,
  ...(outletIds ? { outletIds } : {}),
});

/** Valid arguments for a read tool, aimed at `outletIds` when the tool takes them. */
function argsFor(code: string, outletIds?: string[]): Record<string, unknown> {
  switch (code) {
    case "TL-01":
      return { ...outletTools(outletIds), groupBy: "outlet" };
    case "TL-03":
      return outletIds ? { outletIds } : {};
    case "TL-06":
      return { statement: "profit_loss", period: PERIOD };
    case "TL-07":
      return { segmentBy: "tier" };
    case "TL-09":
      return { payrollMonth: "2026-09" };
    case "TL-10":
      return { query: "prosedur" };
    case "TL-12":
      return {};
    case "TL-19":
      return { actionRequestId: randomUUID() };
    default:
      return outletTools(outletIds);
  }
}

type Variant = { label: string; outletIds: string[] | undefined };
const VARIANTS: Variant[] = [
  { label: "outlet B", outletIds: [outletB] },
  { label: "outlets A+B", outletIds: [outletA, outletB] },
  { label: "no outlet filter", outletIds: undefined },
];

/** Markers that exist only in outlet B data (ids compared lower-case). */
function bMarkers(): string[] {
  return [
    outletB.toLowerCase(),
    outletBName.toLowerCase(),
    String(NET_B),
    MENU_B.toLowerCase(),
    STOCK_B.toLowerCase(),
    SOP_B.toLowerCase(),
  ];
}

const hasAny = (reply: Reply, markers: string[]) => {
  const text = reply.raw.toLowerCase();
  return markers.filter((marker) => text.includes(marker));
};

type Observed = {
  tool: string;
  variant: string;
  reply: Reply;
};

/** Calls every read tool of the catalog with every variant. */
async function sweep(token: string): Promise<Observed[]> {
  const seen: Observed[] = [];
  for (const tool of READ_TOOLS) {
    const variants = OUTLET_TOOL_CODES.has(tool.code)
      ? VARIANTS
      : [{ label: "no outlet input", outletIds: undefined }];
    for (const variant of variants)
      seen.push({
        tool: tool.code,
        variant: variant.label,
        reply: await callTool(
          token,
          tool.name,
          argsFor(tool.code, variant.outletIds),
        ),
      });
  }
  return seen;
}

let tokens: { wide: string; outlet: string; elevated: string };
let stationIssue: { token: string | null; error: string | null };
let wideSweep: Observed[] = [];

const describeReply = (o: Observed) =>
  `${o.tool} [${o.variant}] -> ${o.reply.status} ${errorCodeOf(o.reply) ?? (denied(o.reply) ? "denied" : "data")}`;

/** No successful reply may carry an outlet B marker. */
function leaksOf(seen: Observed[]): string[] {
  return seen
    .filter((o) => !denied(o.reply) && hasAny(o.reply, bMarkers()).length > 0)
    .map(
      (o) =>
        `${describeReply(o)} leaked ${hasAny(o.reply, bMarkers()).join(",")}`,
    );
}

/** A refusal for bad arguments proves nothing about scope. */
function invalidInputs(seen: Observed[]): string[] {
  return seen
    .filter((o) => errorCodeOf(o.reply) === "INVALID_INPUT")
    .map(describeReply);
}

beforeAll(async () => {
  admin = await newOwner("Admin MCP scope");
  await resetGovernance(admin);
  const name = await ownerPool.query<{ name: string }>(
    "SELECT name FROM outlets WHERE id = $1",
    [outletB],
  );
  outletBName = name.rows[0]!.name;
  await seedData();
  await seedSops();

  // Tenant-wide control: owner + purchasing + marketing at tenant scope.
  wide = await signedIn("Pengguna lebar scope");
  for (const key of ["owner", "purchasing", "marketing"] as const)
    await grantTemplateRole(wide.userId, key, { type: "tenant" });

  // Outlet-A only: every manager-ish template at outlet A, nothing else.
  outletUser = await signedIn("Pengguna outlet A scope");
  for (const key of [
    "outlet_manager",
    "kitchen_lead",
    "warehouse",
    "employee",
  ] as const)
    await grantTemplateRole(outletUser.userId, key, {
      type: "outlet",
      id: outletA,
    });

  stationId = await createStation();
  // Station-only, the shape the product allows: barista_cook at a station of outlet A.
  stationUser = await signedIn("Pengguna stasiun scope");
  await grantAtStation(stationUser.userId, "barista_cook", stationId);
  // Station-only, forced: the same templates as outlet A, but assigned at STATION scope.
  stationElevatedUser = await signedIn("Pengguna stasiun elevated scope");
  for (const key of [
    "outlet_manager",
    "kitchen_lead",
    "warehouse",
    "employee",
  ] as const)
    await grantAtStation(stationElevatedUser.userId, key, stationId);

  const clientId = await approvedClient();
  tokens = {
    wide: await tokenFor(wide, clientId),
    outlet: await tokenFor(outletUser, clientId),
    elevated: await tokenFor(stationElevatedUser, clientId),
  };
  stationIssue = await tryToken(stationUser, clientId);
  wideSweep = await sweep(tokens.wide);
}, 120_000);

afterAll(async () => {
  await resetGovernance(admin).catch(() => undefined);
  for (const user of [wide, outletUser, stationUser, stationElevatedUser])
    if (user) await removeAssignments(user.userId).catch(() => undefined);
  await cleanupAcceptance().catch(() => undefined);
  await asTenant((db) =>
    db.query(
      "DELETE FROM sop_documents WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, sopIds],
    ),
  ).catch(() => undefined);
  await asTenant((db) =>
    db.query("DELETE FROM stations WHERE tenant_id = $1 AND id = ANY($2)", [
      tenantId,
      stationIds,
    ]),
  ).catch(() => undefined);
  await ownerPool.end();
});

describe("legend-cot3 ai mcp scope: positive control (tenant-wide principal)", () => {
  it("legend-cot3 ai mcp scope: the sweep arguments are valid for every read tool", () => {
    expect(READ_TOOLS.length).toBeGreaterThanOrEqual(12);
    expect(invalidInputs(wideSweep)).toEqual([]);
  });

  it("legend-cot3 ai mcp scope: tenant-wide principal reads outlet B data on the same calls", () => {
    const find = (code: string, variant: string) =>
      wideSweep.find((o) => o.tool === code && o.variant === variant)!;
    const asked = find("TL-01", "outlet B");
    expect(denied(asked.reply), describeReply(asked)).toBe(false);
    expect(hasAny(asked.reply, [String(NET_B)])).toHaveLength(1);
    // Every seeded tool shows an outlet B marker when asked for B.
    const unseen = SEEDED_CODES.filter((code) => {
      const o = find(code, "outlet B");
      return denied(o.reply) || hasAny(o.reply, bMarkers()).length === 0;
    });
    expect(
      unseen,
      "seeded tools that did not show outlet B to the owner",
    ).toEqual([]);
    // No filter: both outlets.
    const all = find("TL-01", "no outlet filter");
    expect(hasAny(all.reply, [String(NET_B), String(NET_A)])).toHaveLength(2);
    // SOP search: the tenant-wide SOP and the outlet-B station SOP.
    const sop = find("TL-10", "no outlet input");
    expect(denied(sop.reply), describeReply(sop)).toBe(false);
    expect(
      hasAny(sop.reply, [SOP_GLOBAL.toLowerCase(), SOP_B.toLowerCase()]),
    ).toHaveLength(2);
  });
});

describe("AIG-01 MCP tenant boundary", () => {
  it("AIG-01 an unfiltered MCP SOP search returns this tenant's document and excludes a matching document in another tenant", async () => {
    const marker = `mcp${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const localSop = randomUUID();
    const localTitle = `Prosedur ${marker} Lokal`;
    const foreignTenant = randomUUID();
    const foreignSop = randomUUID();
    const foreignTitle = `Prosedur ${marker} Rahasia Tenant`;
    const db = await ownerPool.connect();
    let committed = false;
    const cleanup = async () => {
      if (!committed) await db.query("ROLLBACK");
      await db.query("BEGIN");
      try {
        await db.query("SELECT set_config('app.tenant_id', $1, true)", [
          foreignTenant,
        ]);
        await db.query(
          "DELETE FROM sop_documents WHERE id = $1 AND tenant_id = $2",
          [foreignSop, foreignTenant],
        );
        await db.query("DELETE FROM tenants WHERE id = $1", [foreignTenant]);
        await db.query("SELECT set_config('app.tenant_id', $1, true)", [
          tenantId,
        ]);
        await db.query(
          "DELETE FROM sop_documents WHERE id = $1 AND tenant_id = $2",
          [localSop, tenantId],
        );
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      } finally {
        db.release();
      }
    };
    try {
      await db.query("BEGIN");
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantId,
      ]);
      await db.query(
        `INSERT INTO sop_documents (id, tenant_id, lineage_id, version, station_id,
           title, body, requires_acknowledgement, effective_from, published_by)
         VALUES ($1, $2, $1, 1, NULL, $3, $5, false, '2026-01-01', $4)`,
        [localSop, tenantId, localTitle, admin.userId, localTitle],
      );
      await db.query(
        `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
         SELECT $1, $2, 'MCP isolation foreign tenant', plan, status, deployment_mode, feature_flags, limits, created_by
           FROM tenants WHERE id = $3`,
        [foreignTenant, `mcp-isolation-${foreignTenant}`, tenantId],
      );
      await db.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [foreignTenant],
      );
      const inserted = await db.query(
        `INSERT INTO sop_documents (id, tenant_id, lineage_id, version, station_id,
           title, body, requires_acknowledgement, effective_from, published_by)
         VALUES ($1, $2, $1, 1, NULL, $3, $5, false, '2026-01-01', $4)`,
        [foreignSop, foreignTenant, foreignTitle, admin.userId, foreignTitle],
      );
      expect(inserted.rowCount).toBe(1);
      // Both matching documents are committed before the API's separate connection reads.
      await db.query("COMMIT");
      committed = true;

      const reply = await callTool(tokens.wide, "search_sop", {
        query: marker,
        limit: 10,
      });
      expect(denied(reply), reply.raw).toBe(false);
      expect(errorCodeOf(reply)).not.toBe("INVALID_INPUT");
      expect(hasAny(reply, [localTitle.toLowerCase()])).toHaveLength(1);
      expect(hasAny(reply, [foreignSop, foreignTitle.toLowerCase()])).toEqual(
        [],
      );
    } finally {
      await cleanup();
    }
  });
});

describe("legend-cot3 ai mcp scope: outlet-A principal", () => {
  it("legend-cot3 ai mcp scope: control, the principal reads its own outlet A", async () => {
    const names = await toolNames(tokens.outlet);
    expect(names).toContain("get_sales_summary");
    const sales = await callTool(
      tokens.outlet,
      "get_sales_summary",
      argsFor("TL-01", [outletA]),
    );
    expect(denied(sales), sales.raw).toBe(false);
    expect(hasAny(sales, [String(NET_A)])).toHaveLength(1);
    expect(hasAny(sales, bMarkers())).toEqual([]);
    const menu = await callTool(
      tokens.outlet,
      "get_menu_performance",
      argsFor("TL-02", [outletA]),
    );
    expect(denied(menu), menu.raw).toBe(false);
    expect(hasAny(menu, [MENU_A.toLowerCase()])).toHaveLength(1);
    const stock = await callTool(
      tokens.outlet,
      "get_stock_levels",
      argsFor("TL-03", [outletA]),
    );
    expect(denied(stock), stock.raw).toBe(false);
    expect(hasAny(stock, [STOCK_A.toLowerCase()])).toHaveLength(1);
  });

  it("AIG-01 legend-cot3 ai mcp scope: every read tool aimed at outlet B, both outlets or no outlet never shows outlet B", async () => {
    const seen = await sweep(tokens.outlet);
    expect(invalidInputs(seen)).toEqual([]);
    expect(leaksOf(seen)).toEqual([]);
    // Naming outlet B explicitly is refused, not silently narrowed. TL-05 and
    // TL-08 are refused earlier by the MCP MFA gate, so for them this checks the
    // gate only (see the file header).
    const asked = seen.filter(
      (o) => OUTLET_TOOL_CODES.has(o.tool) && o.variant !== "no outlet filter",
    );
    const answered = asked.filter((o) => !denied(o.reply)).map(describeReply);
    expect(answered, "calls naming outlet B that were answered").toEqual([]);
  });

  it("AIG-01 legend-cot3 ai mcp scope: sales without an outlet filter cover outlet A only", async () => {
    const sales = await callTool(
      tokens.outlet,
      "get_sales_summary",
      argsFor("TL-01"),
    );
    expect(denied(sales), sales.raw).toBe(false);
    expect(hasAny(sales, [String(NET_A)])).toHaveLength(1);
    expect(hasAny(sales, bMarkers())).toEqual([]);
  });
});

describe("legend-cot3 ai mcp scope: station-only principal (barista_cook at a station of outlet A)", () => {
  it("legend-cot3 ai mcp scope: control, the outlet-A principal gets a token with the same request", () => {
    expect(tokens.outlet).toBeTruthy();
    expect(tokens.wide).toBeTruthy();
  });

  it("legend-cot3 ai mcp scope: no token is issued, so no read tool is reachable", () => {
    expect(
      stationIssue.token,
      "token issued to a station-only user",
    ).toBeNull();
    expect(stationIssue.error).toBeTruthy();
  });
});

describe("legend-cot3 ai mcp scope: station-only principal holding outlet templates at station scope", () => {
  it("legend-cot3 ai mcp scope: control, the token works and the tenant-wide principal reads the same calls", async () => {
    const list = await call(tokens.elevated, "tools/list");
    expect(list.status).toBe(200);
    const control = wideSweep.find(
      (o) => o.tool === "TL-01" && o.variant === "no outlet filter",
    )!;
    expect(denied(control.reply), describeReply(control)).toBe(false);
  });

  it("AIG-01 legend-cot3 ai mcp scope: station scope never answers an outlet-reading tool (no outlet B, no outlet A, no tenant)", async () => {
    const seen = await sweep(tokens.elevated);
    expect(invalidInputs(seen)).toEqual([]);
    expect(leaksOf(seen)).toEqual([]);
    // Every tool except the self-only ones is refused: outlet tools and
    // tenant-level tools (finance, customers, SOP search) alike.
    const answered = seen
      .filter((o) => !SELF_TOOL_CODES.has(o.tool) && !denied(o.reply))
      .map(describeReply);
    expect(answered, "non-self tools answered at station scope").toEqual([]);
    const tenantSop = seen.filter(
      (o) =>
        !denied(o.reply) && hasAny(o.reply, [SOP_GLOBAL.toLowerCase()]).length,
    );
    expect(tenantSop.map(describeReply)).toEqual([]);
  });
});
