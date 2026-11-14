// WS-12 MCP server acceptance (PRD v1.7 §3 Fitur 39 and 40; MCP-01..05, AIG-01,
// AIG-03). Written from the PRD and the shared contract only (@starter/shared/ai
// endpoints, scopes, errors, events). Runs the real Express app and PostgreSQL.
//
// Every describe is named "[wave 2: M ...]": the MCP server is part M. They are
// expected to fail until it lands.
//
// ASSUMPTIONS (also in the report). The contract leaves the OAuth and transport
// URLs open ("issuing happens in the OAuth flow, outside this contract"):
//  - MCP_PATH "/mcp": Streamable HTTP, JSON-RPC 2.0 over POST (bead legend-xkbt).
//    The reply may be plain JSON or one SSE `data:` event; both are parsed.
//  - OAuth endpoints are discovered from RFC 8414 metadata at
//    /.well-known/oauth-authorization-server (authorization_endpoint,
//    token_endpoint, and registration_endpoint only while dynamic registration
//    is on).
//  - GET authorization_endpoint with a signed-in session and an approved client
//    answers 302 to redirect_uri?code=...&state=... (consent is implicit once
//    the tenant admin approved the client). A refusal is either a 302 carrying
//    `error=` or a 4xx; no `code` either way.
//  - Token endpoint takes form fields and answers JSON
//    { access_token, token_type, expires_in, scope } (RFC 6749).
//  - A client registered by an admin through POST /api/ai/mcp-clients starts
//    `pending` until approved (MCP-05).
//  - Errors: the AiError code appears somewhere in the response body (JSON-RPC
//    error data, tool result text, or HTTP body). Auth failures are HTTP 401.
//  - Revocation and role changes take effect within 60 s (MCP-02), so those
//    checks poll within 60 s instead of expecting an instant effect.
//  - maxRowsPerResponse caps the rows of every tool output, search_sop's
//    `results` included.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  actionRequestReceiptSchema,
  actionRequestSchema,
  aiToolInvokedEventPayloadSchema,
  getActionRequestStatusOutputSchema,
  mcpClientSchema,
  mcpTokenIssuedEventPayloadSchema,
  searchSopOutputSchema,
  type McpScope,
} from "@starter/shared/ai";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createSopDocument } from "../services/hris-sop.service.ts";
import {
  app,
  asTenant,
  availabilityFingerprint,
  cleanupAcceptance,
  createMenuItem,
  grantCustomRole,
  grantTemplateRole,
  newOwner,
  originHeader,
  outboxEvents,
  outletA,
  ownerPool,
  patchGovernance,
  pollUntil,
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
const REVOCATION_WINDOW_MS = 60_000;

const ALLOWED: McpScope[] = [
  "mcp:sales:read",
  "mcp:sop:read",
  "mcp:menu:draft",
  "mcp:actions:read",
  "mcp:menu:read",
];

let admin: Actor;

// ---- Protocol helpers -----------------------------------------------------

type Rpc = { result?: RpcResult; error?: unknown };
type RpcResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
  tools?: {
    name: string;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  }[];
  resources?: { uri: string }[];
  contents?: unknown[];
  protocolVersion?: string;
  capabilities?: { tools?: unknown };
};
type Reply = {
  status: number;
  headers: Record<string, string>;
  rpc: Rpc;
  raw: string;
};

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
  token: string | null,
  method: string,
  params?: Record<string, unknown>,
): Promise<Reply> {
  const req = request(app)
    .post(MCP_PATH)
    .set("Accept", "application/json, text/event-stream")
    .set("Content-Type", "application/json");
  if (token) req.set("Authorization", `Bearer ${token}`);
  const res = await req.send({ jsonrpc: "2.0", id: 1, method, params });
  return {
    status: res.status,
    headers: res.headers as Record<string, string>,
    rpc: parseRpc(res),
    raw: `${res.text ?? ""}${JSON.stringify(res.body ?? "")}`,
  };
}

const callTool = (token: string, name: string, args: Record<string, unknown>) =>
  call(token, "tools/call", { name, arguments: args });

async function toolNames(token: string): Promise<string[]> {
  const reply = await call(token, "tools/list");
  expect(reply.status).toBe(200);
  return (reply.rpc.result!.tools! as { name: string }[]).map((t) => t.name);
}

/** Structured output of a successful tools/call, else null. */
function outputOf(reply: Reply): unknown {
  const result = reply.rpc.result;
  if (reply.status !== 200 || !result || result.isError) return null;
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find(
    (c: { type: string }) => c.type === "text",
  )?.text;
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

const denied = (reply: Reply) =>
  reply.status >= 400 ||
  reply.rpc.error !== undefined ||
  reply.rpc.result?.isError === true;

// ---- OAuth helpers --------------------------------------------------------

async function metadata(): Promise<Record<string, string>> {
  const res = await tenantAgent().get(METADATA_PATH);
  expect(res.status, "RFC 8414 metadata").toBe(200);
  return res.body;
}
const pathOf = (url: string) => new URL(url, "http://localhost").pathname;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

type Authorized = {
  code: string | null;
  error: string | null;
  status: number;
  state: string | null;
};

function readRedirect(location: string, status: number): Authorized {
  const url = new URL(location, REDIRECT_URI);
  return {
    code: url.searchParams.get("code"),
    error: url.searchParams.get("error")
      ? `${url.searchParams.get("error")}: ${url.searchParams.get("error_description") ?? ""}`
      : null,
    state: url.searchParams.get("state"),
    status,
  };
}

/**
 * The real flow: GET authorization_endpoint validates and sends the browser to
 * the consent screen (`/mcp/consent?...`, never a code); the consent screen
 * then posts the same parameters with `approve: true` under the user's own
 * session to POST /api/ai/mcp/authorize, which answers `{ redirectTo }`.
 */
async function authorize(
  user: Actor,
  params: Record<string, string | undefined>,
): Promise<Authorized> {
  const meta = await metadata();
  const query = Object.fromEntries(
    Object.entries({
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      ...params,
    }).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
  const res = await user.client
    .get(pathOf(meta.authorization_endpoint!))
    .query(query)
    .redirects(0);
  if (res.status >= 300 && res.status < 400 && res.headers.location) {
    const location = res.headers.location as string;
    if (new URL(location, REDIRECT_URI).pathname !== "/mcp/consent")
      return readRedirect(location, res.status); // a refusal sent to the client
    const consent = new URL(location, REDIRECT_URI).searchParams;
    const approve = await user.client
      .post("/api/ai/mcp/authorize")
      .set(originHeader)
      .send({
        ...Object.fromEntries(consent.entries()),
        approve: true,
      });
    if (approve.status === 200 && approve.body?.redirectTo)
      return readRedirect(approve.body.redirectTo as string, approve.status);
    return {
      code: null,
      error:
        (approve.body?.error?.code as string | undefined) ??
        `http_${approve.status}`,
      state: null,
      status: approve.status,
    };
  }
  return {
    code: null,
    error: (res.body?.error as string | undefined) ?? `http_${res.status}`,
    state: null,
    status: res.status,
  };
}

async function exchange(fields: Record<string, string>) {
  const meta = await metadata();
  return tenantAgent()
    .post(pathOf(meta.token_endpoint!))
    .type("form")
    .send({
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      ...fields,
    });
}

// ---- Clients and tokens -----------------------------------------------------

type ClientRec = { id: string; clientId: string };

async function registerClient(
  scopes: McpScope[] = ALLOWED,
  actor: Actor = admin,
): Promise<{ res: request.Response; rec: ClientRec }> {
  const clientId = `acc-${randomUUID().slice(0, 12)}`;
  const res = await actor.client
    .post("/api/ai/mcp-clients")
    .set(originHeader)
    .send({
      name: `Klien uji ${clientId}`,
      clientId,
      redirectUris: [REDIRECT_URI],
      allowedScopes: scopes,
    });
  return { res, rec: { id: res.body?.data?.id as string, clientId } };
}

async function approvedClient(
  scopes: McpScope[] = ALLOWED,
): Promise<ClientRec> {
  const { res, rec } = await registerClient(scopes);
  expect(res.status).toBe(201);
  const approve = await admin.client
    .post(`/api/ai/mcp-clients/${rec.id}/approve`)
    .set(originHeader)
    .send({});
  expect(approve.status).toBe(200);
  return rec;
}

type Issued = {
  token: string;
  prefix: string;
  expiresIn: number;
  scope: string;
};

async function connect(
  user: Actor,
  client: ClientRec,
  scopes: McpScope[],
): Promise<Issued> {
  const { verifier, challenge } = pkce();
  const state = randomUUID();
  const auth = await authorize(user, {
    client_id: client.clientId,
    scope: scopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  expect(auth.error, "authorize error").toBeNull();
  expect(auth.code, "authorization code").toBeTruthy();
  expect(auth.state).toBe(state);
  const res = await exchange({
    code: auth.code!,
    client_id: client.clientId,
    code_verifier: verifier,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const token = res.body.access_token as string;
  return {
    token,
    prefix: token.slice(0, 12),
    expiresIn: res.body.expires_in as number,
    scope: res.body.scope as string,
  };
}

const POWER_PERMISSIONS = [
  "ai.ask",
  "ai.action.propose",
  "report.sales.view",
  "menu.item.view",
  "menu.availability.toggle",
];

async function powerUser(name = "Pengguna MCP"): Promise<Actor> {
  const user = await signedIn(name);
  await grantCustomRole(user.userId, POWER_PERMISSIONS, { type: "tenant" });
  // TL-10 (search_sop) needs a template role that holds self.sop.read.
  await grantTemplateRole(user.userId, "employee", {
    type: "outlet",
    id: outletA,
  });
  // Sales and menu tools follow the catalog minRoles: a custom role is not enough.
  await grantTemplateRole(user.userId, "outlet_manager", {
    type: "outlet",
    id: outletA,
  });
  await grantTemplateRole(user.userId, "kitchen_lead", {
    type: "outlet",
    id: outletA,
  });
  return user;
}

const sopReaderEmployeeIds: string[] = [];

/**
 * A plain employee (own outlet A) for search_sop calls. TL-10 reads HRIS data,
 * so an MCP caller whose role requires MFA is refused (a token has no second
 * factor): the SOP tests must not use a user who also holds a manager role.
 */
async function sopReader(name: string): Promise<Actor> {
  const user = await signedIn(name);
  await grantTemplateRole(user.userId, "employee", {
    type: "outlet",
    id: outletA,
  });
  const id = randomUUID();
  sopReaderEmployeeIds.push(id);
  await asTenant((db) =>
    db.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan SOP MCP', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenantId,
        user.userId,
        `MCP-${id.slice(0, 8).toUpperCase()}`,
        outletA,
      ],
    ),
  );
  return user;
}

async function seedSops(term: string, count: number): Promise<string> {
  const hr = await signedIn("HR MCP");
  await grantCustomRole(hr.userId, ["hr.sop.manage"], { type: "tenant" });
  const scope = establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
  for (let i = 0; i < count; i++)
    await createSopDocument(scope, hr.userId, {
      title: `Prosedur ${term} nomor ${"x".repeat(i + 1)}`,
      body: `Langkah kerja ${term} untuk shift pagi.`,
      mediaIds: [],
      requiresAcknowledgement: false,
      effectiveFrom: "2026-01-01",
      stationId: null,
      positionId: null,
    } as never);
  return hr.userId;
}

async function tokenRowId(user: Actor, issued: Issued): Promise<string> {
  const list = await user.client
    .get("/api/ai/mcp-tokens")
    .query({ includeInactive: "true" });
  expect(list.status).toBe(200);
  const row = (list.body.data as { id: string; tokenPrefix: string }[]).find(
    (t) => t.tokenPrefix === issued.prefix,
  );
  expect(row, "token is listed by prefix").toBeDefined();
  return row!.id;
}

beforeAll(async () => {
  admin = await newOwner("Admin MCP");
  await resetGovernance(admin);
});

beforeEach(async () => {
  await resetGovernance(admin);
});

afterAll(async () => {
  await resetGovernance(admin).catch(() => undefined);
  await asTenant((db) =>
    db.query("DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2)", [
      tenantId,
      sopReaderEmployeeIds,
    ]),
  ).catch(() => undefined);
  await cleanupAcceptance().catch(() => undefined);
  await ownerPool.end();
});

describe("[wave 2: M] MCP-05 only admin-approved clients get tokens", () => {
  it("MCP-05 a registered client is pending and cannot get a code or token until approved", async () => {
    const { res, rec } = await registerClient();
    expect(res.status).toBe(201);
    expect(mcpClientSchema.parse(res.body.data).status).toBe("pending");

    const user = await powerUser();
    const { verifier, challenge } = pkce();
    const auth = await authorize(user, {
      client_id: rec.clientId,
      scope: "mcp:sop:read",
      state: "s1",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(auth.code).toBeNull();
    expect(auth.error).toBeTruthy();

    const forged = await exchange({
      code: randomBytes(16).toString("hex"),
      client_id: rec.clientId,
      code_verifier: verifier,
    });
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect(forged.body.access_token).toBeUndefined();

    const tokens = await admin.client
      .get("/api/ai/mcp-tokens")
      .query({ scope: "tenant", clientId: rec.id });
    expect(tokens.status).toBe(200);
    expect(tokens.body.data).toEqual([]);
  });

  it("MCP-05 an admin approves, then the same client connects; approval records who approved", async () => {
    const { rec } = await registerClient();
    const approved = await admin.client
      .post(`/api/ai/mcp-clients/${rec.id}/approve`)
      .set(originHeader)
      .send({});
    expect(approved.status).toBe(200);
    const client = mcpClientSchema.parse(approved.body.data);
    expect(client.status).toBe("approved");
    expect(client.approvedBy).toBe(admin.userId);

    const issued = await connect(await powerUser(), rec, ["mcp:sop:read"]);
    expect(issued.token.startsWith("mcp_")).toBe(true);
    expect(issued.scope.split(" ")).toEqual(["mcp:sop:read"]);
  });

  it("MCP-05 only users with mcp.client.manage register, approve or revoke clients", async () => {
    const plain = await powerUser("Bukan Admin");
    const attempt = await registerClient(ALLOWED, plain);
    expect(attempt.res.status).toBe(403);

    const { rec } = await registerClient();
    expect(
      (
        await plain.client
          .post(`/api/ai/mcp-clients/${rec.id}/approve`)
          .set(originHeader)
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await plain.client
          .post(`/api/ai/mcp-clients/${rec.id}/revoke`)
          .set(originHeader)
          .send({ reason: "Tidak berwenang" })
      ).status,
    ).toBe(403);
    expect((await plain.client.get("/api/ai/mcp-clients")).status).toBe(403);

    const listed = await admin.client
      .get("/api/ai/mcp-clients")
      .query({ status: "pending" });
    expect(listed.status).toBe(200);
    expect((listed.body.data as { id: string }[]).map((c) => c.id)).toContain(
      rec.id,
    );
  });

  it("MCP-05 approval can narrow scopes and a token never exceeds them", async () => {
    const { rec } = await registerClient(["mcp:sop:read", "mcp:sales:read"]);
    const approve = await admin.client
      .post(`/api/ai/mcp-clients/${rec.id}/approve`)
      .set(originHeader)
      .send({ allowedScopes: ["mcp:sop:read"] });
    expect(approve.status).toBe(200);
    expect(mcpClientSchema.parse(approve.body.data).allowedScopes).toEqual([
      "mcp:sop:read",
    ]);

    const user = await powerUser();
    const { verifier, challenge } = pkce();
    const auth = await authorize(user, {
      client_id: rec.clientId,
      scope: "mcp:sop:read mcp:sales:read",
      state: "s2",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    if (auth.code) {
      const res = await exchange({
        code: auth.code,
        client_id: rec.clientId,
        code_verifier: verifier,
      });
      expect(res.status).toBe(200);
      expect(String(res.body.scope).split(" ")).not.toContain("mcp:sales:read");
      expect(await toolNames(res.body.access_token)).not.toContain(
        "get_sales_summary",
      );
    } else {
      expect(auth.error).toBeTruthy(); // refusing the over-broad scope is also fine
    }
  });

  it("MCP-05 dynamic client registration is off by default and lands pending when on", async () => {
    const off = await metadata();
    expect(
      off.registration_endpoint,
      "no registration endpoint while off",
    ).toBeUndefined();

    expect(
      (await patchGovernance(admin, { dynamicClientRegistrationEnabled: true }))
        .status,
    ).toBe(200);
    const on = await metadata();
    expect(on.registration_endpoint).toBeTruthy();
    const reg = await tenantAgent()
      .post(pathOf(on.registration_endpoint!))
      .send({
        client_name: "Klien dinamis uji",
        redirect_uris: [REDIRECT_URI],
        scope: "mcp:sop:read",
        token_endpoint_auth_method: "none",
      });
    expect(reg.status).toBeLessThan(300);
    const dynamicId = reg.body.client_id as string;
    expect(dynamicId).toBeTruthy();

    const listed = await admin.client
      .get("/api/ai/mcp-clients")
      .query({ status: "pending" });
    const row = (
      listed.body.data as { clientId: string; registeredVia: string }[]
    ).find((c) => c.clientId === dynamicId);
    expect(row?.registeredVia).toBe("dynamic");

    const { challenge } = pkce();
    const auth = await authorize(await powerUser(), {
      client_id: dynamicId,
      scope: "mcp:sop:read",
      state: "s3",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(auth.code).toBeNull();
  });

  it("MCP-05 revoking a client stops new codes and kills its live tokens", async () => {
    const client = await approvedClient();
    const user = await powerUser();
    const issued = await connect(user, client, ["mcp:sop:read"]);
    expect((await call(issued.token, "tools/list")).status).toBe(200);

    const revoke = await admin.client
      .post(`/api/ai/mcp-clients/${client.id}/revoke`)
      .set(originHeader)
      .send({ reason: "Klien dicurigai" });
    expect(revoke.status).toBe(200);
    expect(mcpClientSchema.parse(revoke.body.data).status).toBe("revoked");

    const { challenge } = pkce();
    const auth = await authorize(user, {
      client_id: client.clientId,
      scope: "mcp:sop:read",
      state: "s4",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(auth.code).toBeNull();

    const after = await pollUntil(
      () => call(issued.token, "tools/list"),
      (r) => r.status >= 400,
      {
        timeoutMs: REVOCATION_WINDOW_MS,
      },
    );
    expect(after.status).toBeGreaterThanOrEqual(400);
    expect(after.raw).toContain("MCP_CLIENT_NOT_APPROVED");
  }, 90_000);
});

describe("[wave 2: M] MCP-05 OAuth 2.1 with PKCE (S256 only)", () => {
  let client: ClientRec;
  let user: Actor;
  beforeAll(async () => {
    client = await approvedClient();
    user = await powerUser("Pengguna PKCE");
  });

  const base = (extra: Record<string, string | undefined>) => ({
    client_id: client.clientId,
    scope: "mcp:sop:read",
    state: "xyz",
    ...extra,
  });

  it("MCP-05 an authorization request without a code challenge is refused", async () => {
    const auth = await authorize(user, base({}));
    expect(auth.code).toBeNull();
    expect(auth.error).toBeTruthy();
  });

  it("MCP-05 the plain challenge method is refused", async () => {
    const { verifier } = pkce();
    const auth = await authorize(
      user,
      base({ code_challenge: verifier, code_challenge_method: "plain" }),
    );
    expect(auth.code).toBeNull();
    expect(auth.error).toBeTruthy();
  });

  it("MCP-05 an unregistered redirect URI is refused", async () => {
    const { challenge } = pkce();
    const auth = await authorize(
      user,
      base({
        code_challenge: challenge,
        code_challenge_method: "S256",
        redirect_uri: "https://evil.example/cb",
      }),
    );
    expect(auth.code).toBeNull();
  });

  it("MCP-05 the code needs the right verifier and works only once", async () => {
    const { verifier, challenge } = pkce();
    const auth = await authorize(
      user,
      base({ code_challenge: challenge, code_challenge_method: "S256" }),
    );
    expect(auth.code).toBeTruthy();

    const wrong = await exchange({
      code: auth.code!,
      client_id: client.clientId,
      code_verifier: randomBytes(32).toString("base64url"),
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(wrong.body.access_token).toBeUndefined();

    const good = await exchange({
      code: auth.code!,
      client_id: client.clientId,
      code_verifier: verifier,
    });
    // A wrong attempt may burn the code (OAuth 2.1 allows it); a right one must not work twice.
    if (good.status === 200) {
      const replay = await exchange({
        code: auth.code!,
        client_id: client.clientId,
        code_verifier: verifier,
      });
      expect(replay.status).toBeGreaterThanOrEqual(400);
      expect(replay.body.access_token).toBeUndefined();
    } else {
      expect(good.status).toBeLessThan(500);
    }
  });

  it("MCP-05 an issued token is short-lived, listed by prefix only, and announced without its value", async () => {
    const startedWith = (await outboxEvents("mcp_token.issued")).length;
    const issued = await connect(user, client, ["mcp:sop:read"]);
    expect(issued.expiresIn).toBeGreaterThan(0);
    expect(issued.expiresIn).toBeLessThanOrEqual(24 * 3600);

    const list = await user.client.get("/api/ai/mcp-tokens");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(issued.token);
    const row = (list.body.data as Record<string, unknown>[]).find(
      (t) => t.tokenPrefix === issued.prefix,
    );
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("tokenHash");

    const events = await pollUntil(
      () => outboxEvents("mcp_token.issued"),
      (rows) => rows.length > startedWith,
      { timeoutMs: 5_000 },
    );
    const event = events.find((e) => e.payload.tokenPrefix === issued.prefix);
    expect(event).toBeDefined();
    mcpTokenIssuedEventPayloadSchema.parse(event!.payload);
    expect(JSON.stringify(event)).not.toContain(issued.token);
  });
});

describe("[wave 2: M] MCP-05 consent: a code is issued only by the user's own approval", () => {
  let client: ClientRec;
  beforeAll(async () => {
    client = await approvedClient();
  });

  const consentQuery = () => {
    const { verifier, challenge } = pkce();
    return {
      verifier,
      query: {
        response_type: "code",
        client_id: client.clientId,
        redirect_uri: REDIRECT_URI,
        scope: "mcp:sop:read",
        state: "consent",
        code_challenge: challenge,
        code_challenge_method: "S256",
      },
    };
  };

  it("MCP-05 GET authorize never returns a code: it sends the browser to the consent screen", async () => {
    const meta = await metadata();
    const user = await powerUser("Pengguna Persetujuan");
    const { query } = consentQuery();
    for (const who of [user.client, tenantAgent()]) {
      const res = await who
        .get(pathOf(meta.authorization_endpoint!))
        .query(query)
        .redirects(0);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.location as string, REDIRECT_URI);
      expect(location.pathname).toBe("/mcp/consent");
      expect(location.searchParams.get("client_id")).toBe(client.clientId);
      expect(location.searchParams.has("code")).toBe(false);
    }
  });

  it("MCP-05 the approval endpoint needs the session, a trusted origin and approve: true", async () => {
    const user = await powerUser("Pengguna Tanpa Setuju");
    const { query } = consentQuery();
    const anonymous = await request(app)
      .post("/api/ai/mcp/authorize")
      .set(originHeader)
      .send({ ...query, approve: true });
    expect(anonymous.status).toBe(401);
    const noOrigin = await user.client
      .post("/api/ai/mcp/authorize")
      .send({ ...query, approve: true });
    expect(noOrigin.status).toBe(403);
    for (const approve of [false, undefined]) {
      const res = await user.client
        .post("/api/ai/mcp/authorize")
        .set(originHeader)
        .send({ ...query, ...(approve === undefined ? {} : { approve }) });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(JSON.stringify(res.body)).not.toContain("code=");
    }
  });

  it("MCP-05 a user without ai.ask or without any role gets no code", async () => {
    const noAsk = await signedIn("Tanpa AI");
    await grantCustomRole(noAsk.userId, ["menu.item.view"], {
      type: "tenant",
    });
    const noRole = await signedIn("Tanpa Peran");
    const { challenge } = pkce();
    for (const user of [noAsk, noRole]) {
      const auth = await authorize(user, {
        client_id: client.clientId,
        scope: "mcp:sop:read",
        state: "denied",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      expect(auth.code).toBeNull();
      expect(auth.error).toBeTruthy();
    }
  });

  it("MCP-05 granted scopes are cut to the tools the user's permissions allow", async () => {
    const employee = await signedIn("Karyawan Cakupan");
    await grantTemplateRole(employee.userId, "employee", {
      type: "outlet",
      id: outletA,
    });
    const issued = await connect(employee, client, [
      "mcp:sales:read",
      "mcp:sop:read",
    ]);
    expect(issued.scope.split(" ")).not.toContain("mcp:sales:read");
    expect(issued.scope.split(" ")).toContain("mcp:sop:read");
  });

  it("MCP-05 turning the tenant AI switch off blocks new codes and live tokens", async () => {
    const user = await powerUser("Pengguna AI Mati");
    const issued = await connect(user, client, ["mcp:sop:read"]);
    expect((await patchGovernance(admin, { aiEnabled: false })).status).toBe(
      200,
    );
    const { challenge } = pkce();
    const auth = await authorize(user, {
      client_id: client.clientId,
      scope: "mcp:sop:read",
      state: "ai-off",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(auth.code).toBeNull();
    const reply = await call(issued.token, "tools/list");
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.status).toBeLessThan(500);
  });
});

describe("[wave 2: M] MCP-01 scopes limit what a token sees and calls", () => {
  let client: ClientRec;
  let power: Actor;
  beforeAll(async () => {
    client = await approvedClient();
    power = await powerUser("Pengguna Scope");
  });

  it("MCP-01 no token, or a bogus one, is refused with 401 and an OAuth challenge", async () => {
    const anonymous = await call(null, "tools/list");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers["www-authenticate"]).toBeTruthy();
    const bogus = await call(
      `mcp_${randomBytes(24).toString("hex")}`,
      "tools/list",
    );
    expect(bogus.status).toBe(401);
  });

  it("MCP-01 initialize answers with the tools capability", async () => {
    const issued = await connect(power, client, ["mcp:sop:read"]);
    const init = await call(issued.token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "acceptance", version: "1.0.0" },
    });
    expect(init.status).toBe(200);
    expect(typeof init.rpc.result!.protocolVersion).toBe("string");
    expect(init.rpc.result!.capabilities!.tools).toBeDefined();
  });

  it("MCP-01 tools/list shows only the tools in the token's scopes, with read/write annotations", async () => {
    const salesOnly = await connect(power, client, ["mcp:sales:read"]);
    expect(await toolNames(salesOnly.token)).toEqual(["get_sales_summary"]);

    const mixed = await connect(power, client, [
      "mcp:sales:read",
      "mcp:sop:read",
      "mcp:menu:draft",
    ]);
    const reply = await call(mixed.token, "tools/list");
    const tools = reply.rpc.result!.tools! as {
      name: string;
      annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
    }[];
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["draft_menu_availability", "get_sales_summary", "search_sop"].sort(),
    );
    const byName = Object.fromEntries(
      tools.map((t) => [t.name, t.annotations]),
    );
    expect(byName.get_sales_summary?.readOnlyHint).toBe(true);
    expect(byName.search_sop?.readOnlyHint).toBe(true);
    expect(byName.draft_menu_availability?.readOnlyHint).toBe(false);
    expect(byName.draft_menu_availability?.destructiveHint).toBe(false);
  });

  it("MCP-01 the user's role caps the token: scope alone never grants a tool", async () => {
    const employee = await signedIn("Karyawan MCP");
    await grantTemplateRole(employee.userId, "employee", {
      type: "outlet",
      id: outletA,
    });
    const issued = await connect(employee, client, [
      "mcp:sales:read",
      "mcp:sop:read",
    ]);
    const names = await toolNames(issued.token);
    expect(names).toContain("search_sop");
    expect(names).not.toContain("get_sales_summary");
    const reply = await callTool(issued.token, "get_sales_summary", {
      period: { from: "2026-10-01", to: "2026-10-07" },
    });
    expect(denied(reply)).toBe(true);
    expect(outputOf(reply)).toBeNull();
  });

  it("MCP-01 calling a tool outside the token's scopes fails with MCP_SCOPE_INSUFFICIENT", async () => {
    const issued = await connect(power, client, ["mcp:sop:read"]);
    const reply = await callTool(issued.token, "get_sales_summary", {
      period: { from: "2026-10-01", to: "2026-10-07" },
    });
    expect(denied(reply)).toBe(true);
    expect(reply.raw).toContain("MCP_SCOPE_INSUFFICIENT");
    expect(outputOf(reply)).toBeNull();

    const unknown = await callTool(issued.token, "drop_all_tables", {});
    expect(denied(unknown)).toBe(true);
    expect(unknown.status).toBeLessThan(500);
  });

  it("MCP-01 a tool in scope runs, and bad input is rejected without a server error", async () => {
    const term = `kopimcp${randomBytes(4).toString("hex")}`;
    await seedSops(term, 1);
    const issued = await connect(await sopReader("Pembaca SOP"), client, [
      "mcp:sop:read",
    ]);
    const ok = await callTool(issued.token, "search_sop", { query: term });
    const out = searchSopOutputSchema.parse(outputOf(ok));
    expect(out.results.length).toBe(1);
    expect(out.results[0]!.title).toContain(term);

    const bad = await callTool(issued.token, "search_sop", {
      query: "x",
      limit: 999,
      extra: true,
    });
    expect(denied(bad)).toBe(true);
    expect(bad.status).toBeLessThan(500);
  });

  it("MCP-01 resources (metric definitions, data dictionary, SOP) are listed and readable", async () => {
    const issued = await connect(power, client, ["mcp:sop:read"]);
    const list = await call(issued.token, "resources/list");
    expect(list.status).toBe(200);
    const resources = list.rpc.result!.resources! as { uri: string }[];
    expect(resources.length).toBeGreaterThan(0);
    const read = await call(issued.token, "resources/read", {
      uri: resources[0]!.uri,
    });
    expect(read.status).toBe(200);
    expect(read.rpc.result!.contents!.length).toBeGreaterThan(0);
  });
});

describe("[wave 2: M] MCP-02 revocation takes effect within 60 seconds", () => {
  let client: ClientRec;
  beforeAll(async () => {
    client = await approvedClient();
  });

  it("MCP-02 a revoked token stops working (MCP_TOKEN_REVOKED) and others are unaffected", async () => {
    const user = await powerUser("Pemilik Token");
    const bystander = await powerUser("Pengguna Lain");
    const issued = await connect(user, client, ["mcp:sop:read"]);
    const other = await connect(bystander, client, ["mcp:sop:read"]);
    expect((await call(issued.token, "tools/list")).status).toBe(200);

    // Only the owner or an admin may revoke it.
    const tokenId = await tokenRowId(user, issued);
    const stranger = await bystander.client
      .post(`/api/ai/mcp-tokens/${tokenId}/revoke`)
      .set(originHeader)
      .send({ reason: "Bukan token saya" });
    expect([403, 404]).toContain(stranger.status);
    expect((await call(issued.token, "tools/list")).status).toBe(200);

    const revokedAt = performance.now();
    const revoke = await user.client
      .post(`/api/ai/mcp-tokens/${tokenId}/revoke`)
      .set(originHeader)
      .send({ reason: "Laptop hilang" });
    expect(revoke.status).toBe(200);
    expect(revoke.body.data.revokedAt).not.toBeNull();

    const after = await pollUntil(
      () => call(issued.token, "tools/list"),
      (r) => r.status === 401,
      {
        timeoutMs: REVOCATION_WINDOW_MS,
      },
    );
    expect(after.status).toBe(401);
    expect(after.raw).toContain("MCP_TOKEN_REVOKED");
    expect(performance.now() - revokedAt).toBeLessThanOrEqual(
      REVOCATION_WINDOW_MS,
    );
    expect((await call(other.token, "tools/list")).status).toBe(200);
  }, 90_000);

  it("MCP-02 an admin can list and revoke any user's token", async () => {
    const user = await powerUser("Token Dicabut Admin");
    const issued = await connect(user, client, ["mcp:sop:read"]);
    const listed = await admin.client
      .get("/api/ai/mcp-tokens")
      .query({ scope: "tenant" });
    expect(listed.status).toBe(200);
    const row = (
      listed.body.data as { id: string; tokenPrefix: string }[]
    ).find((t) => t.tokenPrefix === issued.prefix);
    expect(row).toBeDefined();
    const revoke = await admin.client
      .post(`/api/ai/mcp-tokens/${row!.id}/revoke`)
      .set(originHeader)
      .send({});
    expect(revoke.status).toBe(200);
    const after = await pollUntil(
      () => call(issued.token, "tools/list"),
      (r) => r.status === 401,
      {
        timeoutMs: REVOCATION_WINDOW_MS,
      },
    );
    expect(after.status).toBe(401);
    // A plain user cannot list the tenant-wide list.
    expect(
      (await user.client.get("/api/ai/mcp-tokens").query({ scope: "tenant" }))
        .status,
    ).toBe(403);
  }, 90_000);

  it("MCP-02 removing the user's role removes their MCP access to that data", async () => {
    const user = await powerUser("Role Dicabut");
    const issued = await connect(user, client, ["mcp:sales:read"]);
    expect(await toolNames(issued.token)).toContain("get_sales_summary");

    const removedAt = performance.now();
    await removeAssignments(user.userId);
    const args = { period: { from: "2026-10-01", to: "2026-10-07" } };
    const after = await pollUntil(
      () => callTool(issued.token, "get_sales_summary", args),
      denied,
      { timeoutMs: REVOCATION_WINDOW_MS },
    );
    expect(denied(after)).toBe(true);
    expect(outputOf(after)).toBeNull();
    expect(performance.now() - removedAt).toBeLessThanOrEqual(
      REVOCATION_WINDOW_MS,
    );
  }, 90_000);

  it("MCP-02 an expired token is refused with MCP_TOKEN_EXPIRED", async () => {
    const user = await powerUser("Token Kedaluwarsa");
    const issued = await connect(user, client, ["mcp:sop:read"]);
    await asTenant((db) =>
      db.query(
        `UPDATE mcp_tokens
            SET created_at = now() - interval '3 hours', expires_at = now() - interval '1 minute'
          WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, user.userId],
      ),
    );
    const after = await pollUntil(
      () => call(issued.token, "tools/list"),
      (r) => r.status === 401,
      {
        timeoutMs: REVOCATION_WINDOW_MS,
      },
    );
    expect(after.status).toBe(401);
    expect(after.raw).toContain("MCP_TOKEN_EXPIRED");
  }, 90_000);
});

describe("[wave 2: M] MCP-03 every tool call is audited", () => {
  it("MCP-03 an allowed and a refused call both leave an audit trail with user, client, tool and outcome", async () => {
    const client = await approvedClient();
    const user = await sopReader("Pengguna Audit");
    const issued = await connect(user, client, ["mcp:sop:read"]);
    const term = `auditmcp${randomBytes(4).toString("hex")}`;
    await seedSops(term, 1);

    expect(
      outputOf(await callTool(issued.token, "search_sop", { query: term })),
    ).not.toBeNull();
    const refused = await callTool(issued.token, "get_sales_summary", {
      period: { from: "2026-10-01", to: "2026-10-07" },
    });
    expect(denied(refused)).toBe(true);

    const events = await pollUntil(
      async () =>
        (await outboxEvents("ai_tool.invoked"))
          .map((e) => aiToolInvokedEventPayloadSchema.parse(e.payload))
          .filter((p) => p.userId === user.userId),
      (rows) =>
        rows.some((r) => r.toolCode === "TL-10") &&
        rows.some((r) => r.toolCode === "TL-01"),
      { timeoutMs: 5_000 },
    );
    expect(events.find((e) => e.toolCode === "TL-10")).toMatchObject({
      channel: "mcp",
      outcome: "ok",
    });
    expect(events.find((e) => e.toolCode === "TL-01")).toMatchObject({
      channel: "mcp",
      outcome: "denied",
    });

    const rows = await asTenant((db) =>
      db.query(
        "SELECT to_jsonb(t) AS row FROM ai_tool_calls t WHERE tenant_id = $1 AND user_id = $2",
        [tenantId, user.userId],
      ),
    );
    const audit = JSON.stringify(rows.rows);
    expect(rows.rowCount).toBeGreaterThanOrEqual(2);
    // Each invocation must carry the full attribution and its own outcome.
    // A client id somewhere in a different row would not prove this criterion.
    for (const [toolCode, status] of [
      ["TL-10", "ok"],
      ["TL-01", "denied"],
    ]) {
      const calls = rows.rows
        .map((record) => record.row as Record<string, unknown>)
        .filter((row) => row.tool_code === toolCode);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        tenant_id: tenantId,
        user_id: user.userId,
        mcp_client_id: client.id,
        tool_code: toolCode,
        channel: "mcp",
        status,
      });
    }
    expect(audit).not.toContain(issued.token);
  });
});

describe("[wave 2: M] MCP limits: rate limit, row cap, kill switches", () => {
  let client: ClientRec;
  beforeAll(async () => {
    client = await approvedClient();
  });

  it("MCP-01 the per-token rate limit answers MCP_RATE_LIMITED and does not touch other tokens", async () => {
    const term = `ratemcp${randomBytes(4).toString("hex")}`;
    await seedSops(term, 1);
    expect(
      (await patchGovernance(admin, { mcpRateLimitPerMinute: 2 })).status,
    ).toBe(200);
    const limited = await connect(await sopReader("Pengguna Cepat"), client, [
      "mcp:sop:read",
    ]);
    const calm = await connect(await sopReader("Pengguna Tenang"), client, [
      "mcp:sop:read",
    ]);

    // A fixed window could split these across two minutes; five calls always
    // exceed two per window, so at least one must be refused.
    const replies: Reply[] = [];
    for (let i = 0; i < 5; i++)
      replies.push(
        await callTool(limited.token, "search_sop", { query: term }),
      );
    expect(replies[0]!.status).toBe(200);
    const refused = replies.filter((r) => r.raw.includes("MCP_RATE_LIMITED"));
    expect(refused.length).toBeGreaterThan(0);
    for (const reply of refused) expect(outputOf(reply)).toBeNull();

    const other = await callTool(calm.token, "search_sop", { query: term });
    expect(outputOf(other)).not.toBeNull();
  });

  it("MCP-01 a response never exceeds the tenant row cap and says it was truncated", async () => {
    const term = `capmcp${randomBytes(4).toString("hex")}`;
    await seedSops(term, 3);
    const issued = await connect(await sopReader("Pengguna Baris"), client, [
      "mcp:sop:read",
    ]);

    const uncapped = searchSopOutputSchema.parse(
      outputOf(
        await callTool(issued.token, "search_sop", { query: term, limit: 5 }),
      ),
    );
    expect(uncapped.results.length).toBe(3);

    expect(
      (await patchGovernance(admin, { maxRowsPerResponse: 1 })).status,
    ).toBe(200);
    const capped = searchSopOutputSchema.parse(
      outputOf(
        await callTool(issued.token, "search_sop", { query: term, limit: 5 }),
      ),
    );
    expect(capped.results.length).toBe(1);
    expect(capped.truncated).toBe(true);
  });

  it("MCP-01 the per-tool kill switch hides the tool and refuses calls with AI_TOOL_DISABLED", async () => {
    const issued = await connect(await powerUser("Pengguna Saklar"), client, [
      "mcp:sop:read",
      "mcp:sales:read",
    ]);
    expect(await toolNames(issued.token)).toContain("search_sop");
    expect(
      (await patchGovernance(admin, { disabledToolCodes: ["TL-10"] })).status,
    ).toBe(200);
    expect(await toolNames(issued.token)).not.toContain("search_sop");
    const reply = await callTool(issued.token, "search_sop", { query: "kopi" });
    expect(denied(reply)).toBe(true);
    expect(reply.raw).toContain("AI_TOOL_DISABLED");
    expect(await toolNames(issued.token)).toContain("get_sales_summary");
  });

  it("MCP-01 turning MCP off for the tenant refuses calls and new connections", async () => {
    const user = await powerUser("Pengguna MCP Mati");
    const issued = await connect(user, client, ["mcp:sop:read"]);
    expect((await patchGovernance(admin, { mcpEnabled: false })).status).toBe(
      200,
    );
    const reply = await call(issued.token, "tools/list");
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.status).toBeLessThan(500);
    const { challenge } = pkce();
    const auth = await authorize(user, {
      client_id: client.clientId,
      scope: "mcp:sop:read",
      state: "off",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(auth.code).toBeNull();
  });
});

describe("[wave 2: M, W] MCP-04 and AIG-03 agents only propose, humans approve", () => {
  it("MCP-04 a draft over MCP is a pending action request; only a different authorised user approves", async () => {
    const owner = await newOwner();
    const menuItemId = await createMenuItem(owner);
    const client = await approvedClient();

    const requester = await signedIn("Agen Kitchen Lead");
    await grantTemplateRole(requester.userId, "kitchen_lead", {
      type: "outlet",
      id: outletA,
    });
    await grantTemplateRole(requester.userId, "outlet_manager", {
      type: "outlet",
      id: outletA,
    });
    const approver = await signedIn("Manajer MCP");
    await grantTemplateRole(approver.userId, "outlet_manager", {
      type: "outlet",
      id: outletA,
    });
    const issued = await connect(requester, client, [
      "mcp:menu:draft",
      "mcp:actions:read",
    ]);
    const before = await availabilityFingerprint(menuItemId);

    const drafted = await callTool(issued.token, "draft_menu_availability", {
      outletId: outletA,
      items: [{ menuItemId, available: false }],
      reason: "Bahan habis (agen)",
    });
    const receipt = actionRequestReceiptSchema.parse(outputOf(drafted));
    expect(receipt.status).toBe("pending");
    expect(await availabilityFingerprint(menuItemId)).toBe(before);

    // The requester sees it in the app, marked as coming from MCP.
    const got = await requester.client.get(
      `/api/ai/action-requests/${receipt.actionRequestId}`,
    );
    expect(got.status).toBe(200);
    const request_ = actionRequestSchema.parse(got.body.data);
    expect(request_.source).toBe("mcp");
    expect(request_.mcpClientId).toBe(client.id);
    expect(request_.status).toBe("pending");

    // The agent can watch the status (TL-19); a stranger cannot.
    const watch = getActionRequestStatusOutputSchema.parse(
      outputOf(
        await callTool(issued.token, "get_action_request_status", {
          actionRequestId: receipt.actionRequestId,
        }),
      ),
    );
    expect(watch.status).toBe("pending");
    const stranger = await signedIn("Penyusup Kitchen Lead");
    await grantTemplateRole(stranger.userId, "kitchen_lead", {
      type: "outlet",
      id: outletA,
    });
    const strangerToken = await connect(stranger, client, ["mcp:actions:read"]);
    const peek = await callTool(
      strangerToken.token,
      "get_action_request_status",
      {
        actionRequestId: receipt.actionRequestId,
      },
    );
    expect(denied(peek)).toBe(true);
    expect(outputOf(peek)).toBeNull();

    // MCP-04: the requester cannot approve it, even holding a manager role.
    const self = await requester.client
      .post(`/api/approvals/${request_.approvalRequestId}/decisions`)
      .set(originHeader)
      .send({ decision: "approved", reason: "Setuju sendiri" });
    expect(self.status).toBeGreaterThanOrEqual(400);
    expect(self.status).toBeLessThan(500);
    expect(await availabilityFingerprint(menuItemId)).toBe(before);

    const decision = await approver.client
      .post(`/api/approvals/${request_.approvalRequestId}/decisions`)
      .set(originHeader)
      .send({ decision: "approved", reason: "Disetujui manajer" });
    expect(decision.status).toBe(200);

    const settled = await pollUntil(
      async () =>
        getActionRequestStatusOutputSchema.parse(
          outputOf(
            await callTool(issued.token, "get_action_request_status", {
              actionRequestId: receipt.actionRequestId,
            }),
          ),
        ),
      (s) => s.status !== "pending",
      { timeoutMs: 30_000, intervalMs: 500 },
    );
    expect(["approved", "executed"]).toContain(settled.status);
    expect(settled.approvalStatus).toBe("approved");
  }, 60_000);

  it("MCP-04 a token without the draft scope cannot create an action request", async () => {
    const owner = await newOwner();
    const menuItemId = await createMenuItem(owner);
    const client = await approvedClient();
    const user = await signedIn("Agen Read-only");
    await grantTemplateRole(user.userId, "kitchen_lead", {
      type: "outlet",
      id: outletA,
    });
    const issued = await connect(user, client, ["mcp:menu:read"]);
    const count = () =>
      ownerPool
        .query(
          "SELECT count(*)::int AS n FROM action_requests WHERE tenant_id = $1",
          [tenantId],
        )
        .then((r) => r.rows[0].n as number);
    const before = await count();
    const reply = await callTool(issued.token, "draft_menu_availability", {
      outletId: outletA,
      items: [{ menuItemId, available: false }],
      reason: "Tanpa scope",
    });
    expect(denied(reply)).toBe(true);
    expect(reply.raw).toContain("MCP_SCOPE_INSUFFICIENT");
    expect(await count()).toBe(before);
  });
});
