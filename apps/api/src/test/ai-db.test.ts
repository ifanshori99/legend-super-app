// Tanya AI / MCP / governance tables against PostgreSQL with the restricted
// app role (RLS enforced): PRD v1.7 §3 Fitur 38/39/40, §6 J; TEN-01/02
// isolation, unique constraints, cascade, append-only audit, the MCP pre-auth
// lookup functions (mcp_tokens / mcp_auth_codes) and the legend-x7u9 role
// template data migration. Beads legend-zfi4, xq8y, zw9r, xkbt, x7u9.
//
// Raw SQL on purpose: this file proves the schema, the policies and the
// migrations, not a service. `owner` (superuser) seeds parents and cleans up;
// `app` is the runtime login (member of legend_app, no BYPASSRLS).
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const tenantB = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const app = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 8,
});

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const rnd = () => randomUUID().replaceAll("-", "");

/** Run `run` as the app role with the tenant RLS settings of `tenant`. */
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

/** Expect the statement to fail (the transaction is rolled back). */
async function rejected(
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

// Parents per tenant, created in beforeAll.
type Parents = {
  userId: string;
  conversationId: string;
  clientRowId: string;
  approvalId: string;
};
const parents: Record<string, Parents> = {};
const createdUsers: string[] = [];

type Fixture = (
  tenant: string,
  p: Parents,
) => { text: string; values: unknown[] };

/** One valid INSERT per new table, parameterised by tenant. */
const fixtures: Record<string, Fixture> = {
  ai_settings: (t, p) => ({
    text: `INSERT INTO ai_settings (tenant_id, updated_by) VALUES ($1, $2)`,
    values: [t, p.userId],
  }),
  ai_usage_events: (t, p) => ({
    text: `INSERT INTO ai_usage_events (tenant_id, user_id, feature, channel, provider, model, status)
           VALUES ($1, $2, 'AI-01', 'tanya_ai', 'fake', 'fake-1', 'ok')`,
    values: [t, p.userId],
  }),
  ai_usage_daily: (t, p) => ({
    text: `INSERT INTO ai_usage_daily (tenant_id, user_id, usage_date, request_count)
           VALUES ($1, $2, '2026-01-15', 1)`,
    values: [t, p.userId],
  }),
  ai_usage_monthly: (t) => ({
    text: `INSERT INTO ai_usage_monthly (tenant_id, usage_month) VALUES ($1, '2026-01')`,
    values: [t],
  }),
  ai_response_cache: (t) => ({
    text: `INSERT INTO ai_response_cache (tenant_id, cache_key, response, expires_at)
           VALUES ($1, $2, '{"a":1}'::jsonb, now() + interval '1 day')`,
    values: [t, rnd()],
  }),
  ai_conversations: (t, p) => ({
    text: `INSERT INTO ai_conversations (tenant_id, owner_user_id, feature, title)
           VALUES ($1, $2, 'AI-01', 'Fixture')`,
    values: [t, p.userId],
  }),
  ai_messages: (t, p) => ({
    text: `INSERT INTO ai_messages (tenant_id, conversation_id, role, content, ai_assisted)
           VALUES ($1, $2, 'assistant', 'hi', true)`,
    values: [t, p.conversationId],
  }),
  ai_tool_calls: (t, p) => ({
    text: `INSERT INTO ai_tool_calls (id, tenant_id, tool_code, channel, user_id, status, conversation_id)
           VALUES ($1, $2, 'TL-01', 'app', $3, 'ok', $4)`,
    values: [randomUUID(), t, p.userId, p.conversationId],
  }),
  action_requests: (t, p) => ({
    text: `INSERT INTO action_requests (tenant_id, tool_code, requested_by_user_id, source, payload,
             approval_request_id, approval_action_type, expires_at)
           VALUES ($1, 'TL-13', $2, 'ai', '{}'::jsonb, $3, 'ai_action', now() + interval '1 day')`,
    values: [t, p.userId, p.approvalId],
  }),
  mcp_clients: (t) => ({
    text: `INSERT INTO mcp_clients (tenant_id, name, client_id, redirect_uris, allowed_scopes, registered_via)
           VALUES ($1, 'Fixture', $2, ARRAY['https://example.test/cb'], ARRAY['mcp:sales:read'], 'admin')`,
    values: [t, `client-${rnd()}`],
  }),
  mcp_tokens: (t, p) => ({
    text: `INSERT INTO mcp_tokens (tenant_id, mcp_client_id, user_id, token_hash, token_prefix, scopes, expires_at)
           VALUES ($1, $2, $3, $4, 'mcp_abcd1234', ARRAY['mcp:sales:read'], now() + interval '1 hour')`,
    values: [t, p.clientRowId, p.userId, sha(rnd())],
  }),
  mcp_auth_codes: (t, p) => ({
    text: `INSERT INTO mcp_auth_codes (tenant_id, mcp_client_id, user_id, code_hash, code_challenge,
             redirect_uri, scopes, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'https://example.test/cb', ARRAY['mcp:sales:read'], now() + interval '5 minutes')`,
    values: [t, p.clientRowId, p.userId, sha(rnd()), "c".repeat(43)],
  }),
};
const TABLES = Object.keys(fixtures);

async function makeUser(): Promise<string> {
  const id = randomUUID();
  createdUsers.push(id);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'AI DB', $2)`,
    [id, `${id}@example.test`],
  );
  return id;
}

async function makeParents(tenant: string): Promise<Parents> {
  const userId = await makeUser();
  const conversationId = randomUUID();
  const clientRowId = randomUUID();
  const approvalId = randomUUID();
  await owner.query(
    `INSERT INTO ai_conversations (id, tenant_id, owner_user_id, feature, title)
     VALUES ($1, $2, $3, 'AI-01', 'Parent')`,
    [conversationId, tenant, userId],
  );
  await owner.query(
    `INSERT INTO mcp_clients (id, tenant_id, name, client_id, redirect_uris, allowed_scopes, registered_via)
     VALUES ($1, $2, 'Parent', $3, ARRAY['https://example.test/cb'], ARRAY['mcp:sales:read'], 'admin')`,
    [clientRowId, tenant, `parent-${rnd()}`],
  );
  await owner.query(
    `INSERT INTO approval_requests (id, tenant_id, chain_id, source_module, action_type, object_type, object_id,
       requested_by, source, level, required_levels, required_steps, request_reason, deadline_at)
     VALUES ($1, $2, $1, 'ai', 'ai_action', 'action_request', $3, $4, 'ai', 1, 1, '[]'::jsonb, 'fixture', now() + interval '1 day')`,
    [approvalId, tenant, randomUUID(), userId],
  );
  return { userId, conversationId, clientRowId, approvalId };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'AI DB tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [tenantB, `ai-db-${tenantB.slice(0, 8)}`, tenantA],
  );
  parents[tenantA] = await makeParents(tenantA);
  parents[tenantB] = await makeParents(tenantB);
});

afterAll(async () => {
  // Children first. The owner is a superuser, so RLS and grants do not apply.
  for (const table of [
    "ai_tool_calls",
    "action_requests",
    "mcp_tokens",
    "mcp_auth_codes",
    "mcp_clients",
    "ai_messages",
    "ai_conversations",
    "ai_response_cache",
    "ai_usage_monthly",
    "ai_usage_daily",
    "ai_usage_events",
    "ai_settings",
  ])
    await owner.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1)`, [
      [tenantA, tenantB],
    ]);
  // Approval requests: only the fixtures made here (tenant A is the shared seed).
  await owner.query("DELETE FROM approval_requests WHERE id = ANY($1)", [
    Object.values(parents).map((p) => p.approvalId),
  ]);
  await owner.query("DELETE FROM roles WHERE tenant_id = $1", [tenantB]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1)`, [createdUsers]);
  await app.end();
  await owner.end();
});

describe("TEN-01/TEN-02 AI tables: tenant isolation", () => {
  for (const table of TABLES) {
    it(`[TEN-01] ${table}: tenant B never sees tenant A's row, and cannot write into tenant A`, async () => {
      const own = fixtures[table]!(tenantA, parents[tenantA]!);
      await asTenant(tenantA, (client) => client.query(own.text, own.values));

      const seenByA = await asTenant(tenantA, (client) =>
        client.query(`SELECT count(*)::int AS n FROM ${table}`),
      );
      expect(seenByA.rows[0].n).toBeGreaterThanOrEqual(1);

      const seenByB = await asTenant(tenantB, (client) =>
        client.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
          [tenantA],
        ),
      );
      expect(seenByB.rows[0].n).toBe(0);

      // TEN-02: a tenant B context cannot insert a row owned by tenant A.
      const attack = fixtures[table]!(tenantA, parents[tenantA]!);
      const message = await rejected(tenantB, attack.text, attack.values);
      expect(message).toMatch(/row-level security|row violates/i);
    });
  }

  it("[TEN-01] a statement without tenant context fails closed on every table", async () => {
    for (const table of TABLES)
      await expect(app.query(`SELECT 1 FROM ${table}`)).rejects.toThrow(
        /tenant context is required/,
      );
  });
});

describe("unique constraints and counters", () => {
  it("one ai_settings row per tenant", async () => {
    const dup = fixtures.ai_settings!(tenantA, parents[tenantA]!);
    expect(await rejected(tenantA, dup.text, dup.values)).toMatch(
      /ai_settings_tenant_key/,
    );
  });

  it("ai_usage_daily is unique per (tenant, user, day); another tenant may reuse the day", async () => {
    const dup = fixtures.ai_usage_daily!(tenantA, parents[tenantA]!);
    expect(await rejected(tenantA, dup.text, dup.values)).toMatch(
      /ai_usage_daily_tenant_user_date_key/,
    );
    const other = fixtures.ai_usage_daily!(tenantB, parents[tenantB]!);
    await asTenant(tenantB, (client) => client.query(other.text, other.values));
  });

  it("ai_usage_monthly and ai_response_cache are unique per tenant", async () => {
    const monthly = fixtures.ai_usage_monthly!(tenantA, parents[tenantA]!);
    expect(await rejected(tenantA, monthly.text, monthly.values)).toMatch(
      /ai_usage_monthly_tenant_month_key/,
    );
    const key = `key-${rnd()}`;
    const insert = `INSERT INTO ai_response_cache (tenant_id, cache_key, response, expires_at)
                    VALUES ($1, $2, '{}'::jsonb, now() + interval '1 day')`;
    await asTenant(tenantA, (client) => client.query(insert, [tenantA, key]));
    expect(await rejected(tenantA, insert, [tenantA, key])).toMatch(
      /ai_response_cache_tenant_key/,
    );
    await asTenant(tenantB, (client) => client.query(insert, [tenantB, key]));
  });

  it("mcp client_id is unique per tenant only; token_hash is unique everywhere", async () => {
    const clientId = `shared-${rnd()}`;
    const insert = `INSERT INTO mcp_clients (tenant_id, name, client_id, redirect_uris, allowed_scopes, registered_via)
                    VALUES ($1, 'Dup', $2, ARRAY['https://example.test/cb'], ARRAY['mcp:sales:read'], 'admin')`;
    await asTenant(tenantA, (client) =>
      client.query(insert, [tenantA, clientId]),
    );
    expect(await rejected(tenantA, insert, [tenantA, clientId])).toMatch(
      /mcp_clients_tenant_client_id_key/,
    );
    await asTenant(tenantB, (client) =>
      client.query(insert, [tenantB, clientId]),
    );

    const hash = sha(rnd());
    const token = (tenant: string) => ({
      text: `INSERT INTO mcp_tokens (tenant_id, mcp_client_id, user_id, token_hash, token_prefix, scopes, expires_at)
             VALUES ($1, $2, $3, $4, 'mcp_abcd1234', ARRAY['mcp:sales:read'], now() + interval '1 hour')`,
      values: [
        tenant,
        parents[tenant]!.clientRowId,
        parents[tenant]!.userId,
        hash,
      ],
    });
    const first = token(tenantA);
    await asTenant(tenantA, (client) => client.query(first.text, first.values));
    const second = token(tenantB);
    expect(await rejected(tenantB, second.text, second.values)).toMatch(
      /mcp_tokens_token_hash_key/,
    );
  });

  it("the daily quota counter is atomic under concurrency", async () => {
    const userId = await makeUser();
    const upsert = `INSERT INTO ai_usage_daily (tenant_id, user_id, usage_date, request_count)
                    VALUES ($1, $2, '2026-02-01', 1)
                    ON CONFLICT (tenant_id, user_id, usage_date)
                    DO UPDATE SET request_count = ai_usage_daily.request_count + 1
                    RETURNING request_count`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        asTenant(tenantA, (client) => client.query(upsert, [tenantA, userId])),
      ),
    );
    const counts = results.map((r) => r.rows[0].request_count as number);
    expect([...counts].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("check constraints", () => {
  it("MCP-01 auth codes: PKCE S256 only, valid at most 10 minutes", async () => {
    const p = parents[tenantA]!;
    const insert = (method: string, ttl: string) => ({
      text: `INSERT INTO mcp_auth_codes (tenant_id, mcp_client_id, user_id, code_hash, code_challenge,
               code_challenge_method, redirect_uri, scopes, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'https://example.test/cb', ARRAY['mcp:sales:read'], now() + $7::interval)`,
      values: [
        tenantA,
        p.clientRowId,
        p.userId,
        sha(rnd()),
        "c".repeat(43),
        method,
        ttl,
      ],
    });
    const plain = insert("plain", "5 minutes");
    expect(await rejected(tenantA, plain.text, plain.values)).toMatch(
      /mcp_auth_codes_method_check/,
    );
    const long = insert("S256", "11 minutes");
    expect(await rejected(tenantA, long.text, long.values)).toMatch(
      /mcp_auth_codes_ttl_check/,
    );
    const ok = insert("S256", "10 minutes");
    await asTenant(tenantA, (client) => client.query(ok.text, ok.values));
  });

  it("MCP-02 tokens live at most 24 hours", async () => {
    const p = parents[tenantA]!;
    const text = `INSERT INTO mcp_tokens (tenant_id, mcp_client_id, user_id, token_hash, token_prefix, scopes, expires_at)
                  VALUES ($1, $2, $3, $4, 'mcp_abcd1234', ARRAY['mcp:sales:read'], now() + interval '25 hours')`;
    expect(
      await rejected(tenantA, text, [
        tenantA,
        p.clientRowId,
        p.userId,
        sha(rnd()),
      ]),
    ).toMatch(/mcp_tokens_ttl_check/);
  });

  it("AI-12 cache entries live at most 7 days", async () => {
    const text = `INSERT INTO ai_response_cache (tenant_id, cache_key, response, expires_at)
                  VALUES ($1, $2, '{}'::jsonb, now() + interval '8 days')`;
    expect(await rejected(tenantA, text, [tenantA, rnd()])).toMatch(
      /ai_response_cache_ttl_check/,
    );
  });

  it("assistant messages must be labelled aiAssisted; tool_code only on tool messages", async () => {
    const p = parents[tenantA]!;
    const text = `INSERT INTO ai_messages (tenant_id, conversation_id, role, content, ai_assisted, tool_code)
                  VALUES ($1, $2, $3, 'x', $4, $5)`;
    expect(
      await rejected(tenantA, text, [
        tenantA,
        p.conversationId,
        "assistant",
        false,
        null,
      ]),
    ).toMatch(/ai_messages_assistant_labelled_check/);
    expect(
      await rejected(tenantA, text, [
        tenantA,
        p.conversationId,
        "user",
        false,
        "TL-01",
      ]),
    ).toMatch(/ai_messages_tool_code_check/);
    await asTenant(tenantA, (client) =>
      client.query(text, [tenantA, p.conversationId, "tool", false, "TL-01"]),
    );
  });

  it("AIG-03 action requests: source and mcp client agree, outcome fields follow status", async () => {
    const p = parents[tenantA]!;
    const base = `INSERT INTO action_requests (tenant_id, tool_code, requested_by_user_id, source, mcp_client_id,
                    payload, approval_request_id, approval_action_type, expires_at, status, executed_at, failure_reason)
                  VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, $7, now() + interval '1 day', $8, $9, $10)`;
    const args = (over: Partial<Record<number, unknown>>) => {
      const values: unknown[] = [
        tenantA,
        "TL-13",
        p.userId,
        "ai",
        null,
        p.approvalId,
        "ai_action",
        "pending",
        null,
        null,
      ];
      for (const [index, value] of Object.entries(over))
        values[Number(index)] = value;
      return values;
    };
    // mcp source without a client / ai source with a client / wrong action type.
    expect(
      await rejected(tenantA, base, args({ 3: "mcp", 6: "mcp_action" })),
    ).toMatch(/action_requests_source_check/);
    expect(await rejected(tenantA, base, args({ 4: p.clientRowId }))).toMatch(
      /action_requests_source_check/,
    );
    expect(await rejected(tenantA, base, args({ 6: "mcp_action" }))).toMatch(
      /action_requests_source_check/,
    );
    // Read tools never create action requests.
    expect(await rejected(tenantA, base, args({ 1: "TL-01" }))).toMatch(
      /action_requests_tool_check/,
    );
    // executed needs executed_at; failed needs a reason.
    expect(await rejected(tenantA, base, args({ 7: "executed" }))).toMatch(
      /action_requests_outcome_check/,
    );
    expect(await rejected(tenantA, base, args({ 7: "failed" }))).toMatch(
      /action_requests_outcome_check/,
    );
  });

  it("one action request per approval request", async () => {
    const dup = fixtures.action_requests!(tenantA, parents[tenantA]!);
    expect(await rejected(tenantA, dup.text, dup.values)).toMatch(
      /action_requests_tenant_approval_key/,
    );
  });

  it("governance settings keep warn below stop and the row cap in range", async () => {
    const p = parents[tenantB]!;
    const text = `INSERT INTO ai_settings (tenant_id, updated_by, budget_warn_pct, budget_stop_pct, max_rows_per_response)
                  VALUES ($1, $2, $3, $4, $5)`;
    expect(
      await rejected(tenantB, text, [tenantB, p.userId, 100, 100, 200]),
    ).toMatch(/ai_settings_pct_check/);
    expect(
      await rejected(tenantB, text, [tenantB, p.userId, 80, 100, 201]),
    ).toMatch(/ai_settings_max_rows_check/);
  });

  it("an mcp client keeps its approval trail rules (pending has none, approved needs both)", async () => {
    const text = `INSERT INTO mcp_clients (tenant_id, name, client_id, redirect_uris, allowed_scopes, registered_via, status, approved_by, approved_at)
                  VALUES ($1, 'X', $2, ARRAY['https://example.test/cb'], ARRAY['mcp:sales:read'], 'dynamic', $3, $4, $5)`;
    const p = parents[tenantA]!;
    expect(
      await rejected(tenantA, text, [
        tenantA,
        `c-${rnd()}`,
        "approved",
        null,
        null,
      ]),
    ).toMatch(/mcp_clients_approval_check/);
    expect(
      await rejected(tenantA, text, [
        tenantA,
        `c-${rnd()}`,
        "pending",
        p.userId,
        new Date(),
      ]),
    ).toMatch(/mcp_clients_approval_check/);
  });
});

describe("conversation history delete", () => {
  it("deleting a conversation cascades to its messages and keeps the audit rows", async () => {
    const userId = await makeUser();
    const conversationId = randomUUID();
    const callId = randomUUID();
    await asTenant(tenantA, async (client) => {
      await client.query(
        `INSERT INTO ai_conversations (id, tenant_id, owner_user_id, feature, title)
         VALUES ($1, $2, $3, 'AI-02', 'To delete')`,
        [conversationId, tenantA, userId],
      );
      for (const content of ["q", "a"])
        await client.query(
          `INSERT INTO ai_messages (tenant_id, conversation_id, role, content, ai_assisted)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            tenantA,
            conversationId,
            content === "q" ? "user" : "assistant",
            content,
            content === "a",
          ],
        );
      await client.query(
        `INSERT INTO ai_tool_calls (id, tenant_id, tool_code, channel, user_id, status, conversation_id)
         VALUES ($1, $2, 'TL-01', 'app', $3, 'ok', $4)`,
        [callId, tenantA, userId, conversationId],
      );
    });
    await asTenant(tenantA, (client) =>
      client.query("DELETE FROM ai_conversations WHERE id = $1", [
        conversationId,
      ]),
    );
    const after = await asTenant(tenantA, async (client) => ({
      messages: await client.query(
        "SELECT count(*)::int AS n FROM ai_messages WHERE conversation_id = $1",
        [conversationId],
      ),
      calls: await client.query(
        "SELECT count(*)::int AS n FROM ai_tool_calls WHERE id = $1",
        [callId],
      ),
    }));
    expect(after.messages.rows[0].n).toBe(0);
    expect(after.calls.rows[0].n).toBe(1);
  });

  it("a message cannot point at another tenant's conversation", async () => {
    const message = await rejected(
      tenantB,
      `INSERT INTO ai_messages (tenant_id, conversation_id, role, content) VALUES ($1, $2, 'user', 'x')`,
      [tenantB, parents[tenantA]!.conversationId],
    );
    expect(message).toMatch(/ai_messages_conversation_fk/);
  });
});

describe("MCP-03 audit is append-only for the app role", () => {
  it("ai_tool_calls accepts INSERT and SELECT, refuses UPDATE and DELETE", async () => {
    expect(
      await rejected(tenantA, "UPDATE ai_tool_calls SET status = 'error'"),
    ).toMatch(/permission denied/);
    expect(await rejected(tenantA, "DELETE FROM ai_tool_calls")).toMatch(
      /permission denied/,
    );
  });
});

describe("MCP-01/02 pre-auth lookup through SECURITY DEFINER functions", () => {
  const rawToken = `mcp_${rnd()}`;
  const rawCode = rnd();
  let tokenId: string;
  let codeId: string;

  beforeAll(async () => {
    const p = parents[tenantA]!;
    await asTenant(tenantA, async (client) => {
      const token = await client.query(
        `INSERT INTO mcp_tokens (tenant_id, mcp_client_id, user_id, token_hash, token_prefix, scopes, expires_at)
         VALUES ($1, $2, $3, $4, 'mcp_abcd1234', ARRAY['mcp:sales:read'], now() + interval '1 hour')
         RETURNING id`,
        [tenantA, p.clientRowId, p.userId, sha(rawToken)],
      );
      tokenId = token.rows[0].id;
      const code = await client.query(
        `INSERT INTO mcp_auth_codes (tenant_id, mcp_client_id, user_id, code_hash, code_challenge,
           redirect_uri, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'https://example.test/cb', ARRAY['mcp:sales:read'], now() + interval '5 minutes')
         RETURNING id`,
        [tenantA, p.clientRowId, p.userId, sha(rawCode), "c".repeat(43)],
      );
      codeId = code.rows[0].id;
    });
  });

  it("resolves the tenant of a bearer token with no tenant context, returning only ids", async () => {
    const found = await app.query("SELECT * FROM app.mcp_resolve_token($1)", [
      sha(rawToken),
    ]);
    expect(found.rows).toEqual([{ id: tokenId, tenant_id: tenantA }]);
    const wrong = await app.query("SELECT * FROM app.mcp_resolve_token($1)", [
      sha("other"),
    ]);
    expect(wrong.rows).toEqual([]);
  });

  it("resolves an authorization code the same way", async () => {
    const found = await app.query(
      "SELECT * FROM app.mcp_resolve_auth_code($1)",
      [sha(rawCode)],
    );
    expect(found.rows).toEqual([{ id: codeId, tenant_id: tenantA }]);
    const wrong = await app.query(
      "SELECT * FROM app.mcp_resolve_auth_code($1)",
      [sha("other")],
    );
    expect(wrong.rows).toEqual([]);
  });

  it("the tables stay closed: no scan without a tenant, no read or write across tenants", async () => {
    await expect(app.query("SELECT 1 FROM mcp_tokens")).rejects.toThrow(
      /tenant context is required/,
    );
    await expect(app.query("SELECT 1 FROM mcp_auth_codes")).rejects.toThrow(
      /tenant context is required/,
    );
    const seen = await asTenant(tenantB, (client) =>
      client.query("SELECT 1 FROM mcp_tokens WHERE token_hash = $1", [
        sha(rawToken),
      ]),
    );
    expect(seen.rows).toEqual([]);
    const updated = await asTenant(tenantB, (client) =>
      client.query(
        "UPDATE mcp_tokens SET revoked_at = now() WHERE token_hash = $1",
        [sha(rawToken)],
      ),
    );
    expect(updated.rowCount).toBe(0);
  });

  it("after the lookup the resolved tenant reads the full row and marks the code used once", async () => {
    const row = await asTenant(tenantA, (client) =>
      client.query("SELECT scopes, revoked_at FROM mcp_tokens WHERE id = $1", [
        tokenId,
      ]),
    );
    expect(row.rows).toEqual([
      { scopes: ["mcp:sales:read"], revoked_at: null },
    ]);
    const claim = () =>
      asTenant(tenantA, (client) =>
        client.query(
          "UPDATE mcp_auth_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL",
          [codeId],
        ),
      );
    expect((await claim()).rowCount).toBe(1);
    expect((await claim()).rowCount).toBe(0);
  });
});

describe("legend-x7u9 role template data migration", () => {
  const migration = readFileSync(
    resolve(
      import.meta.dirname,
      "../../drizzle/0088_ai_role_templates_data.sql",
    ),
    "utf8",
  );
  const insertRole = (key: string | null, permissions: string[]) =>
    owner.query(
      `INSERT INTO roles (tenant_id, name, is_template, template_key, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, $4, $5, '["tenant"]')`,
      [
        tenantB,
        `x7u9 ${key ?? "custom"}`,
        key !== null,
        key,
        JSON.stringify(permissions),
      ],
    );
  const permissionsOf = async (name: string): Promise<string[]> => {
    const { rows } = await owner.query(
      "SELECT permissions FROM roles WHERE tenant_id = $1 AND name = $2",
      [tenantB, `x7u9 ${name}`],
    );
    return rows[0].permissions;
  };
  const migrate = async () => {
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.replace(/--.*$/gm, "").trim()) await owner.query(statement);
  };

  it("unions ai.ask / ai.action.propose into seeded templates, never removing codes, never touching custom roles", async () => {
    await insertRole("employee", ["self.profile.view", "legacy.keep"]);
    await insertRole("finance", ["legacy.keep"]);
    await insertRole("tenant_admin", ["legacy.keep"]);
    await insertRole("hr", ["ai.ask", "legacy.keep"]);
    await insertRole(null, ["legacy.keep"]);

    await migrate();

    const employee = await permissionsOf("employee");
    expect(employee).toEqual(["self.profile.view", "legacy.keep", "ai.ask"]);
    const finance = await permissionsOf("finance");
    expect(finance).toEqual(["legacy.keep", "ai.ask", "ai.action.propose"]);
    // tenant_admin gets ai.ask only: the template has no ai.action.propose.
    expect(await permissionsOf("tenant_admin")).toEqual([
      "legacy.keep",
      "ai.ask",
    ]);
    // Already holds ai.ask: no duplicate, propose added.
    expect(await permissionsOf("hr")).toEqual([
      "ai.ask",
      "legacy.keep",
      "ai.action.propose",
    ]);
    // Custom roles are never changed.
    expect(await permissionsOf("custom")).toEqual(["legacy.keep"]);

    // Idempotent: a second run changes nothing.
    await migrate();
    expect(await permissionsOf("finance")).toEqual(finance);
    expect(await permissionsOf("hr")).toEqual([
      "ai.ask",
      "legacy.keep",
      "ai.action.propose",
    ]);
  });
});
