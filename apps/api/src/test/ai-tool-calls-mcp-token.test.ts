// Kartu C item 3 (bead legend-39d.4): `ai_tool_calls.mcp_token_id` links every
// MCP tool-call audit row to the token that made it (MCP-03). The table stays
// insert-only for the app role and tenant-isolated by FORCE RLS.
//
// Written from the brief, docs/PRD (MCP-03) and the shared contract
// (aiToolCallRecordSchema already has `mcpTokenId`), not from the
// implementation. Raw SQL as the restricted app role, like ai-db.test.ts, plus
// one HTTP read of the audit list.
//
// ASSUMPTIONS (listed in the report):
//  - Column `ai_tool_calls.mcp_token_id`, uuid, nullable (app-channel calls
//    have no token), referencing mcp_tokens(id).
//  - A row can only reference a token of its OWN tenant (composite FK or an
//    equivalent check): tenant B cannot write a call pointing at tenant A's
//    token. Any database error counts.
//  - The column is part of the insert-only table: the app role may not UPDATE
//    it (not even to NULL) or DELETE rows.
//  - GET /api/ai/tool-calls returns `mcpTokenId` for each record (contract).
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import {
  cleanupAcceptance,
  grantCustomRole,
  ownerPool,
  signedIn,
  tenantId,
  type Actor,
} from "./ai-acceptance-helpers.ts";

// The acceptance helpers sign users into their own AI test tenant.
const tenantA = tenantId;
const tenantB = randomUUID();
const app = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 4,
});

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const rnd = () => randomUUID().replaceAll("-", "");

async function asTenant<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
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

async function failure(
  tenant: string,
  sqlText: string,
  values: unknown[] = [],
): Promise<string> {
  try {
    await asTenant(tenant, (client) => client.query(sqlText, values));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`Expected a failure: ${sqlText}`);
}

type Side = { userId: string; clientRowId: string; tokenId: string };
const sides: Record<string, Side> = {};
const createdUsers: string[] = [];
const callIds: string[] = [];
let admin: Actor;

async function makeSide(tenant: string): Promise<Side> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await ownerPool.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'MCP token audit', $2)`,
    [userId, `${userId}@example.test`],
  );
  const clientRowId = randomUUID();
  await ownerPool.query(
    `INSERT INTO mcp_clients (id, tenant_id, name, client_id, redirect_uris, allowed_scopes, registered_via)
     VALUES ($1, $2, 'Token audit', $3, ARRAY['https://example.test/cb'], ARRAY['mcp:sales:read'], 'admin')`,
    [clientRowId, tenant, `tokaudit-${rnd()}`],
  );
  const tokenId = randomUUID();
  await ownerPool.query(
    `INSERT INTO mcp_tokens (id, tenant_id, mcp_client_id, user_id, token_hash, token_prefix, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'mcp_abcd1234', ARRAY['mcp:sales:read'], now() + interval '1 hour')`,
    [tokenId, tenant, clientRowId, userId, sha(rnd())],
  );
  return { userId, clientRowId, tokenId };
}

const insertCall = (
  tenant: string,
  side: Side,
  tokenId: string | null,
  id = randomUUID(),
) => {
  callIds.push(id);
  return asTenant(tenant, (client) =>
    client.query(
      `INSERT INTO ai_tool_calls (id, tenant_id, tool_code, channel, user_id, mcp_client_id, mcp_token_id, status)
       VALUES ($1, $2, 'TL-01', $3, $4, $5, $6, 'ok')`,
      [
        id,
        tenant,
        tokenId ? "mcp" : "app",
        side.userId,
        tokenId ? side.clientRowId : null,
        tokenId,
      ],
    ),
  );
};

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await ownerPool.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'MCP token audit tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [tenantB, `tokaudit-${tenantB.slice(0, 8)}`, tenantA],
  );
  sides[tenantA] = await makeSide(tenantA);
  sides[tenantB] = await makeSide(tenantB);
  admin = await signedIn("Admin audit token");
  await grantCustomRole(admin.userId, ["ai.governance.manage"], {
    type: "tenant",
  });
});

afterAll(async () => {
  await ownerPool.query(`DELETE FROM ai_tool_calls WHERE id = ANY($1)`, [
    callIds,
  ]);
  const own = Object.values(sides);
  await ownerPool.query(`DELETE FROM mcp_tokens WHERE id = ANY($1)`, [
    own.map((side) => side.tokenId),
  ]);
  await ownerPool.query(`DELETE FROM mcp_clients WHERE id = ANY($1)`, [
    own.map((side) => side.clientRowId),
  ]);
  await ownerPool.query("DELETE FROM roles WHERE tenant_id = $1", [tenantB]);
  await ownerPool.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
  await ownerPool.query(`DELETE FROM "user" WHERE id = ANY($1)`, [
    createdUsers,
  ]);
  await app.end();
  await cleanupAcceptance().catch(() => undefined);
  await ownerPool.end();
});

describe("ai_tool_calls.mcp_token_id (legend-39d.4)", () => {
  it("legend-39d.4 is a nullable uuid column", async () => {
    const { rows } = await ownerPool.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'ai_tool_calls' AND column_name = 'mcp_token_id'`,
    );
    expect(rows).toEqual([{ data_type: "uuid", is_nullable: "YES" }]);
  });

  it("legend-39d.4 stores the token id of an MCP call and accepts an app call without one", async () => {
    const side = sides[tenantA]!;
    const mcpCall = randomUUID();
    const appCall = randomUUID();
    await insertCall(tenantA, side, side.tokenId, mcpCall);
    await insertCall(tenantA, side, null, appCall);
    const { rows } = await asTenant(tenantA, (client) =>
      client.query(
        `SELECT id, mcp_token_id FROM ai_tool_calls WHERE id = ANY($1) ORDER BY channel`,
        [[mcpCall, appCall]],
      ),
    );
    const byId = Object.fromEntries(
      rows.map((row) => [row.id, row.mcp_token_id]),
    );
    expect(byId[mcpCall]).toBe(side.tokenId);
    expect(byId[appCall]).toBeNull();
  });

  it("legend-39d.4 rejects a token id that does not exist", async () => {
    const side = sides[tenantA]!;
    await expect(insertCall(tenantA, side, randomUUID())).rejects.toThrow();
  });

  it("legend-39d.4 rejects a call that points at another tenant's token", async () => {
    // Tenant B writes a call carrying tenant A's token id.
    const foreign = sides[tenantA]!;
    const own = sides[tenantB]!;
    await expect(
      insertCall(tenantB, { ...own }, foreign.tokenId),
    ).rejects.toThrow();
  });

  it("legend-39d.4 keeps RLS: tenant B never sees tenant A's call, with or without the token filter", async () => {
    const side = sides[tenantA]!;
    const id = randomUUID();
    await insertCall(tenantA, side, side.tokenId, id);
    const seen = await asTenant(tenantB, (client) =>
      client.query(
        `SELECT count(*)::int AS n FROM ai_tool_calls WHERE id = $1 OR mcp_token_id = $2`,
        [id, side.tokenId],
      ),
    );
    expect(seen.rows[0].n).toBe(0);
    // And tenant B cannot write a row owned by tenant A.
    const message = await failure(
      tenantB,
      `INSERT INTO ai_tool_calls (id, tenant_id, tool_code, channel, user_id, mcp_client_id, mcp_token_id, status)
       VALUES ($1, $2, 'TL-01', 'mcp', $3, $4, $5, 'ok')`,
      [randomUUID(), tenantA, side.userId, side.clientRowId, side.tokenId],
    );
    expect(message).toMatch(/row-level security|row violates|violates/i);
  });

  it("legend-39d.4 RLS stays enabled and forced on the table", async () => {
    const { rows } = await ownerPool.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'ai_tool_calls'`,
    );
    expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const policies = await ownerPool.query(
      `SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'ai_tool_calls'`,
    );
    expect(policies.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("legend-39d.4 stays insert-only: the app role cannot UPDATE or DELETE, mcp_token_id included", async () => {
    const side = sides[tenantA]!;
    const id = randomUUID();
    await insertCall(tenantA, side, side.tokenId, id);
    for (const statement of [
      "UPDATE ai_tool_calls SET mcp_token_id = NULL WHERE id = $1",
      "UPDATE ai_tool_calls SET mcp_token_id = $2 WHERE id = $1",
      "UPDATE ai_tool_calls SET status = 'error' WHERE id = $1",
      "DELETE FROM ai_tool_calls WHERE id = $1",
    ]) {
      const values = statement.includes("$2")
        ? [id, sides[tenantA]!.tokenId]
        : [id];
      expect(await failure(tenantA, statement, values)).toMatch(
        /permission denied/,
      );
    }
    const still = await asTenant(tenantA, (client) =>
      client.query("SELECT mcp_token_id FROM ai_tool_calls WHERE id = $1", [
        id,
      ]),
    );
    expect(still.rows).toEqual([{ mcp_token_id: side.tokenId }]);
  });

  it("legend-39d.4 GET /api/ai/tool-calls returns the token id of an MCP call", async () => {
    const side = sides[tenantA]!;
    const ulid = createUlid(Date.now());
    const id = ulidToUuid(ulid);
    await ownerPool.query(
      `INSERT INTO ai_tool_calls (id, tenant_id, tool_code, channel, user_id, mcp_client_id, mcp_token_id, status)
       VALUES ($1, $2, 'TL-01', 'mcp', $3, $4, $5, 'ok')`,
      [id, tenantA, side.userId, side.clientRowId, side.tokenId],
    );
    callIds.push(id);
    const res = await admin.client.get(
      `/api/ai/tool-calls?userId=${encodeURIComponent(side.userId)}`,
    );
    expect(res.status).toBe(200);
    const record = (
      res.body.data as { id: string; mcpTokenId: string | null }[]
    ).find((entry) => entry.id === ulid);
    expect(record?.mcpTokenId).toBe(side.tokenId);
  });
});
