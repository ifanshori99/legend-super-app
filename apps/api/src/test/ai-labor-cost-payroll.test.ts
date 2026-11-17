// Kartu C item 5 (bead legend-39d.4): TL-05 get_labor_summary labor cost comes
// from frozen payroll runs and needs the payroll permission. MONEY/PII: a role
// without `payroll.view` must NOT see labor cost (null, never 0); a figure never
// exceeds the run it comes from; a draft run never counts.
//
// Written from the brief and the shared contract (getLaborSummaryOutputSchema:
// laborCostIdr / laborCostPct nullable). Real PostgreSQL, real handler, access
// snapshots resolved in memory from the real role templates (same harness as
// ai-tools-read-a.test.ts).
//
// ASSUMPTIONS (listed in the report):
//  - The salary permission is `payroll.view` at tenant scope; the HR template
//    holds it, the outlet_manager template does not.
//  - Cost = (gross + employer BPJS + employer-borne PPh21 - employer refund) of
//    runs with status locked/paid, pro rata by days when the period is a part of
//    the run, null when the frozen runs do not cover every day of the period.
//  - An outlet-filtered request gets null cost (a run has no outlet split).
//  - Headcount and hours stay visible to roles allowed to call TL-05.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  roleAssignmentSchema,
  roleTemplate,
  type RoleTemplateKey,
} from "@starter/shared/access";
import { getLaborSummaryOutputSchema } from "@starter/shared/ai";
import { establishTenantContext } from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { resolveAccessSnapshot } from "../services/permission-resolver.ts";
import type { AiToolContext } from "../services/ai-tools/types.ts";
import { readToolsA } from "../services/ai-tools/read-a/index.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const NOW = new Date("2031-06-01T05:00:00.000Z");

async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
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

const tenantId = randomUUID();
const brandId = randomUUID();
const entityId = randomUUID();
const outletId = randomUUID();
const otherOutletId = randomUUID();
const policyId = randomUUID();

const totals = (grossIdr: number, bpjsCompanyIdr: number) => ({
  employeeCount: 0,
  grossIdr,
  deductionsIdr: 0,
  netIdr: grossIdr,
  bpjsEmployeeIdr: 0,
  bpjsCompanyIdr,
  pph21Idr: 0,
  pph21WithheldIdr: 0,
  pph21EmployerBorneIdr: 0,
  pph21RefundIdr: 0,
  pph21EmployerRefundIdr: 0,
  pph21EmployerAllowanceRefundIdr: 0,
  loanRepaymentIdr: 0,
  pph21ReceivableIdr: 0,
  pph21ReceivableCollectedIdr: 0,
  otherDeductionsIdr: 0,
  customDeductionsIdr: 0,
  serviceChargeIdr: 0,
  reimbursementIdr: 0,
  bankTransferIdr: grossIdr,
  cashIdr: 0,
});

async function seedRun(
  status: "locked" | "draft",
  periodStart: string,
  periodEnd: string,
  runTotals: ReturnType<typeof totals>,
) {
  await asOwner(tenantId, async (client) => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                                 period_start, period_end, pay_date, created_by)
       VALUES ($1, $2, $3, $4, 'regular', $5, $6, $6, 'labor-cost-test')`,
      [id, tenantId, entityId, policyId, periodStart, periodEnd],
    );
    if (status === "locked") {
      await client.query(
        `UPDATE payroll_runs SET status = 'simulated' WHERE id = $1`,
        [id],
      );
      await client.query(
        `UPDATE payroll_runs SET status = 'hr_approved', approved_by_hr = 'hr-user', approved_by_hr_at = now() WHERE id = $1`,
        [id],
      );
      await client.query(
        `UPDATE payroll_runs SET status = 'approved', approved_by_finance = 'finance-user', approved_by_finance_at = now() WHERE id = $1`,
        [id],
      );
      await client.query(
        `UPDATE payroll_runs SET status = 'locked', config_snapshot = '{"v":1}', totals = $2::jsonb,
                locked_by = 'lock-user', locked_at = now() WHERE id = $1`,
        [id, JSON.stringify(runTotals)],
      );
    } else {
      await client.query(
        `UPDATE payroll_runs SET totals = $2::jsonb WHERE id = $1`,
        [id, JSON.stringify(runTotals)],
      );
    }
  });
}

beforeAll(async () => {
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'AI labor cost', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [
      tenantId,
      `ai-labor-${tenantId.slice(0, 8)}`,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await asOwner(tenantId, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand')`,
      [brandId, tenantId],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Test', false)`,
      [entityId, tenantId],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Outlet Labor', 'Jl. Test', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [
        outletId,
        tenantId,
        brandId,
        entityId,
        `L-${tenantId.slice(0, 6).toUpperCase()}`,
      ],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Outlet Labor Dua', 'Jl. Test 2', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [
        otherOutletId,
        tenantId,
        brandId,
        entityId,
        `M-${tenantId.slice(0, 6).toUpperCase()}`,
      ],
    );
    const code = `LC${policyId.slice(0, 8)}`;
    await client.query(
      `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name, employee_group_code,
                                     employee_group, cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan Labor', $4, $5, '{"kind":"monthly"}', 'none', 'low', '[]')`,
      [policyId, tenantId, entityId, code, JSON.stringify({ code })],
    );
  });
  // March: locked, 31 days, full cost 31_000_000 + 3_100_000 = 34_100_000.
  await seedRun(
    "locked",
    "2031-03-01",
    "2031-03-31",
    totals(31_000_000, 3_100_000),
  );
  // April: only a draft, with a large total that must never be counted.
  await seedRun("draft", "2031-04-01", "2031-04-30", totals(900_000_000, 0));
});

afterAll(async () => {
  await owner.end();
});

function contextFor(
  roleKey: RoleTemplateKey,
  withoutPermission?: string,
): AiToolContext {
  const userId = randomUUID();
  const template = roleTemplate(roleKey);
  const role = {
    id: randomUUID(),
    permissions: template.permissions.filter(
      (code: string) => code !== withoutPermission,
    ),
    mfaRequired: false,
    templateKey: roleKey,
    allowedScopeTypes: [...template.allowedScopeTypes],
  };
  const tenantScope = roleKey === "hr" || roleKey === "owner";
  const assignment = roleAssignmentSchema.parse({
    id: randomUUID(),
    tenantId,
    userId,
    roleId: role.id,
    scope: tenantScope
      ? { type: "tenant", id: null }
      : { type: "outlet", id: outletId },
    validFrom: "2030-01-01T00:00:00.000Z",
    validUntil: null,
    assignedBy: randomUUID(),
    assignedAt: "2030-01-01T00:00:00.000Z",
  });
  const access = resolveAccessSnapshot({
    tenant: establishTenantContext({
      tenantId,
      brandId: null,
      source: "session",
    }),
    userId,
    assignments: [assignment],
    roles: [role] as never,
    org: {
      brands: [{ id: brandId }],
      outlets: [
        { id: outletId, brandId },
        { id: otherOutletId, brandId },
      ],
      stations: [],
    } as never,
    mfaVerified: false,
    now: NOW,
  });
  return { access, channel: "tanya_ai", mcpClientId: null, now: NOW };
}

/**
 * An outlet manager of ONE outlet who also holds a custom role with only
 * `payroll.view` at tenant scope: payroll is tenant-wide, the TL-05 reach is not.
 */
function contextOutletManagerWithTenantPayroll(): AiToolContext {
  const userId = randomUUID();
  const managerTemplate = roleTemplate("outlet_manager");
  const managerRole = {
    id: randomUUID(),
    permissions: [...managerTemplate.permissions],
    mfaRequired: false,
    templateKey: "outlet_manager",
    allowedScopeTypes: [...managerTemplate.allowedScopeTypes],
  };
  const payrollRole = {
    id: randomUUID(),
    permissions: ["payroll.view"],
    mfaRequired: false,
    templateKey: null,
    allowedScopeTypes: ["tenant"],
  };
  const assign = (roleId: string, scope: { type: string; id: string | null }) =>
    roleAssignmentSchema.parse({
      id: randomUUID(),
      tenantId,
      userId,
      roleId,
      scope,
      validFrom: "2030-01-01T00:00:00.000Z",
      validUntil: null,
      assignedBy: randomUUID(),
      assignedAt: "2030-01-01T00:00:00.000Z",
    });
  const access = resolveAccessSnapshot({
    tenant: establishTenantContext({
      tenantId,
      brandId: null,
      source: "session",
    }),
    userId,
    assignments: [
      assign(managerRole.id, { type: "outlet", id: outletId }),
      assign(payrollRole.id, { type: "tenant", id: null }),
    ],
    roles: [managerRole, payrollRole] as never,
    org: {
      brands: [{ id: brandId }],
      outlets: [
        { id: outletId, brandId },
        { id: otherOutletId, brandId },
      ],
      stations: [],
    } as never,
    mfaVerified: false,
    now: NOW,
  });
  return { access, channel: "tanya_ai", mcpClientId: null, now: NOW };
}

const labor = async (
  ctx: AiToolContext,
  period: { from: string; to: string },
  outletIds?: string[],
) =>
  getLaborSummaryOutputSchema.parse(
    await readToolsA["TL-05"]!(ctx, {
      period,
      ...(outletIds ? { outletIds } : {}),
    }),
  );

describe("TL-05 labor cost needs the payroll permission (legend-39d.4)", () => {
  it("legend-39d.4 HR (payroll.view) sees the cost: a whole locked run equals the run total", async () => {
    const out = await labor(contextFor("hr"), {
      from: "2031-03-01",
      to: "2031-03-31",
    });
    expect(out.laborCostIdr).toBe(34_100_000);
  });

  it("legend-39d.4 a part of a locked run is pro rata by days and never above the run total", async () => {
    const out = await labor(contextFor("hr"), {
      from: "2031-03-10",
      to: "2031-03-11",
    });
    expect(out.laborCostIdr).toBe(2_200_000); // 34_100_000 * 2 / 31
    expect(out.laborCostIdr!).toBeLessThanOrEqual(34_100_000);
  });

  it("legend-39d.4 HR without payroll.view gets NULL cost, not 0, but keeps the headcount", async () => {
    const out = await labor(contextFor("hr", "payroll.view"), {
      from: "2031-03-01",
      to: "2031-03-31",
    });
    expect(out.laborCostIdr).toBeNull();
    expect(out.laborCostPct).toBeNull();
    expect(typeof out.headcount).toBe("number");
  });

  it("legend-39d.4 an outlet manager (no payroll permission) gets NULL cost, even over a locked run", async () => {
    const out = await labor(contextFor("outlet_manager"), {
      from: "2031-03-01",
      to: "2031-03-31",
    });
    expect(out.laborCostIdr).toBeNull();
    expect(out.laborCostPct).toBeNull();
    expect(JSON.stringify(out)).not.toContain("34100000");
  });

  it("legend-39d.4 an outlet-filtered request gets NULL cost (a run has no outlet split)", async () => {
    const out = await labor(
      contextFor("hr"),
      { from: "2031-03-01", to: "2031-03-31" },
      [outletId],
    );
    expect(out.laborCostIdr).toBeNull();
  });

  it("legend-39d.4 a period with no frozen run, or only a draft run, is NULL not 0", async () => {
    const draftOnly = await labor(contextFor("hr"), {
      from: "2031-04-01",
      to: "2031-04-30",
    });
    expect(draftOnly.laborCostIdr).toBeNull();
    const none = await labor(contextFor("hr"), {
      from: "2031-01-01",
      to: "2031-01-31",
    });
    expect(none.laborCostIdr).toBeNull();
  });

  it("legend-39d.4 a period only partly covered by frozen runs is NULL, not a low partial figure", async () => {
    const out = await labor(contextFor("hr"), {
      from: "2031-03-25",
      to: "2031-04-05",
    });
    expect(out.laborCostIdr).toBeNull();
  });

  it("legend-39d.4 tenant payroll.view but outlet reach limited to one outlet gets NULL cost and pct (no tenant-wide cost beside one outlet's sales)", async () => {
    const ctx = contextOutletManagerWithTenantPayroll();
    // Control: the call itself works and is limited to the manager's outlet.
    const out = await labor(ctx, { from: "2031-03-01", to: "2031-03-31" });
    expect(typeof out.headcount).toBe("number");
    expect(out.laborCostIdr).toBeNull();
    expect(out.laborCostPct).toBeNull();
    expect(JSON.stringify(out)).not.toContain("34100000");
  });
});
