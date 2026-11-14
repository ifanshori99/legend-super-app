// WS-12 Tanya AI and MCP contract tests (bead legend-1zxo).
// PRD v1.7 §3 Fitur 38 (Tanya AI), 39 (MCP Server), 40 (Tata Kelola AI & MCP);
// acceptance criteria AIG-xx and MCP-xx. Test names carry the criterion ID.
// Run with: node --test tests/ai-contract.test.mjs (no database needed).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as ai from "../packages/shared/src/ai/index.ts";
import * as events from "../packages/shared/src/events/index.ts";
import { roleTemplate } from "../packages/shared/src/access/roles.ts";

const f = ai.cafeLegendAiFixtures;
const clone = (value) => structuredClone(value);
const rejects = (schema, value) =>
  assert.equal(schema.safeParse(value).success, false);
const accepts = (schema, value) => {
  const result = schema.safeParse(value);
  assert.ok(result.success, result.success ? "" : result.error.message);
};
const tool = (code) => ai.getAiTool(code);
const pendingAi = f.actionRequests.find(
  (row) => row.source === "ai" && row.status === "pending",
);
const mcpRequest = f.actionRequests.find((row) => row.source === "mcp");
const approvedClient = f.mcpClients.find((row) => row.status === "approved");
const token = f.mcpTokens[0];
const anyRole = (code) => tool(code).minRoles[0].role;

const draftArgs = (toolCode, source = "ai") => ({
  toolCode,
  input: f.toolSamples[toolCode].input,
  tenantId: pendingAi.tenantId,
  requestedByUserId: pendingAi.requestedByUserId,
  source,
  mcpClientId: source === "mcp" ? approvedClient.id : null,
  approvalRequestId: pendingAi.approvalRequestId,
  now: f.now,
  expiresAt: "2099-01-01T00:00:00.000Z",
});

// ---- Fixtures --------------------------------------------------------------

test("WS-12 fixtures parse and cover the whole AI and MCP contract", () => {
  ai.aiFixtureSchema.parse(f);
  assert.ok(f.actionRequests.length >= 5);
  assert.ok(f.conversations.length >= 1);
  assert.ok(f.messages.length >= 2);
  assert.ok(f.aiJobs.length >= 1);
  assert.ok(f.toolCallRecords.length >= 1);
  assert.ok(f.mcpClients.length >= 2);
  assert.ok(f.mcpTokens.length >= 1);
  for (const status of [
    "pending",
    "approved",
    "rejected",
    "executed",
    "failed",
    "expired",
  ])
    assert.ok(
      f.actionRequests.some((row) => row.status === status),
      `fixture covers action request status ${status}`,
    );
  assert.ok(f.actionRequests.some((row) => row.source === "mcp"));
  assert.ok(f.actionRequests.some((row) => row.source === "ai"));
  accepts(ai.aiGovernanceSettingsSchema, f.governanceSettings);
});

test("WS-12 all 20 tool samples parse against their input and output schemas", () => {
  ai.toolSamplesSchema.parse(f.toolSamples);
  assert.equal(Object.keys(f.toolSamples).length, 20);
  for (const code of ai.AI_TOOL_CODES) {
    assert.ok(f.toolSamples[code], `sample for ${code}`);
    accepts(ai.AI_TOOL_IO[code].input, f.toolSamples[code].input);
    accepts(ai.AI_TOOL_IO[code].output, f.toolSamples[code].output);
  }
});

// ---- Invalid input rejected ------------------------------------------------

test("WS-12 tool input rejects a bad UUID", () => {
  const input = clone(f.toolSamples["TL-13"].input);
  input.supplierId = "not-a-uuid";
  rejects(ai.AI_TOOL_IO["TL-13"].input, input);
  const status = clone(f.toolSamples["TL-19"].input);
  status.actionRequestId = "1234";
  rejects(ai.AI_TOOL_IO["TL-19"].input, status);
  const sales = clone(f.toolSamples["TL-01"].input);
  sales.outletIds = ["nope"];
  rejects(ai.AI_TOOL_IO["TL-01"].input, sales);
});

test("WS-12 money is whole non-negative rupiah (no float, no negative)", () => {
  const schema = ai.AI_TOOL_IO["TL-17"].input;
  const input = clone(f.toolSamples["TL-17"].input);
  accepts(schema, input);
  for (const bad of [-1, 1500.5, "32000"]) {
    const changed = clone(input);
    changed.changes[0].newPriceIdr = bad;
    rejects(schema, changed);
  }
  for (const bad of [-1, 1.5]) {
    rejects(ai.aiGovernanceSettingsSchema, {
      ...clone(f.governanceSettings),
      monthlyBudgetIdr: bad,
    });
  }
});

test("MCP-01 client input never carries tenantId (tenant comes from the token)", () => {
  for (const code of ai.AI_TOOL_CODES) {
    const input = {
      ...clone(f.toolSamples[code].input),
      tenantId: pendingAi.tenantId,
    };
    rejects(ai.AI_TOOL_IO[code].input, input);
  }
  rejects(ai.askAiSchema, {
    feature: "AI-01",
    question: "Omzet kemarin?",
    tenantId: pendingAi.tenantId,
  });
  accepts(ai.askAiSchema, { feature: "AI-01", question: "Omzet kemarin?" });
  rejects(ai.createActionRequestSchema, {
    ...ai.toActionRequestDraft(draftArgs("TL-13")),
    id: pendingAi.id,
  });
});

test("MCP-02 mcpTokenSchema stores a hash and prefix, never a raw token", () => {
  accepts(ai.mcpTokenSchema, token);
  for (const key of ["token", "accessToken"])
    rejects(ai.mcpTokenSchema, { ...clone(token), [key]: "mcp_secret_value" });
  rejects(ai.mcpTokenSchema, { ...clone(token), tokenHash: "ABC" });
  rejects(ai.mcpTokenSchema, {
    ...clone(token),
    tokenHash: token.tokenHash.toUpperCase(),
  });
  rejects(ai.mcpTokenSchema, { ...clone(token), tokenPrefix: "short" });
  assert.equal(ai.MCP_REVOCATION_MAX_SECONDS, 60);
  assert.equal(ai.MCP_TOKEN_MAX_TTL_HOURS, 24);
});

test("AIG-03 action request: mcp source needs mcpClientId, ai source forbids it", () => {
  accepts(ai.actionRequestSchema, mcpRequest);
  rejects(ai.actionRequestSchema, { ...clone(mcpRequest), mcpClientId: null });
  rejects(ai.actionRequestSchema, {
    ...clone(pendingAi),
    mcpClientId: approvedClient.id,
  });
  rejects(ai.actionRequestSchema, {
    ...clone(pendingAi),
    approvalActionType: "mcp_action",
  });
  rejects(ai.actionRequestSchema, {
    ...clone(mcpRequest),
    approvalActionType: "ai_action",
  });
});

test("AIG-03 action request rejects a read tool code", () => {
  for (const code of ai.AI_TOOL_CODES.filter((c) => tool(c).kind === "read")) {
    rejects(ai.actionRequestSchema, { ...clone(pendingAi), toolCode: code });
  }
  const draft = ai.toActionRequestDraft(draftArgs("TL-13"));
  rejects(ai.createActionRequestSchema, { ...draft, toolCode: "TL-01" });
});

test("AIG-03 executedAt is set if and only if status is executed", () => {
  const executed = f.actionRequests.find((row) => row.status === "executed");
  accepts(ai.actionRequestSchema, executed);
  rejects(ai.actionRequestSchema, { ...clone(executed), executedAt: null });
  rejects(ai.actionRequestSchema, {
    ...clone(pendingAi),
    executedAt: f.now,
  });
});

test("WS-12 tool period rejects from after to and more than 366 days", () => {
  const schema = ai.AI_TOOL_IO["TL-01"].input;
  const input = clone(f.toolSamples["TL-01"].input);
  accepts(schema, input);
  rejects(schema, {
    ...input,
    period: { from: "2026-10-31", to: "2026-10-25" },
  });
  rejects(schema, {
    ...input,
    period: { from: "2024-01-01", to: "2026-01-01" },
  });
  accepts(ai.toolPeriodSchema, { from: "2026-10-31", to: "2026-10-31" });
});

test("WS-12 other contract rejects: mcp client uri, client status trail, strict objects", () => {
  accepts(ai.mcpClientSchema, approvedClient);
  rejects(ai.mcpClientSchema, {
    ...clone(approvedClient),
    redirectUris: ["http://evil.example.com/callback"],
  });
  accepts(ai.mcpClientSchema, {
    ...clone(approvedClient),
    redirectUris: ["http://localhost:3000/callback"],
  });
  rejects(ai.mcpClientSchema, {
    ...clone(approvedClient),
    allowedScopes: ["mcp:sales:write"],
  });
  rejects(ai.mcpClientSchema, { ...clone(approvedClient), approvedBy: null });
  rejects(ai.mcpClientSchema, { ...clone(approvedClient), extra: 1 });
});

// ---- Catalog ---------------------------------------------------------------

test("WS-12 catalog has 20 tools in PRD order with a code and name each", () => {
  assert.equal(ai.AI_TOOL_CATALOG.length, 20);
  assert.ok(Object.isFrozen(ai.AI_TOOL_CATALOG));
  assert.deepEqual(
    ai.AI_TOOL_CATALOG.map((row) => row.code),
    ai.AI_TOOL_CODES,
  );
  assert.deepEqual(
    ai.AI_TOOL_CATALOG.map((row) => row.name),
    ai.AI_TOOL_NAMES,
  );
  for (const row of ai.AI_TOOL_CATALOG) {
    assert.equal(tool(row.code), row);
    assert.equal(tool(row.name), row);
  }
  assert.equal(tool("TL-99"), undefined);
});

test("MCP-01 every catalog tool has annotations, scope, minRoles and permissions", () => {
  for (const row of ai.AI_TOOL_CATALOG) {
    assert.ok(row.mcpAnnotations, `${row.code} annotations`);
    assert.equal(row.mcpAnnotations.destructiveHint, false);
    assert.equal(row.mcpAnnotations.openWorldHint, false);
    assert.ok(ai.MCP_SCOPES.includes(row.scope), `${row.code} scope`);
    assert.ok(row.minRoles.length > 0, `${row.code} minRoles`);
    assert.ok(row.requiredPermissions.length > 0, `${row.code} permissions`);
    assert.equal(
      row.scope.endsWith(row.kind === "write" ? ":draft" : ":read"),
      true,
      `${row.code} scope suffix`,
    );
  }
  for (const scope of ai.MCP_SCOPES)
    assert.ok(
      ai.AI_TOOL_CATALOG.some((row) => row.scope === scope),
      `scope ${scope} used`,
    );
});

test("AIG-03 read tools are readOnlyHint, write tools require approval", () => {
  const writes = ai.AI_TOOL_CATALOG.filter((row) => row.kind === "write");
  assert.deepEqual(
    writes.map((row) => row.code),
    ["TL-13", "TL-14", "TL-15", "TL-16", "TL-17", "TL-18"],
  );
  for (const row of ai.AI_TOOL_CATALOG) {
    if (row.kind === "read") {
      assert.equal(row.mcpAnnotations.readOnlyHint, true, row.code);
      assert.equal(row.requiresApproval, false, row.code);
    } else {
      assert.equal(row.mcpAnnotations.readOnlyHint, false, row.code);
      assert.equal(row.requiresApproval, true, row.code);
      assert.ok(
        row.requiredPermissions.includes("ai.action.propose"),
        row.code,
      );
    }
  }
});

test("WS-12 write tool receipt is a pending action request linked to an approval", () => {
  const receipt = f.toolSamples["TL-13"].output;
  assert.equal(receipt.status, "pending");
  assert.ok(receipt.approvalRequestId);
  for (const code of writeCodes()) {
    assert.equal(tool(code).output, ai.AI_TOOL_IO[code].output);
    assert.equal(tool(code).input, ai.AI_TOOL_IO[code].input);
  }
  rejects(ai.AI_TOOL_IO["TL-13"].output, {
    ...clone(receipt),
    status: "approved",
  });
});

function writeCodes() {
  return ai.AI_TOOL_CATALOG.filter((row) => row.kind === "write").map(
    (row) => row.code,
  );
}

// ---- Action request draft --------------------------------------------------

test("AIG-03 toActionRequestDraft makes ai_action for ai and mcp_action for mcp", () => {
  for (const code of writeCodes()) {
    const aiDraft = ai.toActionRequestDraft(draftArgs(code, "ai"));
    ai.createActionRequestSchema.parse(aiDraft);
    assert.equal(aiDraft.approvalActionType, "ai_action");
    assert.equal(aiDraft.toolCode, code);
    assert.equal(aiDraft.mcpClientId, null);
    assert.equal("status" in aiDraft, false);
    const mcpDraft = ai.toActionRequestDraft(draftArgs(code, "mcp"));
    assert.equal(mcpDraft.approvalActionType, "mcp_action");
    assert.equal(mcpDraft.mcpClientId, approvedClient.id);
  }
});

test("AIG-03 toActionRequestDraft derives the row outlet from the payload", () => {
  const outletOf = (code) => ai.toActionRequestDraft(draftArgs(code)).outletId;
  // Single-outlet tools: payload.outletId.
  for (const code of ["TL-13", "TL-14", "TL-16", "TL-18"])
    assert.equal(outletOf(code), f.toolSamples[code].input.outletId, code);
  // TL-15 sample targets two outlets: tenant-level approval.
  assert.ok(f.toolSamples["TL-15"].input.outletIds.length > 1);
  assert.equal(outletOf("TL-15"), null);
  // TL-17 sample targets exactly one outlet.
  assert.equal(outletOf("TL-17"), f.toolSamples["TL-17"].input.outletIds[0]);
  // TL-17 without outletIds means every outlet: tenant-level.
  const everyOutlet = clone(f.toolSamples["TL-17"].input);
  delete everyOutlet.outletIds;
  assert.equal(
    ai.toActionRequestDraft({ ...draftArgs("TL-17"), input: everyOutlet })
      .outletId,
    null,
  );
  // A matching cross-check passes.
  const single = f.toolSamples["TL-13"].input.outletId;
  assert.equal(
    ai.toActionRequestDraft({ ...draftArgs("TL-13"), outletId: single })
      .outletId,
    single,
  );
});

test("AIG-03 toActionRequestDraft throws RangeError on an outlet mismatch", () => {
  const other = pendingAi.approvalRequestId; // a uuid that is not an outlet in the payload
  for (const code of ["TL-13", "TL-14", "TL-16", "TL-18", "TL-17"])
    assert.throws(
      () => ai.toActionRequestDraft({ ...draftArgs(code), outletId: other }),
      RangeError,
      code,
    );
  // Multi-outlet payload: a given outlet disagrees with null (tenant-level).
  const multi = f.toolSamples["TL-15"].input.outletIds[0];
  assert.throws(
    () => ai.toActionRequestDraft({ ...draftArgs("TL-15"), outletId: multi }),
    RangeError,
  );
  // Explicit null is accepted and means "no cross-check".
  assert.equal(
    ai.toActionRequestDraft({ ...draftArgs("TL-15"), outletId: null }).outletId,
    null,
  );
});

test("AIG-03 toActionRequestDraft throws for read tools, bad input, past expiry", () => {
  for (const code of ai.AI_TOOL_CODES.filter((c) => tool(c).kind === "read"))
    assert.throws(() => ai.toActionRequestDraft(draftArgs(code)), RangeError);
  assert.throws(() =>
    ai.toActionRequestDraft({ ...draftArgs("TL-13"), input: { lines: [] } }),
  );
  assert.throws(
    () =>
      ai.toActionRequestDraft({
        ...draftArgs("TL-13"),
        expiresAt: "2000-01-01T00:00:00.000Z",
      }),
    RangeError,
  );
  assert.throws(() =>
    ai.toActionRequestDraft({
      ...draftArgs("TL-13"),
      source: "mcp",
      mcpClientId: null,
    }),
  );
});

// ---- Review fixes: ids, scopes, tokens, action request trail ---------------

test("MCP-01 unknown scope mcp:evil:read is rejected everywhere scopes are accepted", () => {
  const evil = "mcp:evil:read";
  assert.equal(ai.isMcpScope(evil), false);
  assert.equal(ai.mcpScopeSchema.safeParse(evil).success, false);
  assert.equal(ai.mcpScopeSchema.safeParse("mcp:sales:read").success, true);
  rejects(ai.mcpClientSchema, {
    ...clone(approvedClient),
    allowedScopes: [evil],
  });
  rejects(ai.mcpClientSchema, {
    ...clone(approvedClient),
    allowedScopes: ["mcp:sales:read", evil],
  });
  rejects(ai.registerMcpClientSchema, {
    name: "Evil",
    clientId: "evil",
    redirectUris: ["https://evil.example.com/cb"],
    allowedScopes: [evil],
  });
  rejects(ai.approveMcpClientSchema, { allowedScopes: [evil] });
  rejects(ai.mcpTokenSchema, { ...clone(token), scopes: [evil] });
  // The old regex shape (domain + suffix) passes only for real catalog scopes.
  rejects(ai.mcpTokenSchema, { ...clone(token), scopes: ["mcp:sales:draft"] });
});

test("MCP-01 scopes are a non-empty unique list", () => {
  rejects(ai.mcpClientSchema, { ...clone(approvedClient), allowedScopes: [] });
  rejects(ai.mcpClientSchema, {
    ...clone(approvedClient),
    allowedScopes: ["mcp:sales:read", "mcp:sales:read"],
  });
  rejects(ai.mcpTokenSchema, {
    ...clone(token),
    scopes: ["mcp:sales:read", "mcp:sales:read"],
  });
  accepts(ai.approveMcpClientSchema, {});
});

test("MCP-01 scope enums live in ids and the catalog uses the same values", () => {
  assert.deepEqual(ai.MCP_SCOPES, [
    ...ai.MCP_READ_SCOPES,
    ...ai.MCP_DRAFT_SCOPES,
  ]);
  for (const scope of ai.MCP_READ_SCOPES)
    assert.ok(scope.endsWith(":read"), scope);
  for (const scope of ai.MCP_DRAFT_SCOPES)
    assert.ok(scope.endsWith(":draft"), scope);
  for (const row of ai.AI_TOOL_CATALOG)
    assert.ok(ai.isMcpScope(row.scope), row.code);
});

test("MCP-01 isScopeSubset checks token scopes against client scopes", () => {
  const client = approvedClient.allowedScopes;
  assert.equal(ai.isScopeSubset(token.scopes, client), true);
  assert.equal(ai.isScopeSubset([], client), true);
  assert.equal(ai.isScopeSubset(["mcp:finance:read"], client), false);
  assert.equal(ai.isScopeSubset([...client, "mcp:menu:read"], client), false);
  assert.equal(ai.isScopeSubset(client, [...client].reverse()), true);
  // Every fixture token stays within its client scopes.
  for (const row of f.mcpTokens) {
    const owner = f.mcpClients.find((client) => client.id === row.clientId);
    assert.ok(
      ai.isScopeSubset(row.scopes, owner.allowedScopes),
      String(row.id),
    );
  }
});

test("AIG-03 action request tool codes are the write tools only", () => {
  assert.deepEqual([...ai.ACTION_REQUEST_TOOL_CODES], writeCodes());
  for (const code of ai.ACTION_REQUEST_TOOL_CODES)
    assert.equal(ai.actionRequestToolCodeSchema.safeParse(code).success, true);
  for (const code of ["TL-01", "TL-12", "TL-19", "TL-20"])
    assert.equal(ai.actionRequestToolCodeSchema.safeParse(code).success, false);
});

test("AIG-03 write receipt only carries a write tool code", () => {
  const schema = ai.AI_TOOL_IO["TL-13"].output;
  const receipt = clone(f.toolSamples["TL-13"].output);
  accepts(schema, receipt);
  for (const code of ["TL-01", "TL-19", "TL-20"])
    rejects(schema, { ...receipt, toolCode: code });
});

test("AIG-03 resultRef is only allowed when the request is executed", () => {
  const executed = f.actionRequests.find((row) => row.status === "executed");
  assert.ok(executed.resultRef);
  accepts(ai.actionRequestSchema, executed);
  for (const status of [
    "pending",
    "approved",
    "rejected",
    "expired",
    "failed",
  ]) {
    const row = f.actionRequests.find((r) => r.status === status);
    accepts(ai.actionRequestSchema, row);
    rejects(ai.actionRequestSchema, { ...clone(row), resultRef: "po:PO-1" });
  }
});

test("AIG-03 failureReason is set if and only if the request failed", () => {
  const failed = f.actionRequests.find((row) => row.status === "failed");
  assert.ok(failed.failureReason);
  accepts(ai.actionRequestSchema, failed);
  rejects(ai.actionRequestSchema, { ...clone(failed), failureReason: null });
  for (const status of [
    "pending",
    "approved",
    "rejected",
    "expired",
    "executed",
  ]) {
    const row = f.actionRequests.find((r) => r.status === status);
    rejects(ai.actionRequestSchema, { ...clone(row), failureReason: "Gagal." });
  }
});

test("MCP-02 tokenPrefix is mcp_ plus 8 alphanumerics (12 chars)", () => {
  assert.equal(ai.MCP_TOKEN_PREFIX_LENGTH, 12);
  for (const row of f.mcpTokens)
    assert.match(row.tokenPrefix, /^mcp_[A-Za-z0-9]{8}$/);
  for (const bad of [
    "lgd_a1B2c3D4",
    "mcp_a1B2c3D",
    "mcp_a1B2c3D4E",
    "mcp_a1B2c3D!",
    "mcp-a1B2c3D4",
    "MCP_a1B2c3D4",
    "",
  ])
    rejects(ai.mcpTokenSchema, { ...clone(token), tokenPrefix: bad });
});

test("MCP-02 token lifetime must be positive and at most 24 hours", () => {
  rejects(ai.mcpTokenSchema, { ...clone(token), expiresAt: token.createdAt });
  rejects(ai.mcpTokenSchema, {
    ...clone(token),
    expiresAt: "2026-11-02T04:31:00.000Z",
  });
});

test("AIG-02 governance update keeps the warn below stop rule", () => {
  accepts(ai.updateAiGovernanceSettingsSchema, { budgetWarnPct: 70 });
  rejects(ai.updateAiGovernanceSettingsSchema, {});
  rejects(ai.updateAiGovernanceSettingsSchema, {
    budgetWarnPct: 100,
    budgetStopPct: 90,
  });
  rejects(ai.updateAiGovernanceSettingsSchema, {
    tenantId: pendingAi.tenantId,
  });
});

// ---- Review fixes: tool input rules ----------------------------------------

const withInput = (code, change) => {
  const input = clone(f.toolSamples[code].input);
  change(input);
  return input;
};

test("WS-12 TL-16 weekStart must be a Monday", () => {
  const schema = ai.AI_TOOL_IO["TL-16"].input;
  accepts(schema, f.toolSamples["TL-16"].input);
  // 2026-11-09 is a Monday; Tuesday through Sunday are not.
  for (const day of ["2026-11-10", "2026-11-11", "2026-11-14", "2026-11-15"])
    rejects(
      schema,
      withInput("TL-16", (input) => {
        input.weekStart = day;
        for (const shift of input.shifts) shift.date = day;
      }),
    );
});

test("WS-12 TL-16 every shift date is within weekStart..weekStart+6", () => {
  const schema = ai.AI_TOOL_IO["TL-16"].input;
  const dated = (date) =>
    withInput("TL-16", (input) => {
      input.shifts[0].date = date;
    });
  accepts(schema, dated("2026-11-09"));
  accepts(schema, dated("2026-11-15"));
  rejects(schema, dated("2026-11-08"));
  rejects(schema, dated("2026-11-16"));
});

test("WS-12 TL-16 startTime differs from endTime, overnight is allowed", () => {
  const schema = ai.AI_TOOL_IO["TL-16"].input;
  rejects(
    schema,
    withInput("TL-16", (input) => {
      input.shifts[0].endTime = input.shifts[0].startTime;
    }),
  );
  // endTime earlier than startTime means the shift runs overnight.
  accepts(
    schema,
    withInput("TL-16", (input) => {
      input.shifts[0].startTime = "22:00";
      input.shifts[0].endTime = "06:00";
    }),
  );
});

test("WS-12 TL-16 rejects a duplicate (employeeId, date, startTime)", () => {
  const schema = ai.AI_TOOL_IO["TL-16"].input;
  rejects(
    schema,
    withInput("TL-16", (input) => {
      input.shifts.push({ ...input.shifts[0], station: "Kasir" });
    }),
  );
  // Same employee and date with a different start time is a split shift: allowed.
  accepts(
    schema,
    withInput("TL-16", (input) => {
      input.shifts.push({
        ...input.shifts[0],
        startTime: "16:00",
        endTime: "22:00",
      });
    }),
  );
});

test("WS-12 TL-17 menuItemId is unique and newPriceIdr is above zero", () => {
  const schema = ai.AI_TOOL_IO["TL-17"].input;
  accepts(schema, f.toolSamples["TL-17"].input);
  rejects(
    schema,
    withInput("TL-17", (input) => {
      input.changes.push({ ...input.changes[0], newPriceIdr: 35_000 });
    }),
  );
  rejects(
    schema,
    withInput("TL-17", (input) => {
      input.changes[0].newPriceIdr = 0;
    }),
  );
  rejects(
    schema,
    withInput("TL-17", (input) => {
      input.outletIds = [];
    }),
  );
  // Absent outletIds means every outlet.
  accepts(
    schema,
    withInput("TL-17", (input) => {
      delete input.outletIds;
    }),
  );
});

test("WS-12 TL-13 and TL-14 reject a repeated inventoryItemId line", () => {
  for (const code of ["TL-13", "TL-14"]) {
    const schema = ai.AI_TOOL_IO[code].input;
    accepts(schema, f.toolSamples[code].input);
    rejects(
      schema,
      withInput(code, (input) => {
        input.lines.push({ ...input.lines[0] });
      }),
    );
  }
});

test("SH-01 TL-09 payslip input has no employee id", () => {
  accepts(ai.AI_TOOL_IO["TL-09"].input, f.toolSamples["TL-09"].input);
  rejects(ai.AI_TOOL_IO["TL-09"].input, {
    ...clone(f.toolSamples["TL-09"].input),
    employeeId: f.toolSamples["TL-08"].output.shifts[0].employeeId,
  });
});

// ---- Scope gating ----------------------------------------------------------

test("MCP-01 a token without the scope neither sees nor calls the tool", () => {
  assert.deepEqual(ai.toolsVisibleForScopes([]), []);
  const visible = ai.toolsVisibleForScopes(["mcp:sales:read"]);
  assert.deepEqual(
    visible.map((row) => row.code),
    ["TL-01"],
  );
  assert.deepEqual(ai.toolsVisibleForScopes(["mcp:unknown:read", "bogus"]), []);
  assert.equal(ai.toolsVisibleForScopes(ai.MCP_SCOPES).length, 20);
  const sales = tool("TL-01");
  assert.deepEqual(
    ai.canCallTool({ tool: sales, scopes: [], roles: [anyRole("TL-01")] }),
    { allowed: false, reason: "scope_missing" },
  );
  assert.deepEqual(
    ai.canCallTool({
      tool: sales,
      scopes: ["mcp:menu:read"],
      roles: [anyRole("TL-01")],
    }),
    { allowed: false, reason: "scope_missing" },
  );
  assert.deepEqual(
    ai.canCallTool({
      tool: sales,
      scopes: ["mcp:sales:read"],
      roles: [anyRole("TL-01")],
    }),
    { allowed: true },
  );
  const draft = tool("TL-13");
  assert.equal(
    ai.canCallTool({
      tool: draft,
      scopes: ["mcp:sales:read"],
      roles: [anyRole("TL-13")],
    }).allowed,
    false,
  );
});

test("MCP-01 canCallTool denies a role outside minRoles", () => {
  const roles = ai.AI_TOOL_CATALOG.find(
    (row) => row.code === "TL-06",
  ).minRoles.map((entry) => entry.role);
  assert.ok(!roles.includes("cashier"));
  assert.deepEqual(
    ai.canCallTool({
      tool: tool("TL-06"),
      scopes: ["mcp:finance:read"],
      roles: ["cashier"],
    }),
    { allowed: false, reason: "role_not_allowed" },
  );
});

test("AIG-04 the per-tool kill switch hides and blocks a tool", () => {
  const scopes = ai.MCP_SCOPES;
  const visible = ai.toolsVisibleForScopes(scopes, {
    disabledToolCodes: ["TL-01", "TL-13"],
  });
  assert.equal(visible.length, 18);
  assert.ok(!visible.some((row) => row.code === "TL-01"));
  assert.deepEqual(
    ai.canCallTool({
      tool: tool("TL-01"),
      scopes,
      roles: [anyRole("TL-01")],
      disabledToolCodes: ["TL-01"],
    }),
    { allowed: false, reason: "tool_disabled" },
  );
  assert.equal(
    ai.canCallTool({
      tool: tool("TL-02"),
      scopes,
      roles: [anyRole("TL-02")],
      disabledToolCodes: ["TL-01"],
    }).allowed,
    true,
  );
});

test("MCP-01 mcpScopesForRoles gives only scopes of tools the roles may use", () => {
  assert.deepEqual(ai.mcpScopesForRoles([]), []);
  const scopes = ai.mcpScopesForRoles(["employee"]);
  assert.ok(scopes.length > 0);
  assert.ok(!scopes.includes("mcp:finance:read"));
  for (const scope of scopes) assert.ok(ai.MCP_SCOPES.includes(scope));
});

// ---- State machine and budget ----------------------------------------------

test("AIG-03 canTransitionActionRequest follows the approval lifecycle", () => {
  const ok = [
    ["pending", "approved"],
    ["pending", "rejected"],
    ["pending", "expired"],
    ["approved", "executed"],
    ["approved", "failed"],
  ];
  for (const [from, to] of ok)
    assert.equal(
      ai.canTransitionActionRequest(from, to),
      true,
      `${from}->${to}`,
    );
  const bad = [
    ["pending", "executed"],
    ["pending", "failed"],
    ["approved", "pending"],
    ["approved", "rejected"],
    ["approved", "expired"],
    ["executed", "failed"],
    ["rejected", "approved"],
    ["failed", "executed"],
    ["expired", "approved"],
    ["pending", "pending"],
  ];
  for (const [from, to] of bad)
    assert.equal(
      ai.canTransitionActionRequest(from, to),
      false,
      `${from}->${to}`,
    );
  for (const terminal of ["rejected", "executed", "failed", "expired"])
    assert.deepEqual(ai.ACTION_REQUEST_TRANSITIONS[terminal], []);
});

test("AIG-02 budgetState warns at 80% and stops at 100%", () => {
  assert.equal(ai.budgetState(0, 500000, 80, 100), "ok");
  assert.equal(ai.budgetState(399999, 500000, 80, 100), "ok");
  assert.equal(ai.budgetState(400000, 500000, 80, 100), "warn");
  assert.equal(ai.budgetState(499999, 500000, 80, 100), "warn");
  assert.equal(ai.budgetState(500000, 500000, 80, 100), "stopped");
  assert.equal(ai.budgetState(900000, 500000, 80, 100), "stopped");
  assert.equal(ai.budgetState(1, 0, 80, 100), "stopped");
});

test("AIG-02 governance settings: warn below stop, unique features, default limits", () => {
  const settings = clone(f.governanceSettings);
  rejects(ai.aiGovernanceSettingsSchema, {
    ...settings,
    budgetWarnPct: 100,
    budgetStopPct: 100,
  });
  rejects(ai.aiGovernanceSettingsSchema, { ...settings, budgetStopPct: 101 });
  rejects(ai.aiGovernanceSettingsSchema, {
    ...settings,
    features: [settings.features[0], settings.features[0]],
  });
  rejects(ai.aiGovernanceSettingsSchema, {
    ...settings,
    mcpRateLimitPerMinute: 0,
  });
  rejects(ai.aiGovernanceSettingsSchema, {
    ...settings,
    mcpRateLimitPerMinute: 601,
  });
  rejects(ai.aiGovernanceSettingsSchema, {
    ...settings,
    maxRowsPerResponse: 201,
  });
  assert.equal(ai.defaultDailyLimitForRole("cashier"), 30);
  assert.equal(ai.defaultDailyLimitForRole("employee"), 30);
  assert.equal(ai.defaultDailyLimitForRole("owner"), 100);
  assert.equal(ai.defaultDailyLimitForRole("shareholder"), 100);
});

// ---- Events and package export ---------------------------------------------

test("WS-12 every AI event is registered in the event catalog with a payload schema", () => {
  const names = new Set(events.eventCatalog.map((entry) => entry.name));
  // 16 WS-12 events + 2 AI insight notification events (wave 3).
  assert.equal(ai.aiEventNames.length, 18);
  for (const name of ai.aiEventNames) {
    assert.ok(names.has(name), `${name} in catalog`);
    assert.ok(ai.AI_EVENT_PAYLOAD_SCHEMAS[name], `${name} payload schema`);
  }
  for (const name of [
    "ai_job.completed",
    "action_request.created",
    "action_request.approved",
    "action_request.executed",
    "action_request.rejected",
    "action_request.failed",
    "action_request.expired",
    "mcp_token.issued",
    "ai_tool.invoked",
  ])
    assert.ok(ai.aiEventNames.includes(name), name);
});

test("WS-12 event payloads are strict and carry no token or question field", () => {
  for (const name of ai.aiEventNames) {
    const schema = ai.AI_EVENT_PAYLOAD_SCHEMAS[name];
    assert.equal(schema.def.catchall?.def.type, "never", `${name} is strict`);
    for (const key of ["token", "accessToken", "question", "content"])
      assert.ok(!(key in schema.shape), `${name} has no ${key}`);
  }
});

test("WS-12 package exports ./ai", () => {
  const pkg = JSON.parse(
    readFileSync(
      new URL("../packages/shared/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(pkg.exports["./ai"], "./src/ai/index.ts");
});

// ---- Review fixes round 2 ---------------------------------------------------

test("MCP-01 payslip and profit share have separate scopes, no shared self scope", () => {
  assert.ok(!ai.MCP_SCOPES.includes("mcp:self:read"));
  assert.equal(tool("TL-09").scope, "mcp:payslip:read");
  assert.equal(tool("TL-12").scope, "mcp:profit_share:read");
  // A payslip-only token never sees the shareholder tool, and vice versa.
  const payslipTools = ai
    .toolsVisibleForScopes(["mcp:payslip:read"])
    .map((row) => row.code);
  assert.ok(payslipTools.includes("TL-09"));
  assert.ok(!payslipTools.includes("TL-12"));
  const shareTools = ai
    .toolsVisibleForScopes(["mcp:profit_share:read"])
    .map((row) => row.code);
  assert.ok(shareTools.includes("TL-12"));
  assert.ok(!shareTools.includes("TL-09"));
  // Roles map to the matching scope only.
  assert.ok(ai.mcpScopesForRoles(["employee"]).includes("mcp:payslip:read"));
  assert.ok(
    !ai.mcpScopesForRoles(["employee"]).includes("mcp:profit_share:read"),
  );
  assert.ok(
    ai.mcpScopesForRoles(["shareholder"]).includes("mcp:profit_share:read"),
  );
  assert.ok(
    !ai.mcpScopesForRoles(["shareholder"]).includes("mcp:payslip:read"),
  );
});

test("MCP-04 tool call record on channel mcp requires client and token", () => {
  const mcpRecord = f.toolCallRecords.find((row) => row.channel === "mcp");
  accepts(ai.aiToolCallRecordSchema, mcpRecord);
  rejects(ai.aiToolCallRecordSchema, {
    ...clone(mcpRecord),
    mcpClientId: null,
  });
  rejects(ai.aiToolCallRecordSchema, { ...clone(mcpRecord), mcpTokenId: null });
  rejects(ai.aiToolCallRecordSchema, {
    ...clone(mcpRecord),
    mcpClientId: null,
    mcpTokenId: null,
  });
});

test("AIG-01 TL-15 and TL-17 outletIds must be unique", () => {
  for (const code of ["TL-15", "TL-17"]) {
    const schema = ai.AI_TOOL_IO[code].input;
    const input = clone(f.toolSamples[code].input);
    accepts(schema, input);
    const [first] = input.outletIds;
    rejects(schema, { ...input, outletIds: [first, first] });
  }
});

test("AIG-03 action request outlet is derived from distinct outlet ids", () => {
  const input = clone(f.toolSamples["TL-17"].input);
  const draft = ai.toActionRequestDraft({
    ...draftArgs("TL-17"),
    input,
  });
  assert.equal(draft.outletId, input.outletIds[0]);
  // A repeated id is rejected by the input schema before any outlet is derived.
  assert.throws(() =>
    ai.toActionRequestDraft({
      ...draftArgs("TL-17"),
      input: { ...input, outletIds: [input.outletIds[0], input.outletIds[0]] },
    }),
  );
});

test("legend-9v9t every minRoles role template holds the tool's required permissions", () => {
  for (const row of ai.AI_TOOL_CATALOG)
    for (const entry of row.minRoles) {
      const granted = roleTemplate(entry.role).permissions;
      assert.ok(
        ai.roleHoldsToolPermissions(row, entry.role, granted),
        `${row.code} ${entry.role} lacks ${ai
          .requiredPermissionsFor(row, entry.role)
          .filter((code) => !granted.includes(code))
          .join(", ")}`,
      );
    }
});

test("legend-9v9t TL-06 shareholder needs aggregate only, never financial statements", () => {
  const row = tool("TL-06");
  assert.deepEqual(ai.requiredPermissionsFor(row, "shareholder"), [
    "report.aggregate.view",
  ]);
  assert.deepEqual(ai.requiredPermissionsFor(row, "finance"), [
    "report.financial.view",
  ]);
  assert.ok(
    !roleTemplate("shareholder").permissions.includes("report.financial.view"),
  );
});

test("legend-9v9t roles below the PRD minimum are denied and lack a data permission", () => {
  const lower = [
    "employee",
    "cashier",
    "waiter",
    "barista_cook",
    "facility_attendant",
    "shareholder",
  ];
  for (const row of ai.AI_TOOL_CATALOG)
    for (const roleKey of lower) {
      if (row.minRoles.some((entry) => entry.role === roleKey)) continue;
      assert.deepEqual(
        ai.canCallTool({
          tool: row,
          scopes: ai.MCP_SCOPES,
          roles: [roleKey],
        }),
        { allowed: false, reason: "role_not_allowed" },
        `${row.code} ${roleKey}`,
      );
      if (
        row.requiredPermissions.length === 1 &&
        row.requiredPermissions[0] === "ai.ask"
      )
        continue;
      assert.ok(
        !ai.roleHoldsToolPermissions(
          row,
          roleKey,
          roleTemplate(roleKey).permissions,
        ),
        `${row.code} ${roleKey} holds every required permission`,
      );
    }
});

test("legend-9v9t a write tool role override must keep ai.action.propose", () => {
  for (const row of ai.AI_TOOL_CATALOG.filter((r) => r.kind === "write"))
    for (const entry of row.minRoles)
      assert.ok(
        ai
          .requiredPermissionsFor(row, entry.role)
          .includes("ai.action.propose"),
        `${row.code} ${entry.role}`,
      );
});

test("WS-12 catalog header comment matches tools that list ai.ask", () => {
  const src = readFileSync(
    new URL("../packages/shared/src/ai/tools.ts", import.meta.url),
    "utf8",
  );
  const listed = ai.AI_TOOL_CODES.filter((code) =>
    tool(code).requiredPermissions.includes("ai.ask"),
  );
  assert.deepEqual(listed.sort(), ["TL-08"]);
  assert.match(src, /listed only where it is the tool's sole requirement/);
});

test("MCP-02 mcp_token.issued carries the stored mcp_ prefix and real scopes only", () => {
  const token = f.mcpTokens[0];
  const payload = {
    mcpTokenId: token.id,
    mcpClientId: token.clientId,
    userId: token.userId,
    tokenPrefix: token.tokenPrefix,
    scopes: token.scopes,
    expiresAt: token.expiresAt,
    issuedAt: token.createdAt,
  };
  accepts(ai.mcpTokenIssuedEventPayloadSchema, payload);
  rejects(ai.mcpTokenIssuedEventPayloadSchema, {
    ...payload,
    tokenPrefix: token.tokenPrefix.slice(4),
  });
  rejects(ai.mcpTokenIssuedEventPayloadSchema, {
    ...payload,
    scopes: ["mcp:evil:read"],
  });
  rejects(ai.mcpTokenIssuedEventPayloadSchema, {
    ...payload,
    token: "mcp_rawsecretvalue",
  });
});

test("ai_job.completed matches the ai_jobs limits: 50 tools, cost never negative", () => {
  const job = f.aiJobs[0];
  const payload = {
    aiJobId: job.id,
    userId: job.userId,
    feature: job.feature,
    channel: job.channel,
    status: job.status,
    blockedReason: job.blockedReason,
    toolsCalled: Array.from({ length: 50 }, () => "TL-01"),
    tokensIn: job.tokensIn,
    tokensOut: job.tokensOut,
    costIdr: job.costIdr,
    completedAt: job.createdAt,
  };
  accepts(ai.aiJobCompletedEventPayloadSchema, payload);
  rejects(ai.aiJobCompletedEventPayloadSchema, { ...payload, costIdr: -1 });
  rejects(ai.aiJobCompletedEventPayloadSchema, {
    ...payload,
    toolsCalled: Array.from({ length: 51 }, () => "TL-01"),
  });
});

test("token list query reads includeInactive from a query string", () => {
  assert.equal(
    ai.mcpTokenListQuerySchema.parse({ includeInactive: "false" })
      .includeInactive,
    false,
  );
  assert.equal(
    ai.mcpTokenListQuerySchema.parse({ includeInactive: "true" })
      .includeInactive,
    true,
  );
  rejects(ai.mcpTokenListQuerySchema, { includeInactive: "maybe" });
});

test("events mirror stored rules: token scopes non-empty and unique, blockedReason iff blocked", () => {
  const token = f.mcpTokens[0];
  const issued = {
    mcpTokenId: token.id,
    mcpClientId: token.clientId,
    userId: token.userId,
    tokenPrefix: token.tokenPrefix,
    scopes: token.scopes,
    expiresAt: token.expiresAt,
    issuedAt: token.createdAt,
  };
  rejects(ai.mcpTokenIssuedEventPayloadSchema, { ...issued, scopes: [] });
  rejects(ai.mcpTokenIssuedEventPayloadSchema, {
    ...issued,
    scopes: [token.scopes[0], token.scopes[0]],
  });
  const job = f.aiJobs.find((row) => row.status === "succeeded");
  const done = {
    aiJobId: job.id,
    userId: job.userId,
    feature: job.feature,
    channel: job.channel,
    status: "succeeded",
    blockedReason: null,
    toolsCalled: job.toolsCalled,
    tokensIn: job.tokensIn,
    tokensOut: job.tokensOut,
    costIdr: job.costIdr,
    completedAt: job.createdAt,
  };
  accepts(ai.aiJobCompletedEventPayloadSchema, done);
  rejects(ai.aiJobCompletedEventPayloadSchema, {
    ...done,
    blockedReason: "quota_exceeded",
  });
  rejects(ai.aiJobCompletedEventPayloadSchema, { ...done, status: "blocked" });
  accepts(ai.aiJobCompletedEventPayloadSchema, {
    ...done,
    status: "blocked",
    blockedReason: "quota_exceeded",
  });
});

// ---- FE contract gaps (legend-hi82, jk6s, mlnu, tpw4) -----------------------

test("legend-tpw4 tool_request.approved is gone from the event catalog", () => {
  const names = new Set(events.eventCatalog.map((entry) => entry.name));
  assert.ok(!names.has("tool_request.approved"));
  assert.ok(names.has("action_request.approved"));
});

test("legend-hi82 governance tools list carries the kill switch state", () => {
  const summary = ai.aiToolSummarySchema.parse({
    code: "TL-01",
    name: tool("TL-01").name,
    kind: "read",
    titleId: tool("TL-01").titleId,
    description: tool("TL-01").description,
    scope: tool("TL-01").scope,
    mcpAnnotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  });
  accepts(ai.aiGovernanceToolSchema, { ...summary, isEnabled: false });
  rejects(ai.aiGovernanceToolSchema, summary);
  assert.equal(ai.listAiGovernanceTools.path, "/api/ai/governance/tools");
});

test("legend-hi82 tenant usage and tool-call audit list schemas", () => {
  const usage = {
    month: "2026-11",
    budget: {
      monthlyBudgetIdr: 1000000,
      usedIdr: 820000,
      warnPct: 80,
      stopPct: 100,
      state: "warn",
    },
    byFeature: [
      {
        feature: f.aiJobs[0].feature,
        jobs: 10,
        blockedJobs: 1,
        tokensIn: 1000,
        tokensOut: 500,
        costIdr: 1200,
      },
    ],
    blockedByReason: [{ reason: "quota_exceeded", count: 1 }],
    mcpToolCalls: 3,
  };
  accepts(ai.aiTenantUsageSchema, usage);
  rejects(ai.aiTenantUsageSchema, { ...usage, month: "2026-13" });
  rejects(ai.aiTenantUsageSchema, { ...usage, extra: 1 });
  rejects(ai.aiTenantUsageSchema, {
    ...usage,
    blockedByReason: [{ reason: "nope", count: 1 }],
  });
  accepts(ai.aiTenantUsageQuerySchema, {});
  rejects(ai.aiTenantUsageQuerySchema, { month: "Nov" });
  accepts(ai.aiToolCallListQuerySchema, { channel: "mcp", outcome: "denied" });
  rejects(ai.aiToolCallListQuerySchema, { outcome: "weird" });
  for (const record of f.toolCallRecords)
    accepts(ai.aiToolCallRecordSchema, record);
  assert.equal(ai.listAiToolCalls.path, "/api/ai/tool-calls");
});

test("legend-hi82 token summary shows optional names, usage shows provider state", () => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- drop the hash from the summary
  const { tokenHash: _hash, ...rest } = f.mcpTokens[0];
  const summary = {
    id: rest.id,
    tenantId: rest.tenantId,
    clientId: rest.clientId,
    userId: rest.userId,
    tokenPrefix: rest.tokenPrefix,
    scopes: rest.scopes,
    expiresAt: rest.expiresAt,
    revokedAt: rest.revokedAt,
    lastUsedAt: rest.lastUsedAt,
    createdAt: rest.createdAt,
  };
  accepts(ai.mcpTokenSummarySchema, summary);
  accepts(ai.mcpTokenSummarySchema, {
    ...summary,
    clientName: "Claude Desktop",
    userDisplayName: "Rina",
  });
  const usage = {
    aiEnabled: true,
    platformLocked: false,
    month: "2026-11",
    features: [],
    budget: null,
  };
  accepts(ai.aiUsageSummarySchema, usage);
  accepts(ai.aiUsageSummarySchema, { ...usage, providerAvailable: false });
  rejects(ai.aiUsageSummarySchema, { ...usage, platformLocked: undefined });
});

test("legend-jk6s approval inbox reads an action request with a redacted summary", () => {
  const review = {
    actionRequest: pendingAi,
    toolTitleId: "Ubah harga menu",
    requestedByName: "Rina",
    outletName: null,
    summary: [{ label: "Harga baru", value: "Rp 25.000" }],
  };
  accepts(ai.actionRequestReviewSchema, review);
  rejects(ai.actionRequestReviewSchema, {
    ...review,
    summary: [{ label: "", value: "x" }],
  });
  rejects(ai.actionRequestReviewSchema, { ...review, extra: 1 });
  accepts(ai.actionRequestListQuerySchema, {
    approvalRequestId: pendingAi.approvalRequestId,
  });
  rejects(ai.actionRequestListQuerySchema, { approvalRequestId: "nope" });
  accepts(ai.getActionRequestByApproval.params, {
    approvalRequestId: pendingAi.approvalRequestId,
  });
});

test("legend-jk6s guidelines page content is strict and non-empty", () => {
  const guidelines = {
    version: "1",
    updatedAt: f.now,
    sections: [
      {
        id: "data-pribadi",
        titleId: "Data pribadi",
        paragraphsId: ["Jangan kirim NIK atau rekening."],
      },
    ],
  };
  accepts(ai.aiGuidelinesSchema, guidelines);
  rejects(ai.aiGuidelinesSchema, { ...guidelines, sections: [] });
  rejects(ai.aiGuidelinesSchema, {
    ...guidelines,
    sections: [{ ...guidelines.sections[0], paragraphsId: [] }],
  });
  assert.equal(ai.getAiGuidelines.path, "/api/ai/guidelines");
});

test("legend-mlnu chat answer carries sources, Dibantu AI flag and deletes by id", () => {
  const assistant = f.messages.find((m) => m.role === "assistant");
  const sourced = {
    ...assistant,
    sources: [
      {
        label: "Penjualan harian",
        link: "/laporan/penjualan",
        period: { from: "2026-11-01", to: "2026-11-07" },
      },
    ],
  };
  accepts(ai.aiMessageSchema, sourced);
  rejects(ai.aiMessageSchema, { ...sourced, aiAssisted: false });
  assert.equal(ai.deleteAiConversation.method, "DELETE");
  assert.ok(ai.aiErrorHttpStatus.AI_PROVIDER_UNAVAILABLE === 503);
});

test("MCP-05 consent preview: strict query, labelled scopes, every scope has an Indonesian label", () => {
  assert.equal(ai.previewMcpAuthorize.method, "GET");
  assert.equal(ai.previewMcpAuthorize.path, "/api/ai/mcp/authorize/preview");
  const query = {
    client_id: "acc-1",
    redirect_uri: "http://localhost:8123/cb",
  };
  accepts(ai.mcpAuthorizePreviewQuerySchema, query);
  rejects(ai.mcpAuthorizePreviewQuerySchema, { ...query, extra: "x" });
  rejects(ai.mcpAuthorizePreviewQuerySchema, { client_id: "acc-1" });
  for (const scope of ai.MCP_SCOPES)
    assert.ok(ai.MCP_SCOPE_LABELS_ID[scope], `${scope} has a label`);
  const preview = {
    clientName: "Klien uji",
    redirectUri: query.redirect_uri,
    scopes: [
      { scope: "mcp:sop:read", label: ai.MCP_SCOPE_LABELS_ID["mcp:sop:read"] },
    ],
  };
  accepts(ai.mcpAuthorizePreviewSchema, preview);
  rejects(ai.mcpAuthorizePreviewSchema, { ...preview, scopes: [] });
  rejects(ai.mcpAuthorizePreviewSchema, {
    ...preview,
    scopes: [{ scope: "mcp:evil:read", label: "x" }],
  });
});

// ---- Per-tenant AI provider (legend-dwrr) ----------------------------------

test("legend-dwrr provider read schema has no key field and stays strict", () => {
  const config = {
    connectionType: "api_key",
    baseUrl: "https://api.example.com/v1",
    defaultModel: "gpt-4o-mini",
    capabilities: {
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      supportsTools: true,
      supportsReasoning: false,
      reasoningEfforts: [],
      source: "known",
    },
    capabilityOverrides: null,
    hasKey: true,
    keyLast4: "abcd",
    keySetAt: "2026-11-10T01:00:00.000Z",
    lastTest: {
      status: "failed",
      testedAt: "2026-11-10T01:05:00.000Z",
      errorCode: "AUTH_FAILED",
    },
    updatedAt: "2026-11-10T01:05:00.000Z",
  };
  accepts(ai.aiProviderConfigSchema, config);
  const view = { config, fallbackAvailable: false, platformLocked: false };
  accepts(ai.aiProviderViewSchema, view);
  accepts(ai.aiProviderViewSchema, { ...view, platformLocked: true });
  accepts(ai.aiProviderViewSchema, {
    config: null,
    fallbackAvailable: true,
    platformLocked: false,
  });
  rejects(ai.aiProviderViewSchema, { config, fallbackAvailable: false });
  for (const extra of ["apiKey", "api_key", "key", "apiKeyEncrypted"]) {
    rejects(ai.aiProviderConfigSchema, { ...config, [extra]: "sk-secret" });
  }
  rejects(ai.aiProviderConfigSchema, { ...config, keyLast4: "abcde" });
  rejects(ai.aiProviderConfigSchema, {
    ...config,
    lastTest: { ...config.lastTest, errorCode: "boom" },
  });
  assert.deepEqual(Object.keys(ai.aiProviderConfigSchema.shape).sort(), [
    "baseUrl",
    "capabilities",
    "capabilityOverrides",
    "connectionType",
    "defaultModel",
    "hasKey",
    "keyLast4",
    "keySetAt",
    "lastTest",
    "updatedAt",
  ]);
});

test("legend-dwrr provider upsert input validation", () => {
  const input = {
    connectionType: "api_key",
    baseUrl: "https://api.example.com/v1",
    defaultModel: "gpt-4o-mini",
    apiKey: "sk-0123456789abcdef",
  };
  accepts(ai.upsertAiProviderConfigInputSchema, input);
  const withoutKey = { ...input };
  delete withoutKey.apiKey;
  accepts(ai.upsertAiProviderConfigInputSchema, withoutKey);
  accepts(ai.upsertAiProviderConfigInputSchema, {
    ...input,
    connectionType: "chatgpt_oauth",
  });
  rejects(ai.upsertAiProviderConfigInputSchema, {
    ...input,
    tenantId: "00000000-0000-4000-8000-000000000001",
  });
  rejects(ai.upsertAiProviderConfigInputSchema, { ...input, apiKey: "short" });
  rejects(ai.upsertAiProviderConfigInputSchema, {
    ...input,
    apiKey: "sk-0123456789 abcdef",
  });
  rejects(ai.upsertAiProviderConfigInputSchema, {
    ...input,
    defaultModel: "bad model!",
  });
  rejects(ai.upsertAiProviderConfigInputSchema, { ...input, baseUrl: "  " });
  rejects(ai.upsertAiProviderConfigInputSchema, {
    ...input,
    connectionType: "oauth",
  });
  assert.equal(
    ai.upsertAiProviderConfigInputSchema.parse({
      ...input,
      baseUrl: "  https://api.example.com/v1  ",
    }).baseUrl,
    "https://api.example.com/v1",
  );
});

test("legend-dwrr provider test result, error codes and messages", () => {
  accepts(ai.aiProviderTestResultSchema, {
    status: "ok",
    testedAt: "2026-11-10T01:05:00.000Z",
    errorCode: null,
  });
  rejects(ai.aiProviderTestResultSchema, {
    status: "failed",
    testedAt: "2026-11-10T01:05:00.000Z",
    errorCode: "Bearer sk-secret",
  });
  assert.equal(ai.AI_PROVIDER_TEST_ERROR_CODES.length, 11);
  assert.deepEqual(
    Object.keys(ai.aiProviderTestErrorMessages).sort(),
    [...ai.AI_PROVIDER_TEST_ERROR_CODES].sort(),
  );
  for (const code of ai.AI_PROVIDER_TEST_ERROR_CODES) {
    assert.ok(ai.aiProviderTestErrorMessages[code].length > 0);
  }
});

test("legend-dwrr provider endpoints and error codes", () => {
  assert.deepEqual(
    [
      ai.getAiProviderConfig,
      ai.upsertAiProviderConfig,
      ai.deleteAiProviderConfig,
      ai.testAiProviderConfig,
    ].map((e) => `${e.method} ${e.path}`),
    [
      "GET /api/ai/provider",
      "PUT /api/ai/provider",
      "DELETE /api/ai/provider",
      "POST /api/ai/provider/test",
    ],
  );
  accepts(ai.testAiProviderConfig.body, {});
  rejects(ai.testAiProviderConfig.body, { apiKey: "x" });
  const expected = {
    AI_PROVIDER_URL_BLOCKED: 422,
    AI_PROVIDER_KEY_REQUIRED: 422,
    AI_PROVIDER_CONNECTION_UNSUPPORTED: 422,
    AI_PROVIDER_NOT_CONFIGURED: 404,
    AI_PROVIDER_TEST_TOO_SOON: 429,
  };
  for (const [code, status] of Object.entries(expected)) {
    assert.equal(ai.aiErrorHttpStatus[code], status);
    const err = new ai.AiError(code);
    assert.equal(err.status, status);
    assert.ok(err.message.length > 0);
  }
});

test("legend-39d.8 A2 capability overrides reject unbounded, inverted and injected values", () => {
  accepts(ai.aiModelCapabilityOverridesSchema, {
    contextWindow: 16_384,
    maxOutputTokens: 2048,
    supportsReasoning: false,
  });
  accepts(ai.aiModelCapabilityOverridesSchema, { supportsTools: true });
  for (const value of [
    { contextWindow: 0 },
    { contextWindow: 2_000_001 },
    { maxOutputTokens: 0 },
    { contextWindow: 4096, maxOutputTokens: 4096 },
    { contextWindow: 4096, maxOutputTokens: 8192 },
    { tenantId: "injected" },
    { reasoningEfforts: ["unlimited"] },
  ])
    rejects(ai.aiModelCapabilityOverridesSchema, value);
});

test("legend-z83k B1 UI login bodies accept model-free start/poll and optional legacy inputs without identity injection", () => {
  accepts(ai.startChatgptLogin.body, { riskAccepted: true });
  accepts(ai.startChatgptLogin.body, {
    model: "gpt-5-codex",
    riskAccepted: true,
  });
  for (const body of [
    {},
    { model: "gpt-5-codex" },
    { riskAccepted: false },
    { riskAccepted: true, tenantId: "injected" },
    { riskAccepted: true, acceptedBy: "injected" },
  ])
    rejects(ai.startChatgptLogin.body, body);
  accepts(ai.pollChatgptLogin.body, {});
  accepts(ai.pollChatgptLogin.body, {
    attemptId: "123e4567-e89b-42d3-a456-426614174000",
  });
  rejects(ai.pollChatgptLogin.body, {
    attemptId: "123e4567-e89b-42d3-a456-426614174000",
    tenantId: "injected",
  });
});

test("legend-z83k B2 the eight-field UI status never accepts tokens, grant secrets or a server attempt ID", () => {
  const view = {
    state: "connected",
    platformDisabled: false,
    viewerCanManage: true,
    deviceCode: null,
    verificationUrl: null,
    expiresAt: null,
    connectedAt: "2026-11-13T01:01:00.000Z",
    riskAcceptedAt: "2026-11-13T01:00:00.000Z",
  };
  accepts(ai.chatgptLoginStatusSchema, view);
  assert.deepEqual(
    Object.keys(ai.chatgptLoginStatusSchema.shape).sort(),
    [
      "state",
      "platformDisabled",
      "viewerCanManage",
      "deviceCode",
      "verificationUrl",
      "expiresAt",
      "connectedAt",
      "riskAcceptedAt",
    ].sort(),
  );
  assert.deepEqual(ai.CHATGPT_LOGIN_STATES, [
    "disconnected",
    "pending",
    "connected",
    "failed",
    "expired",
  ]);
  for (const key of [
    "accessToken",
    "refreshToken",
    "tokensEncrypted",
    "deviceAuthId",
    "codeVerifier",
    "authorizationCode",
    "attemptId",
    "credentialVersion",
    "model",
    "consent",
  ])
    rejects(ai.chatgptLoginStatusSchema, { ...view, [key]: "secret" });
  accepts(ai.chatgptLoginStatusSchema, {
    ...view,
    state: "pending",
    deviceCode: "ABCD-EFGH",
    verificationUrl: "https://auth.openai.com/codex/device",
    expiresAt: "2026-11-13T01:15:00.000Z",
  });
});

test("legend-z83k B1 canonical UI endpoints and safe error codes have fixed contract paths", () => {
  assert.deepEqual(
    [
      ai.getChatgptLogin,
      ai.startChatgptLogin,
      ai.pollChatgptLogin,
      ai.revokeChatgptLogin,
    ].map((endpoint) => `${endpoint.method} ${endpoint.path}`),
    [
      "GET /api/ai/chatgpt",
      "POST /api/ai/chatgpt/device",
      "POST /api/ai/chatgpt/device/poll",
      "DELETE /api/ai/chatgpt",
    ],
  );
  for (const [code, status] of Object.entries({
    AI_CHATGPT_DISABLED: 503,
    AI_CHATGPT_NOT_CONNECTED: 404,
    AI_CHATGPT_RATE_LIMITED: 429,
  }))
    assert.equal(new ai.AiError(code).status, status);
});

test("legend-39d.8 A2 capability PATCH accepts a partial override or clear and rejects missing/extra top-level fields", () => {
  accepts(ai.patchAiProviderConfigInputSchema, {
    capabilityOverrides: { maxOutputTokens: 1024 },
  });
  accepts(ai.patchAiProviderConfigInputSchema, { capabilityOverrides: {} });
  accepts(ai.patchAiProviderConfigInputSchema, { capabilityOverrides: null });
  rejects(ai.patchAiProviderConfigInputSchema, {});
  rejects(ai.patchAiProviderConfigInputSchema, {
    capabilityOverrides: {},
    tenantId: "injected",
  });
  rejects(ai.patchAiProviderConfigInputSchema, {
    capabilities: { maxOutputTokens: 1024 },
  });
  assert.equal(ai.patchAiProviderConfig.method, "PATCH");
  assert.equal(ai.patchAiProviderConfig.path, "/api/ai/provider");
});
