// Action requests for AI write tools (part W, bead legend-zw9r): propose only,
// approval decides, execution runs as the requester, settle is idempotent.
// Real PostgreSQL and the real approval service; the worker is replaced by a
// direct `settleActionRequest` call (the worker hook only adds the event
// checks). Fixtures come from ai-acceptance-helpers (users, roles, menu item).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { AiError } from "@starter/shared/ai";
import { approvalRequestIdSchema } from "@starter/shared/identity";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  resolveAccessSnapshot,
  loadTenantAccess,
  type AccessSnapshot,
} from "../services/permission-resolver.ts";
import {
  getActionRequestReview,
  adjustmentValueIdr,
  getActionRequestStatus,
  pickApprovalAction,
  getActionRequestView,
  proposeActionRequest,
  settleActionRequest,
} from "../services/ai-action-request.service.ts";
import { writeTools } from "../services/ai-tools/write/index.ts";
import type { AiToolContext } from "../services/ai-tools/types.ts";
import {
  availabilityFingerprint,
  cleanupAcceptance,
  createMenuItem,
  grantTemplateRole,
  newOwner,
  originHeader,
  outletA,
  outletB,
  ownerPool,
  removeAssignments,
  signedIn,
  tenantId,
  type Actor,
} from "./ai-acceptance-helpers.ts";

const tenant = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
const workerContext = establishScopedTenantContext(tenant, { kind: "tenant" });

async function accessOf(userId: string): Promise<AccessSnapshot> {
  const data = await loadTenantAccess(workerContext, userId);
  return resolveAccessSnapshot({
    tenant,
    userId,
    ...data,
    mfaVerified: true,
    now: new Date(),
  });
}

/** Events of one name for one action request, read by aggregate so other suites' events never crowd it out. */
async function eventCount(name: string, actionRequestId: string) {
  const { rows } = await ownerPool.query(
    `SELECT 1 FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = $3`,
    [tenantId, actionRequestId, name],
  );
  return rows.length;
}

async function ctxOf(actor: Actor): Promise<AiToolContext> {
  return {
    access: await accessOf(actor.userId),
    channel: "tanya_ai",
    mcpClientId: null,
    now: new Date(),
  };
}

async function requesterWithApprover() {
  const owner = await newOwner();
  const menuItemId = await createMenuItem(owner);
  const requester = await signedIn("Kitchen Lead W");
  await grantTemplateRole(requester.userId, "kitchen_lead", {
    type: "outlet",
    id: outletA,
  });
  const approver = await signedIn("Manajer W");
  await grantTemplateRole(approver.userId, "outlet_manager", {
    type: "outlet",
    id: outletA,
  });
  return { menuItemId, requester, approver };
}

const draft = (menuItemId: string) => ({
  outletId: outletA,
  items: [{ menuItemId, available: false }],
  reason: "Bahan habis",
});

async function decide(
  approver: Actor,
  approvalRequestId: string,
  decision: "approved" | "rejected",
) {
  const res = await approver.client
    .post(`/api/approvals/${approvalRequestId}/decisions`)
    .set(originHeader)
    .send({ decision, reason: "Uji action request" });
  expect(res.status).toBe(200);
}

afterAll(async () => {
  await cleanupAcceptance().catch(() => undefined);
  await ownerPool.end();
});

describe("action requests (AIG-03)", () => {
  it("[AIG-03] proposes without mutating, stays pending, executes once after approval", async () => {
    const { menuItemId, requester, approver } = await requesterWithApprover();
    const before = await availabilityFingerprint(menuItemId);
    const ctx = await ctxOf(requester);

    const receipt = (await writeTools["TL-18"]!(ctx, draft(menuItemId))) as {
      actionRequestId: string;
      approvalRequestId: string;
      status: string;
    };
    expect(receipt.status).toBe("pending");
    expect(await availabilityFingerprint(menuItemId)).toBe(before);
    const review = await getActionRequestReview(
      ctx.access,
      receipt.approvalRequestId,
    );
    expect(review.actionRequest.id).toBe(receipt.actionRequestId);
    expect(review.outletName).not.toBeNull();
    await expect(
      getActionRequestReview(
        await accessOf((await signedIn("Orang Asing R")).userId),
        receipt.approvalRequestId,
      ),
    ).rejects.toMatchObject({ code: "ACTION_REQUEST_NOT_FOUND" });
    expect(
      await eventCount("action_request.created", receipt.actionRequestId),
    ).toBe(1);

    // Chain still open: settle does nothing.
    expect(
      await settleActionRequest(workerContext, receipt.actionRequestId),
    ).toBe("pending");
    expect(await availabilityFingerprint(menuItemId)).toBe(before);
    expect(
      await eventCount("action_request.executed", receipt.actionRequestId),
    ).toBe(0);

    await decide(approver, receipt.approvalRequestId, "approved");
    const [a, b] = await Promise.all([
      settleActionRequest(workerContext, receipt.actionRequestId),
      settleActionRequest(workerContext, receipt.actionRequestId),
    ]);
    expect([a, b]).toEqual(["executed", "executed"]);
    expect(await availabilityFingerprint(menuItemId)).not.toBe(before);

    // Double delivery executes once: one executed event, row stays executed.
    const after = await availabilityFingerprint(menuItemId);
    expect(
      await settleActionRequest(workerContext, receipt.actionRequestId),
    ).toBe("executed");
    expect(await availabilityFingerprint(menuItemId)).toBe(after);
    expect(
      await eventCount("action_request.executed", receipt.actionRequestId),
    ).toBe(1);

    const status = (await writeTools["TL-19"]!(ctx, {
      actionRequestId: receipt.actionRequestId,
    })) as { status: string; approvalStatus: string; resultRef: string | null };
    expect(status.status).toBe("executed");
    expect(status.approvalStatus).toBe("approved");
    expect(status.resultRef).not.toBeNull();
    approvalRequestIdSchema.parse(receipt.approvalRequestId);
  }, 60_000);

  it("[AIG-03] a requester without approval authority cannot approve or execute the draft", async () => {
    const { menuItemId, requester, approver } = await requesterWithApprover();
    const before = await availabilityFingerprint(menuItemId);
    const receipt = (await writeTools["TL-18"]!(
      await ctxOf(requester),
      draft(menuItemId),
    )) as { actionRequestId: string; approvalRequestId: string };

    const denied = await requester.client
      .post(`/api/approvals/${receipt.approvalRequestId}/decisions`)
      .set(originHeader)
      .send({
        decision: "approved",
        reason: "Attempt without approval authority",
      });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(
      await settleActionRequest(workerContext, receipt.actionRequestId),
    ).toBe("pending");
    expect(await availabilityFingerprint(menuItemId)).toBe(before);
    expect(
      await eventCount("action_request.executed", receipt.actionRequestId),
    ).toBe(0);

    // The same valid draft succeeds once the designated human approver decides.
    await decide(approver, receipt.approvalRequestId, "approved");
    expect(
      await settleActionRequest(workerContext, receipt.actionRequestId),
    ).toBe("executed");
    expect(await availabilityFingerprint(menuItemId)).not.toBe(before);
  }, 60_000);

  it("[AIG-03] a rejected request never changes data", async () => {
    const { menuItemId, requester, approver } = await requesterWithApprover();
    const before = await availabilityFingerprint(menuItemId);
    const ctx = await ctxOf(requester);
    const receipt = (await writeTools["TL-18"]!(ctx, draft(menuItemId))) as {
      actionRequestId: string;
      approvalRequestId: string;
    };
    await decide(approver, receipt.approvalRequestId, "rejected");
    expect(
      await settleActionRequest(workerContext, receipt.actionRequestId),
    ).toBe("rejected");
    expect(await availabilityFingerprint(menuItemId)).toBe(before);
    expect(
      (await getActionRequestView(ctx.access, receipt.actionRequestId)).status,
    ).toBe("rejected");
  }, 60_000);

  it("[AIG-03] re-checks the requester at execution time: lost permission means failed, no change", async () => {
    const { menuItemId, requester, approver } = await requesterWithApprover();
    const before = await availabilityFingerprint(menuItemId);
    const ctx = await ctxOf(requester);
    const receipt = (await writeTools["TL-18"]!(ctx, draft(menuItemId))) as {
      actionRequestId: string;
      approvalRequestId: string;
    };
    await decide(approver, receipt.approvalRequestId, "approved");
    await removeAssignments(requester.userId);
    expect(
      await settleActionRequest(workerContext, receipt.actionRequestId),
    ).toBe("failed");
    expect(await availabilityFingerprint(menuItemId)).toBe(before);
    const row = await ownerPool.query(
      "SELECT failure_reason FROM action_requests WHERE id = $1",
      [receipt.actionRequestId],
    );
    expect(row.rows[0].failure_reason).toMatch(/izin/);
  }, 60_000);

  it("refuses a proposal for an outlet outside the caller's reach and for a caller without a role", async () => {
    const { menuItemId, requester } = await requesterWithApprover();
    const ctx = await ctxOf(requester);
    await expect(
      writeTools["TL-18"]!(ctx, { ...draft(menuItemId), outletId: outletB }),
    ).rejects.toMatchObject({ code: "AI_TOOL_FORBIDDEN" });
    const nobody = await signedIn("Tanpa Peran W");
    await expect(
      writeTools["TL-18"]!(await ctxOf(nobody), draft(menuItemId)),
    ).rejects.toMatchObject({ code: "AI_TOOL_FORBIDDEN" });
  });

  it("TL-13 and TL-16 have no module to write to: AI_TOOL_DISABLED", async () => {
    const { requester } = await requesterWithApprover();
    await grantTemplateRole(requester.userId, "purchasing", { type: "tenant" });
    await grantTemplateRole(requester.userId, "hr", { type: "tenant" });
    const ctx = await ctxOf(requester);
    for (const code of ["TL-13", "TL-16"] as const) {
      const error = await writeTools[code]!(ctx, {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AiError);
      expect((error as AiError).code).toBe("AI_TOOL_DISABLED");
    }
  });

  it("another user, and another tenant, cannot see the request (404-style)", async () => {
    const { menuItemId, requester } = await requesterWithApprover();
    const receipt = (await writeTools["TL-18"]!(
      await ctxOf(requester),
      draft(menuItemId),
    )) as { actionRequestId: string };
    const stranger = await signedIn("Orang Asing W");
    await expect(
      getActionRequestView(
        await accessOf(stranger.userId),
        receipt.actionRequestId,
      ),
    ).rejects.toMatchObject({ code: "ACTION_REQUEST_NOT_FOUND" });
    await expect(
      getActionRequestStatus(await ctxOf(stranger), receipt.actionRequestId),
    ).rejects.toMatchObject({ code: "ACTION_REQUEST_NOT_FOUND" });

    // Same user id and "allow everything" access, but another tenant: RLS hides it.
    const foreign = {
      ...(await accessOf(requester.userId)),
      tenant: establishTenantContext({
        tenantId: randomUUID(),
        brandId: null,
        source: "session",
      }),
    } as AccessSnapshot;
    await expect(
      getActionRequestView(foreign, receipt.actionRequestId),
    ).rejects.toMatchObject({ code: "ACTION_REQUEST_NOT_FOUND" });
  });

  it("proposeActionRequest refuses an MCP call without a client", async () => {
    const { menuItemId, requester } = await requesterWithApprover();
    const ctx = { ...(await ctxOf(requester)), channel: "mcp" as const };
    await expect(
      proposeActionRequest(ctx, "TL-18", draft(menuItemId)),
    ).rejects.toMatchObject({ code: "AI_TOOL_FORBIDDEN" });
  });
});

// ---- Two-policy approval, execution re-check, idempotency ------------------

const MODULE_ACTIONS = ["price_change", "stock_adjustment"];

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await ownerPool.query(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  return rows[0].id as string;
}

/** Runs `body` with exactly these module policies, restoring the matrix after. */
async function withModulePolicies(
  policies: {
    action: string;
    threshold: number | null;
    role: string;
    levels: number;
  }[],
  body: () => Promise<void>,
) {
  const saved = (
    await ownerPool.query(
      "SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])",
      [tenantId, MODULE_ACTIONS],
    )
  ).rows;
  await ownerPool.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])",
    [tenantId, MODULE_ACTIONS],
  );
  try {
    for (const policy of policies)
      await ownerPool.query(
        `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          tenantId,
          policy.action,
          policy.threshold,
          await roleIdOf(policy.role),
          policy.levels,
        ],
      );
    await body();
  } finally {
    await ownerPool.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])",
      [tenantId, MODULE_ACTIONS],
    );
    for (const row of saved)
      await ownerPool.query(
        `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          row.id,
          row.tenant_id,
          row.action_type,
          row.threshold_idr,
          row.approver_role_id,
          row.levels,
          row.requires_distinct_actor,
        ],
      );
  }
}

const approvalOf = async (approvalRequestId: string) =>
  (
    await ownerPool
      .query(
        "SELECT action_type, required_levels, approver_role_ids FROM approval_requests WHERE id = $1",
        [approvalRequestId],
      )
      .catch(() =>
        ownerPool.query(
          "SELECT action_type, required_levels FROM approval_requests WHERE id = $1",
          [approvalRequestId],
        ),
      )
  ).rows[0] as { action_type: string; required_levels: number };

async function gmRequester() {
  const gm = await signedIn("GM W");
  await grantTemplateRole(gm.userId, "general_manager", { type: "tenant" });
  return gm;
}

const priceDraft = () => ({
  changes: [{ menuItemId: randomUUID(), newPriceIdr: 25_000 }],
  effectiveAt: new Date(Date.now() + 86_400_000).toISOString(),
});

describe("two-policy approval (AIG-03)", () => {
  it("a price change opens the module's general-manager policy, not the weaker AI one", async () => {
    const gm = await gmRequester();
    await withModulePolicies(
      [
        {
          action: "price_change",
          threshold: null,
          role: "general_manager",
          levels: 1,
        },
      ],
      async () => {
        const receipt = (await writeTools["TL-17"]!(
          await ctxOf(gm),
          priceDraft(),
        )) as {
          approvalRequestId: string;
        };
        const approval = await approvalOf(receipt.approvalRequestId);
        expect(approval.action_type).toBe("price_change");
        // The chosen type is stored on the action request too.
        const stored = await ownerPool.query(
          "SELECT approval_action_type FROM action_requests WHERE approval_request_id = $1",
          [receipt.approvalRequestId],
        );
        expect(stored.rows[0]?.approval_action_type).toBe("price_change");
      },
    );
    // No module policy configured: the AI rule applies.
    await withModulePolicies([], async () => {
      const receipt = (await writeTools["TL-17"]!(
        await ctxOf(gm),
        priceDraft(),
      )) as {
        approvalRequestId: string;
      };
      expect((await approvalOf(receipt.approvalRequestId)).action_type).toBe(
        "ai_action",
      );
    });
  }, 60_000);

  it("a stock adjustment follows the value tiers of the module policy", async () => {
    await withModulePolicies(
      [
        {
          action: "stock_adjustment",
          threshold: 2_000_000,
          role: "outlet_manager",
          levels: 1,
        },
        {
          action: "stock_adjustment",
          threshold: 2_000_000,
          role: "general_manager",
          levels: 2,
        },
      ],
      async () => {
        const pick = (amountIdr: number | null) =>
          withTenant(db, workerContext, (tx) =>
            pickApprovalAction(tx, tenantId, {
              source: "ai",
              moduleAction: "stock_adjustment",
              amountIdr,
            }),
          );
        // Below the tier the module asks for nothing: AI rule. Above: module (2 levels > AI's 1).
        expect(await pick(500_000)).toBe("ai_action");
        expect(await pick(3_000_000)).toBe("stock_adjustment");
        // Unknown amount fails closed: every tier applies.
        expect(await pick(null)).toBe("stock_adjustment");
      },
    );
    expect(
      adjustmentValueIdr(
        [
          { inventoryItemId: "a", qtyDelta: "-2.5000" },
          { inventoryItemId: "b", qtyDelta: "1.0000" },
        ],
        new Map([
          ["a", "10000.0000"],
          ["b", "500.2500"],
        ]),
      ),
    ).toBe(25_501);
    expect(
      adjustmentValueIdr(
        [{ inventoryItemId: "x", qtyDelta: "1.0000" }],
        new Map(),
      ),
    ).toBeNull();
  });

  it("an unknown stock cost opens the highest module tier", async () => {
    const { requester } = await requesterWithApprover();
    await grantTemplateRole(requester.userId, "warehouse", {
      type: "outlet",
      id: outletA,
    });
    await withModulePolicies(
      [
        {
          action: "stock_adjustment",
          threshold: null,
          role: "outlet_manager",
          levels: 1,
        },
        {
          action: "stock_adjustment",
          threshold: null,
          role: "general_manager",
          levels: 2,
        },
      ],
      async () => {
        const receipt = (await writeTools["TL-14"]!(await ctxOf(requester), {
          outletId: outletA,
          lines: [
            {
              inventoryItemId: randomUUID(),
              qtyDelta: "-1.0000",
              reason: "Rusak",
            },
          ],
        })) as { approvalRequestId: string };
        const approval = await approvalOf(receipt.approvalRequestId);
        expect(approval.action_type).toBe("stock_adjustment");
        expect(approval.required_levels).toBe(2);
      },
    );
  }, 60_000);
});

describe("write permission and execution re-check", () => {
  it("TL-14: stock.view is not enough; a kitchen lead may only draft decreases", async () => {
    const { requester } = await requesterWithApprover();
    const ctx = await ctxOf(requester);
    const line = (qtyDelta: string) => ({
      outletId: outletA,
      lines: [{ inventoryItemId: randomUUID(), qtyDelta, reason: "Uji" }],
    });
    await expect(
      writeTools["TL-14"]!(ctx, line("5.0000")),
    ).rejects.toMatchObject({
      code: "AI_TOOL_FORBIDDEN",
    });
    const ok = (await writeTools["TL-14"]!(ctx, line("-1.0000"))) as {
      status: string;
    };
    expect(ok.status).toBe("pending");
  });

  it("a banned requester's approved request fails and changes nothing", async () => {
    const { menuItemId, requester, approver } = await requesterWithApprover();
    const before = await availabilityFingerprint(menuItemId);
    const receipt = (await writeTools["TL-18"]!(
      await ctxOf(requester),
      draft(menuItemId),
    )) as {
      actionRequestId: string;
      approvalRequestId: string;
    };
    await decide(approver, receipt.approvalRequestId, "approved");
    await ownerPool.query('UPDATE "user" SET banned = true WHERE id = $1', [
      requester.userId,
    ]);
    try {
      expect(
        await settleActionRequest(workerContext, receipt.actionRequestId),
      ).toBe("failed");
    } finally {
      await ownerPool.query('UPDATE "user" SET banned = false WHERE id = $1', [
        requester.userId,
      ]);
    }
    expect(await availabilityFingerprint(menuItemId)).toBe(before);
  }, 60_000);

  // Platform lock (bead legend-nnufz): a request proposed before the platform
  // switched `ai_assistant` off must not execute once the chain is approved.
  it("a tenant locked after the proposal: settle is refused (not failed) and creates no target row", async () => {
    const { menuItemId, requester, approver } = await requesterWithApprover();
    const before = await availabilityFingerprint(menuItemId);
    const receipt = (await writeTools["TL-18"]!(
      await ctxOf(requester),
      draft(menuItemId),
    )) as {
      actionRequestId: string;
      approvalRequestId: string;
    };
    await decide(approver, receipt.approvalRequestId, "approved");

    const flags = await ownerPool.query(
      "SELECT feature_flags->'modules' AS modules FROM tenants WHERE id = $1",
      [tenantId],
    );
    const originalModules = flags.rows[0].modules as string[];
    const setModules = (modules: string[]) =>
      ownerPool.query(
        `UPDATE tenants SET feature_flags = jsonb_set(feature_flags, '{modules}', $2::jsonb) WHERE id = $1`,
        [tenantId, JSON.stringify(modules)],
      );
    const statusOf = async () =>
      (
        await ownerPool.query(
          "SELECT status, failure_reason FROM action_requests WHERE id = $1",
          [receipt.actionRequestId],
        )
      ).rows[0] as { status: string; failure_reason: string | null };
    const statusBefore = (await statusOf()).status;
    await setModules(originalModules.filter((m) => m !== "ai_assistant"));
    try {
      // Second-opinion fix: a platform lock is not an action failure. The
      // error surfaces (403 AI_PLATFORM_DISABLED) and the row stays untouched.
      await expect(
        settleActionRequest(workerContext, receipt.actionRequestId),
      ).rejects.toMatchObject({ code: "AI_PLATFORM_DISABLED" });
    } finally {
      await setModules(originalModules);
    }
    expect(await availabilityFingerprint(menuItemId)).toBe(before);
    const row = await statusOf();
    expect(row.status).toBe(statusBefore);
    expect(row.status).not.toBe("failed");
    expect(row.failure_reason).toBeNull();
    expect(
      await eventCount("action_request.executed", receipt.actionRequestId),
    ).toBe(0);
  }, 60_000);
});
