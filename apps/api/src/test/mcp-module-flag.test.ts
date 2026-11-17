// MCP module flag (bead legend-hbuq3, WS-12). Written from the card text and the
// MCP/OAuth wire format the existing suites already use, never from the
// implementation.
//
// Rule under test: a tenant whose `feature_flags.modules` lacks `mcp` has MCP
// closed, and ONLY MCP (Tanya AI keeps working). Closed means every MCP entry
// point refuses: JSON-RPC (tools/list, tools/call, initialize, ping), OAuth
// discovery/authorize/token/registration, and the consent/client-grant admin
// routes. The refusal never tells a caller whether the tenant, the module or
// the tool exists. Turning the module on again restores everything; another
// tenant is never touched.
//
// ASSUMPTIONS (also in the report):
//  - The module key is "mcp" in `feature_flags.modules`, edited through plain
//    SQL (no endpoint toggles it), exactly like `ai_assistant` in
//    ai-platform-lock.test.ts. The test sets the flag itself in both
//    directions, so it does not depend on the seed value (fixtures.ts:103).
//  - "Same shape as unknown": a closed tenant answers a VALID bearer token the
//    way the server answers an UNRECOGNISED bearer token (same status and same
//    body, volatile ids ignored). tools/list, tools/call on a real tool and
//    tools/call on a made-up tool are identical to each other as well. The
//    body names no module, no tenant, no "disabled".
//  - Host-based OAuth endpoints (discovery, authorize, token, registration)
//    answer a 4xx and hand out no code, token or endpoint list.
//  - Admin routes that GRANT MCP access (create client, approve client,
//    consent preview, consent approve) are refused with 403 or 404. Reads and
//    revocation (GET lists, revoke) are NOT asserted: removal of access may
//    stay open, as under the ai_assistant lock.
//  - Re-enabling restores access for a token issued before the flag went off
//    (the flag never touches stored tokens).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { McpScope } from "@starter/shared/ai";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { seedTenantRoleTemplates } from "../services/access.service.ts";
import { settleActionRequest } from "../services/ai-action-request.service.ts";
import { writeTools } from "../services/ai-tools/write/index.ts";
import {
  loadTenantAccess,
  resolveAccessSnapshot,
} from "../services/permission-resolver.ts";
import {
  app,
  availabilityFingerprint,
  cleanupAcceptance,
  created,
  createMenuItem,
  grantTemplateRole,
  outletA,
  signedIn,
  newOwner,
  originHeader,
  ownerPool,
  patchGovernance,
  resetGovernance,
  tenantHost,
  tenantId,
  type Actor,
} from "./ai-acceptance-helpers.ts";
import {
  createIsolatedTenant,
  owner as floorPool,
  seededTenantId,
} from "./floor-test-helpers.ts";
import { agent, signUp, verifySessionMfa } from "./helpers.ts";

const MCP_PATH = "/mcp";
const METADATA_PATH = "/.well-known/oauth-authorization-server";
const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
const REDIRECT_URI = "http://localhost:8123/callback";
const MCP_SCOPES: McpScope[] = ["mcp:sales:read", "mcp:menu:read"];
const SALES_ARGS = {
  period: { from: "2026-10-01", to: "2026-10-07" },
  groupBy: "day",
};
/** A bearer value the server never issued. */
const UNKNOWN_TOKEN = `mcp_unissued_${randomBytes(24).toString("hex")}`;

type Tenant = { host: string; id: string; admin: Actor; token: string };

let primaryModules: string[] = [];
let primary: Tenant;
let other: Tenant;
let otherModules: string[] = [];

// ---- Module flag (plain SQL, like ai-platform-lock.test.ts) -------------------

async function setModules(id: string, modules: string[]) {
  await floorPool.query(
    `UPDATE tenants SET feature_flags = jsonb_set(feature_flags, '{modules}', $2::jsonb) WHERE id = $1`,
    [id, JSON.stringify(modules)],
  );
}
const withMcp = (modules: string[]) => [...new Set([...modules, "mcp"])];
const withoutMcp = (modules: string[]) => modules.filter((m) => m !== "mcp");
const mcpOn = () => setModules(tenantId, withMcp(primaryModules));
const mcpOff = () => setModules(tenantId, withoutMcp(primaryModules));

// ---- JSON-RPC over HTTP ---------------------------------------------------------

type Reply = { status: number; body: unknown; raw: string };

async function rpc(
  token: string,
  method: string,
  params?: object,
): Promise<Reply> {
  const res = await request(app)
    .post(MCP_PATH)
    .set("Accept", "application/json, text/event-stream")
    .set("Content-Type", "application/json")
    .set("Authorization", `Bearer ${token}`)
    .send({ jsonrpc: "2.0", id: 1, method, params });
  return fold(res);
}

async function plainVerb(verb: "get" | "delete", token: string) {
  const agent = request(app);
  const pending = verb === "get" ? agent.get(MCP_PATH) : agent.delete(MCP_PATH);
  const res = await pending
    .set("Accept", "application/json, text/event-stream")
    .set("Authorization", `Bearer ${token}`);
  return fold(res);
}

function fold(res: request.Response): Reply {
  let body: unknown = res.body;
  if (!body || (typeof body === "object" && Object.keys(body).length === 0)) {
    const data = (res.text ?? "")
      .split("\n")
      .find((line) => line.startsWith("data:"));
    try {
      body = JSON.parse(data ? data.slice(5).trim() : (res.text ?? ""));
    } catch {
      body = res.text ?? "";
    }
  }
  return {
    status: res.status,
    body,
    raw: `${res.text ?? ""}${JSON.stringify(res.body ?? "")}`,
  };
}

const VOLATILE = new Set(["requestId", "reqId", "request_id", "traceId"]);
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !VOLATILE.has(key))
        .map(([key, v]) => [key, stable(v)]),
    );
  return value;
}
const shape = (reply: Reply) => ({
  status: reply.status,
  body: stable(reply.body),
});

/** Words a refusal must not contain: it would tell a caller what exists. */
const LEAKS = /module|modul|feature|flag|disabled|dinonaktif|AI_PLATFORM/i;

function expectRefusedLikeUnknown(reply: Reply, unknown: Reply, what: string) {
  expect(reply.status, `${what}: ${reply.raw}`).toBeGreaterThanOrEqual(400);
  expect(reply.status, `${what}: no server error`).toBeLessThan(500);
  expect(reply.raw, `${what}: leaks`).not.toMatch(LEAKS);
  expect(shape(reply), `${what}: same shape as unknown`).toEqual(
    shape(unknown),
  );
}

// ---- OAuth helpers (host-based, black box) ----------------------------------------

const pathOf = (url: string) => new URL(url, "http://localhost").pathname;
const hostAgent = (host: string) => agent(app).set("Host", host);

async function metadataOf(host: string): Promise<Record<string, string>> {
  const res = await hostAgent(host).get(METADATA_PATH);
  expect(res.status, `discovery while on: ${res.text}`).toBe(200);
  return res.body as Record<string, string>;
}

async function registerApprovedClient(who: Actor) {
  const clientId = `flag-${randomUUID().slice(0, 12)}`;
  const reg = await who.client
    .post("/api/ai/mcp-clients")
    .set(originHeader)
    .send({
      name: `Klien modul ${clientId}`,
      clientId,
      redirectUris: [REDIRECT_URI],
      allowedScopes: MCP_SCOPES,
    });
  expect(reg.status, reg.text).toBe(201);
  const ok = await who.client
    .post(`/api/ai/mcp-clients/${reg.body.data.id as string}/approve`)
    .set(originHeader)
    .send({});
  expect(ok.status, ok.text).toBe(200);
  return clientId;
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
};

/** GET authorize (-> consent) then POST consent. Returns a code or why not. */
async function authorize(
  who: Actor,
  host: string,
  clientId: string,
  challenge: string,
) {
  const meta = await metadataOfIfOpen(host);
  const res = await who.client
    .get(meta ? pathOf(meta.authorization_endpoint!) : "/oauth/authorize")
    .query({
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      scope: MCP_SCOPES.join(" "),
      state: randomUUID(),
      code_challenge: challenge,
      code_challenge_method: "S256",
    })
    .redirects(0);
  const location = res.headers.location as string | undefined;
  if (res.status < 300 || res.status >= 400 || !location)
    return { code: null, error: `http_${res.status}` };
  const url = new URL(location, REDIRECT_URI);
  if (url.pathname !== "/mcp/consent")
    return {
      code: url.searchParams.get("code"),
      error: url.searchParams.get("error") ?? "",
    };
  const approve = await who.client
    .post("/api/ai/mcp/authorize")
    .set(originHeader)
    .send({
      ...Object.fromEntries(url.searchParams.entries()),
      approve: true,
    });
  if (approve.status === 200 && approve.body?.redirectTo) {
    const back = new URL(approve.body.redirectTo as string, REDIRECT_URI);
    return {
      code: back.searchParams.get("code"),
      error: back.searchParams.get("error") ?? "",
    };
  }
  return { code: null, error: `consent_http_${approve.status}` };
}

/** The discovery document, or null when the host answers no 200 (closed). */
async function metadataOfIfOpen(host: string) {
  const res = await hostAgent(host).get(METADATA_PATH);
  return res.status === 200 ? (res.body as Record<string, string>) : null;
}

async function exchange(
  host: string,
  clientId: string,
  code: string,
  verifier: string,
  tokenEndpoint: string,
) {
  return hostAgent(host).post(tokenEndpoint).type("form").send({
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
    code,
    client_id: clientId,
    code_verifier: verifier,
  });
}

async function issueToken(who: Actor, host: string): Promise<string> {
  const clientId = await registerApprovedClient(who);
  const { verifier, challenge } = pkce();
  const auth = await authorize(who, host, clientId, challenge);
  expect(auth.code, `authorize while on: ${auth.error}`).toBeTruthy();
  const meta = await metadataOf(host);
  const res = await exchange(
    host,
    clientId,
    auth.code!,
    verifier,
    pathOf(meta.token_endpoint!),
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.access_token as string;
}

// ---- Fixtures: a second, independent tenant ---------------------------------------

async function createOtherTenant(): Promise<Tenant> {
  const isolated = await createIsolatedTenant(
    `mcpf-${randomUUID().slice(0, 8)}`,
  );
  await floorPool.query(
    "UPDATE tenants t SET feature_flags=s.feature_flags,limits=s.limits,created_by=s.created_by FROM tenants s WHERE t.id=$1 AND s.id=$2",
    [isolated.tenantId, seededTenantId],
  );
  await withTenant(
    db,
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: isolated.tenantId,
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    ),
    (tx) => seedTenantRoleTemplates(tx, isolated.tenantId),
  );
  const client = agent(app);
  const email = await signUp(client, "Pemilik modul MCP lain");
  client.set("Host", isolated.hostname);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  created.users.push(userId);
  await verifySessionMfa(email);
  const roleId = randomUUID();
  const c = await ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT set_config('app.tenant_id',$1,true),set_config('app.outlet_ids','*',true)",
      [isolated.tenantId],
    );
    await c.query(
      "INSERT INTO role_assignments (tenant_id,user_id,role_id,scope_type,scope_id,valid_from,assigned_by) SELECT $1,$2,id,'tenant',NULL,now()-interval '1 minute',$2 FROM roles WHERE tenant_id=$1 AND is_template AND template_key='owner'",
      [isolated.tenantId, userId],
    );
    await c.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, 'MCP flag owner', false, $3, '["tenant"]')`,
      [
        roleId,
        isolated.tenantId,
        JSON.stringify([
          "ai.ask",
          "ai.governance.manage",
          "mcp.client.manage",
          "report.sales.view",
          "menu.item.view",
        ]),
      ],
    );
    await c.query(
      `INSERT INTO role_assignments (tenant_id,user_id,role_id,scope_type,scope_id,valid_from,assigned_by)
       VALUES ($1,$2,$3,'tenant',NULL,now()-interval '1 minute',$2)`,
      [isolated.tenantId, userId, roleId],
    );
    await c.query("COMMIT");
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
  const admin: Actor = { client, email, userId };
  const governed = await client
    .patch("/api/ai/governance")
    .set(originHeader)
    .send({ aiEnabled: true, mcpEnabled: true });
  expect(governed.status, governed.text).toBe(200);
  return { host: isolated.hostname, id: isolated.tenantId, admin, token: "" };
}

// ---- Lifecycle -----------------------------------------------------------------------

beforeAll(async () => {
  const flags = await floorPool.query<{ modules: string[] }>(
    "SELECT feature_flags->'modules' AS modules FROM tenants WHERE id = $1",
    [tenantId],
  );
  primaryModules = flags.rows[0]!.modules;
  expect(primaryModules, "fixture tenant has Tanya AI").toContain(
    "ai_assistant",
  );
  await mcpOn();
  const admin = await newOwner("Admin modul MCP");
  await resetGovernance(admin);
  primary = { host: tenantHost, id: tenantId, admin, token: "" };
  primary.token = await issueToken(admin, tenantHost);

  other = await createOtherTenant();
  otherModules = (
    await floorPool.query<{ modules: string[] }>(
      "SELECT feature_flags->'modules' AS modules FROM tenants WHERE id = $1",
      [other.id],
    )
  ).rows[0]!.modules;
  await setModules(other.id, withMcp(otherModules));
  other.token = await issueToken(other.admin, other.host);
}, 120_000);

beforeEach(async () => {
  await mcpOn();
  await setModules(other.id, withMcp(otherModules));
  await resetGovernance(primary.admin);
}, 30_000);

afterAll(async () => {
  await setModules(tenantId, primaryModules).catch(() => undefined);
  await resetGovernance(primary.admin).catch(() => undefined);
  await cleanupAcceptance().catch(() => undefined);
  await ownerPool.end();
});

// ---- (1) Module on: the controls ---------------------------------------------------

describe("legend-hbuq3 (1) mcp module on", () => {
  it("serves discovery, tools/list and tools/call", async () => {
    const meta = await hostAgent(primary.host).get(METADATA_PATH);
    expect(meta.status).toBe(200);
    expect(meta.body.authorization_endpoint).toBeTruthy();
    const resource = await hostAgent(primary.host).get(PROTECTED_RESOURCE_PATH);
    expect(resource.status).toBe(200);

    const list = await rpc(primary.token, "tools/list");
    expect(list.status, list.raw).toBe(200);
    const tools = (list.body as { result?: { tools?: { name: string }[] } })
      .result?.tools;
    expect((tools ?? []).length).toBeGreaterThan(0);

    const call = await rpc(primary.token, "tools/call", {
      name: "get_sales_summary",
      arguments: SALES_ARGS,
    });
    expect(call.status, call.raw).toBe(200);
    expect((call.body as { error?: unknown }).error).toBeUndefined();
  });
});

// ---- (2) Module off: JSON-RPC ----------------------------------------------------------

describe("legend-hbuq3 (2) mcp module off: JSON-RPC", () => {
  it("tools/list is refused exactly like an unrecognised token", async () => {
    expect((await rpc(primary.token, "tools/list")).status).toBe(200);
    await mcpOff();
    const unknown = await rpc(UNKNOWN_TOKEN, "tools/list");
    expect(unknown.status, "unknown token is refused").toBeGreaterThanOrEqual(
      400,
    );
    expectRefusedLikeUnknown(
      await rpc(primary.token, "tools/list"),
      unknown,
      "tools/list",
    );
  });

  it("tools/call is refused and says nothing about the tool: real, made-up and unauthorised tool answer alike", async () => {
    expect(
      (
        await rpc(primary.token, "tools/call", {
          name: "get_sales_summary",
          arguments: SALES_ARGS,
        })
      ).status,
    ).toBe(200);
    await mcpOff();
    const unknown = await rpc(UNKNOWN_TOKEN, "tools/call", {
      name: "get_sales_summary",
      arguments: SALES_ARGS,
    });
    const real = await rpc(primary.token, "tools/call", {
      name: "get_sales_summary",
      arguments: SALES_ARGS,
    });
    const madeUp = await rpc(primary.token, "tools/call", {
      name: "drop_all_tables",
      arguments: {},
    });
    expectRefusedLikeUnknown(real, unknown, "tools/call real tool");
    expectRefusedLikeUnknown(madeUp, unknown, "tools/call made-up tool");
    expect(shape(real), "real and made-up tool are indistinguishable").toEqual(
      shape(madeUp),
    );
    expect(real.raw, "no data came back").not.toMatch(
      /netSales|totalNet|rows/i,
    );
  });

  it("initialize and ping are refused like an unrecognised token", async () => {
    await mcpOff();
    const init = {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "uji", version: "1" },
    };
    for (const [method, params] of [
      ["initialize", init],
      ["ping", undefined],
      ["resources/list", undefined],
    ] as const) {
      expectRefusedLikeUnknown(
        await rpc(primary.token, method, params),
        await rpc(UNKNOWN_TOKEN, method, params),
        method,
      );
    }
  });

  it("GET and DELETE on the endpoint never answer 2xx and match an unrecognised token", async () => {
    await mcpOff();
    for (const verb of ["get", "delete"] as const) {
      const closed = await plainVerb(verb, primary.token);
      expect(closed.status, `${verb}: ${closed.raw}`).toBeGreaterThanOrEqual(
        400,
      );
      expect(shape(closed), verb).toEqual(
        shape(await plainVerb(verb, UNKNOWN_TOKEN)),
      );
    }
  });
});

// ---- (3) Module off: OAuth ----------------------------------------------------------------

describe("legend-hbuq3 (3) mcp module off: OAuth", () => {
  it("discovery documents answer a 4xx and list no endpoints", async () => {
    await mcpOff();
    for (const path of [METADATA_PATH, PROTECTED_RESOURCE_PATH]) {
      const res = await hostAgent(primary.host).get(path);
      expect(res.status, `${path}: ${res.text}`).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.text).not.toMatch(
        /authorization_endpoint|token_endpoint|registration_endpoint/,
      );
    }
  });

  it("authorize gives no code", async () => {
    const meta = await metadataOf(primary.host);
    const authorizePath = pathOf(meta.authorization_endpoint!);
    const clientId = await registerApprovedClient(primary.admin);
    await mcpOff();
    const { challenge } = pkce();
    const res = await primary.admin.client
      .get(authorizePath)
      .query({
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        scope: MCP_SCOPES.join(" "),
        state: randomUUID(),
        code_challenge: challenge,
        code_challenge_method: "S256",
      })
      .redirects(0);
    const location = res.headers.location as string | undefined;
    if (res.status >= 300 && res.status < 400 && location) {
      const url = new URL(location, REDIRECT_URI);
      expect(url.pathname, "no consent screen for a closed tenant").not.toBe(
        "/mcp/consent",
      );
      expect(url.searchParams.get("code")).toBeNull();
    } else {
      expect(res.status, res.text).toBeGreaterThanOrEqual(400);
    }
  });

  it("the token endpoint refuses a code issued before the flag went off and hands out no token", async () => {
    const meta = await metadataOf(primary.host);
    const tokenPath = pathOf(meta.token_endpoint!);
    const clientId = await registerApprovedClient(primary.admin);
    const { verifier, challenge } = pkce();
    const auth = await authorize(
      primary.admin,
      primary.host,
      clientId,
      challenge,
    );
    expect(auth.code, `authorize while on: ${auth.error}`).toBeTruthy();
    await mcpOff();
    const res = await exchange(
      primary.host,
      clientId,
      auth.code!,
      verifier,
      tokenPath,
    );
    expect(res.status, res.text).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.text).not.toContain("access_token");
  });

  it("dynamic client registration is refused and returns no client", async () => {
    expect(
      (
        await patchGovernance(primary.admin, {
          dynamicClientRegistrationEnabled: true,
        })
      ).status,
    ).toBe(200);
    const meta = await metadataOf(primary.host);
    const registerPath = pathOf(meta.registration_endpoint!);
    const body = (name: string) => ({
      client_name: name,
      redirect_uris: [REDIRECT_URI],
      scope: "mcp:sales:read",
      token_endpoint_auth_method: "none",
    });
    const control = await hostAgent(primary.host)
      .post(registerPath)
      .send(body("Klien dinamis terbuka"));
    expect(control.status, control.text).toBeLessThan(300);
    await mcpOff();
    const closed = await hostAgent(primary.host)
      .post(registerPath)
      .send(body("Klien dinamis tertutup"));
    expect(closed.status, closed.text).toBeGreaterThanOrEqual(400);
    expect(closed.status).toBeLessThan(500);
    expect(closed.text).not.toContain("client_id");
  });
});

// ---- (4) Module off: admin routes that grant MCP access ------------------------------------

describe("legend-hbuq3 (4) mcp module off: grant routes", () => {
  const refused = (status: number) => [403, 404].includes(status);

  it("creating and approving a client is refused and no client appears", async () => {
    const pendingId = await (async () => {
      const clientId = `flag-${randomUUID().slice(0, 12)}`;
      const reg = await primary.admin.client
        .post("/api/ai/mcp-clients")
        .set(originHeader)
        .send({
          name: `Klien tertunda ${clientId}`,
          clientId,
          redirectUris: [REDIRECT_URI],
          allowedScopes: MCP_SCOPES,
        });
      expect(reg.status, reg.text).toBe(201);
      return { id: reg.body.data.id as string };
    })();
    await mcpOff();
    const clientId = `flag-${randomUUID().slice(0, 12)}`;
    const create = await primary.admin.client
      .post("/api/ai/mcp-clients")
      .set(originHeader)
      .send({
        name: `Klien tertutup ${clientId}`,
        clientId,
        redirectUris: [REDIRECT_URI],
        allowedScopes: MCP_SCOPES,
      });
    expect(refused(create.status), create.text).toBe(true);
    const approve = await primary.admin.client
      .post(`/api/ai/mcp-clients/${pendingId.id}/approve`)
      .set(originHeader)
      .send({});
    expect(refused(approve.status), approve.text).toBe(true);

    await mcpOn();
    const listed = await primary.admin.client
      .get("/api/ai/mcp-clients")
      .query({ status: "pending" });
    expect(listed.status, listed.text).toBe(200);
    const rows = listed.body.data as { id: string; clientId: string }[];
    expect(
      rows.some((r) => r.clientId === clientId),
      "no client created",
    ).toBe(false);
    expect(
      rows.some((r) => r.id === pendingId.id),
      "the pending client stayed pending",
    ).toBe(true);
  });

  it("the consent preview and consent approval are refused", async () => {
    const clientId = await registerApprovedClient(primary.admin);
    await mcpOff();
    const preview = await primary.admin.client
      .get("/api/ai/mcp/authorize/preview")
      .query({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: MCP_SCOPES.join(" "),
      });
    expect(refused(preview.status), preview.text).toBe(true);
    const { challenge } = pkce();
    const consent = await primary.admin.client
      .post("/api/ai/mcp/authorize")
      .set(originHeader)
      .send({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: MCP_SCOPES.join(" "),
        state: randomUUID(),
        code_challenge: challenge,
        code_challenge_method: "S256",
        approve: true,
      });
    expect(refused(consent.status), consent.text).toBe(true);
    expect(consent.text).not.toContain("redirectTo");
  });
});

// ---- (5) Only MCP closes, re-enabling, other tenants ------------------------------------------

describe("legend-hbuq3 (5) scope of the flag", () => {
  it("Tanya AI is not locked by the mcp flag", async () => {
    await mcpOff();
    const governance = await primary.admin.client.get("/api/ai/governance");
    expect(governance.status, governance.text).toBe(200);
    expect(governance.body.data.platformLocked).toBe(false);
    const patched = await patchGovernance(primary.admin, {
      monthlyBudgetIdr: 123_000_000,
    });
    expect(patched.status, patched.text).toBe(200);
  });

  it("turning the module back on restores a token issued before", async () => {
    expect((await rpc(primary.token, "tools/list")).status).toBe(200);
    await mcpOff();
    expect(
      (await rpc(primary.token, "tools/list")).status,
    ).toBeGreaterThanOrEqual(400);
    await mcpOn();
    const list = await rpc(primary.token, "tools/list");
    expect(list.status, list.raw).toBe(200);
    const call = await rpc(primary.token, "tools/call", {
      name: "get_sales_summary",
      arguments: SALES_ARGS,
    });
    expect(call.status, call.raw).toBe(200);
    expect((await hostAgent(primary.host).get(METADATA_PATH)).status).toBe(200);
  });

  it("another tenant keeps full MCP while this one is off", async () => {
    await mcpOff();
    expect(
      (await rpc(primary.token, "tools/list")).status,
      "primary closed",
    ).toBeGreaterThanOrEqual(400);

    expect((await hostAgent(other.host).get(METADATA_PATH)).status).toBe(200);
    const list = await rpc(other.token, "tools/list");
    expect(list.status, list.raw).toBe(200);
    const call = await rpc(other.token, "tools/call", {
      name: "get_sales_summary",
      arguments: SALES_ARGS,
    });
    expect(call.status, call.raw).toBe(200);
    // A fresh connection on the other tenant still completes OAuth.
    const clientId = await registerApprovedClient(other.admin);
    const { challenge } = pkce();
    const auth = await authorize(other.admin, other.host, clientId, challenge);
    expect(auth.code, auth.error).toBeTruthy();
  });

  it("closing the other tenant does not close this one", async () => {
    await setModules(other.id, withoutMcp(otherModules));
    expect(
      (await rpc(other.token, "tools/list")).status,
      "other closed",
    ).toBeGreaterThanOrEqual(400);
    const list = await rpc(primary.token, "tools/list");
    expect(list.status, list.raw).toBe(200);
  });

  it("the flag is read live: it closes and opens MCP without a restart or a new login", async () => {
    for (const on of [false, true, false, true]) {
      await (on ? mcpOn() : mcpOff());
      const list = await rpc(primary.token, "tools/list");
      if (on) expect(list.status, list.raw).toBe(200);
      else expect(list.status, list.raw).toBeGreaterThanOrEqual(400);
    }
  });
});

// ---- (5) Approved MCP action: the module is re-checked at execution ------------------

describe("legend-hbuq3 (5) approved MCP action under a closed module", () => {
  const workerContext = establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

  /** An approved, not yet executed MCP-sourced write action plus its data fingerprint. */
  async function approvedMcpAction() {
    const owner = await newOwner();
    const menuItemId = await createMenuItem(owner);
    const requester = await signedIn("Agen MCP modul");
    await grantTemplateRole(requester.userId, "kitchen_lead", {
      type: "outlet",
      id: outletA,
    });
    const approver = await signedIn("Manajer MCP modul");
    await grantTemplateRole(approver.userId, "outlet_manager", {
      type: "outlet",
      id: outletA,
    });
    const clientId = `flag-${randomUUID().slice(0, 12)}`;
    const reg = await primary.admin.client
      .post("/api/ai/mcp-clients")
      .set(originHeader)
      .send({
        name: `Klien aksi ${clientId}`,
        clientId,
        redirectUris: [REDIRECT_URI],
        allowedScopes: MCP_SCOPES,
      });
    expect(reg.status, reg.text).toBe(201);
    const mcpClientId = reg.body.data.id as string;
    const ok = await primary.admin.client
      .post(`/api/ai/mcp-clients/${mcpClientId}/approve`)
      .set(originHeader)
      .send({});
    expect(ok.status, ok.text).toBe(200);
    // The requester holds a live token of that client (checked at execution).
    const raw = `mcp_${randomBytes(24).toString("hex")}`;
    const conn = await ownerPool.connect();
    try {
      await conn.query("BEGIN");
      await conn.query(
        "SELECT set_config('app.tenant_id',$1,true),set_config('app.outlet_ids','*',true)",
        [tenantId],
      );
      await conn.query(
        `INSERT INTO mcp_tokens (tenant_id, mcp_client_id, user_id, token_hash, token_prefix, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + interval '1 hour')`,
        [
          tenantId,
          mcpClientId,
          requester.userId,
          createHash("sha256").update(raw).digest("hex"),
          raw.slice(0, 12),
          MCP_SCOPES,
        ],
      );
      await conn.query("COMMIT");
    } catch (error) {
      await conn.query("ROLLBACK");
      throw error;
    } finally {
      conn.release();
    }
    const tenant = establishTenantContext({
      tenantId,
      brandId: null,
      source: "session",
    });
    const data = await loadTenantAccess(workerContext, requester.userId);
    const access = resolveAccessSnapshot({
      tenant,
      userId: requester.userId,
      ...data,
      mfaVerified: true,
      now: new Date(),
    });
    const before = await availabilityFingerprint(menuItemId);
    const receipt = (await writeTools["TL-18"]!(
      { access, channel: "mcp", mcpClientId, now: new Date() },
      {
        outletId: outletA,
        items: [{ menuItemId, available: false }],
        reason: "Bahan habis (agen MCP)",
      },
    )) as { actionRequestId: string; approvalRequestId: string };
    const decision = await approver.client
      .post(`/api/approvals/${receipt.approvalRequestId}/decisions`)
      .set(originHeader)
      .send({ decision: "approved", reason: "Disetujui manajer" });
    expect(decision.status, decision.text).toBe(200);
    return { ...receipt, menuItemId, before };
  }

  const reasonOf = async (id: string) =>
    (
      await ownerPool.query<{ status: string; failure_reason: string | null }>(
        "SELECT status, failure_reason FROM action_requests WHERE id = $1",
        [id],
      )
    ).rows[0]!;

  it("control: module on, the approved MCP action executes", async () => {
    const action = await approvedMcpAction();
    expect(
      await settleActionRequest(workerContext, action.actionRequestId),
    ).toBe("executed");
    expect(await availabilityFingerprint(action.menuItemId)).not.toBe(
      action.before,
    );
  }, 60_000);

  it("module removed after approval: the action is refused and does not run", async () => {
    const action = await approvedMcpAction();
    await mcpOff();
    expect(
      await settleActionRequest(workerContext, action.actionRequestId),
    ).toBe("failed");
    expect(await availabilityFingerprint(action.menuItemId)).toBe(
      action.before,
    );
    const row = await reasonOf(action.actionRequestId);
    expect(row.status).toBe("failed");
    expect(row.failure_reason).toMatch(/MCP/);
  }, 60_000);
});
