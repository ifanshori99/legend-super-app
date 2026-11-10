// MCP consent preview (WS-12 part M, MCP-05): GET /api/ai/mcp/authorize/preview.
// Runs the real Express app and PostgreSQL through the acceptance helpers.
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  MCP_SCOPE_LABELS_ID,
  mcpAuthorizePreviewSchema,
  type McpScope,
} from "@starter/shared/ai";
import {
  app,
  cleanupAcceptance,
  grantCustomRole,
  grantTemplateRole,
  newOwner,
  originHeader,
  outletA,
  ownerPool,
  resetGovernance,
  signedIn,
  type Actor,
} from "./ai-acceptance-helpers.ts";

const REDIRECT_URI = "http://localhost:8123/callback";
const PATH = "/api/ai/mcp/authorize/preview";
let admin: Actor;
let clientId: string;

async function approvedClient(scopes: McpScope[]): Promise<string> {
  const id = `prev-${randomUUID().slice(0, 12)}`;
  const reg = await admin.client
    .post("/api/ai/mcp-clients")
    .set(originHeader)
    .send({
      name: `Klien pratinjau ${id}`,
      clientId: id,
      redirectUris: [REDIRECT_URI],
      allowedScopes: scopes,
    });
  expect(reg.status).toBe(201);
  const ok = await admin.client
    .post(`/api/ai/mcp-clients/${reg.body.data.id}/approve`)
    .set(originHeader)
    .send({});
  expect(ok.status).toBe(200);
  return id;
}

beforeAll(async () => {
  admin = await newOwner("Admin Pratinjau");
  await resetGovernance(admin);
  clientId = await approvedClient(["mcp:sop:read", "mcp:sales:read"]);
});
beforeEach(async () => {
  await resetGovernance(admin);
});
afterAll(async () => {
  await resetGovernance(admin).catch(() => undefined);
  await cleanupAcceptance().catch(() => undefined);
  await ownerPool.end();
});

const query = (extra: Record<string, string> = {}) => ({
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  scope: "mcp:sop:read mcp:sales:read",
  ...extra,
});

describe("MCP-05 consent preview", () => {
  it("needs a session", async () => {
    const res = await request(app).get(PATH).query(query());
    expect(res.status).toBe(401);
  });

  it("names the client and cuts the scopes to what the user's role allows", async () => {
    const employee = await signedIn("Karyawan Pratinjau");
    await grantTemplateRole(employee.userId, "employee", {
      type: "outlet",
      id: outletA,
    });
    const res = await employee.client.get(PATH).query(query());
    expect(res.status).toBe(200);
    const preview = mcpAuthorizePreviewSchema.parse(res.body.data);
    expect(preview.clientName).toContain("Klien pratinjau");
    expect(preview.redirectUri).toBe(REDIRECT_URI);
    expect(preview.scopes.map((s) => s.scope)).toEqual(["mcp:sop:read"]);
    expect(preview.scopes[0]!.label).toBe(MCP_SCOPE_LABELS_ID["mcp:sop:read"]);
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  it("offers every approved scope the user may use when none is requested", async () => {
    const employee = await signedIn("Karyawan Tanpa Cakupan");
    await grantTemplateRole(employee.userId, "employee", {
      type: "outlet",
      id: outletA,
    });
    const res = await employee.client
      .get(PATH)
      .query({ client_id: clientId, redirect_uri: REDIRECT_URI });
    expect(res.status).toBe(200);
    const scopes = mcpAuthorizePreviewSchema
      .parse(res.body.data)
      .scopes.map((s) => s.scope);
    expect(scopes).toEqual(["mcp:sop:read"]);
  });

  it("refuses an unregistered redirect_uri, an unknown client and a user without ai.ask", async () => {
    const employee = await signedIn("Karyawan Ditolak");
    await grantTemplateRole(employee.userId, "employee", {
      type: "outlet",
      id: outletA,
    });
    const badRedirect = await employee.client
      .get(PATH)
      .query(query({ redirect_uri: "https://evil.example/cb" }));
    expect(badRedirect.status).toBe(400);
    expect(badRedirect.body.error.code).toBe("invalid_request");

    const unknown = await employee.client
      .get(PATH)
      .query(query({ client_id: "does-not-exist" }));
    expect(unknown.status).toBe(400);

    const noAsk = await signedIn("Tanpa AI Pratinjau");
    await grantCustomRole(noAsk.userId, ["menu.item.view"], {
      type: "tenant",
    });
    const denied = await noAsk.client.get(PATH).query(query());
    expect(denied.status).toBe(400);
    expect(denied.body.error.code).toBe("access_denied");
  });

  it("rejects unknown query parameters", async () => {
    const res = await admin.client.get(PATH).query(query({ extra: "x" }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
