// Shared world for the WS-11 F12 tests (saved reports, exports, schedules;
// bead legend-ay6e6). Each call builds its own tenant with two outlets, a GL
// ledger for June 2025 (outlet1 net 950k, outlet2 net 400k) and users with
// distinct report permissions, so suites never share rows.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  businessDateSchema,
  idr,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  accountIdSchema,
  type JournalLineInput,
} from "@starter/shared/accounting";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { postJournalInTransaction } from "../services/accounting-journal.service";
import { agent, setRole, signUp, verifySessionMfa } from "./helpers";
import { createIsolatedTenant, owner } from "./floor-test-helpers";

export type Client = ReturnType<typeof agent>;
export type Member = {
  client: Client;
  host: string;
  userId: string;
  email: string;
};

export type DeliveryWorld = {
  tenantId: string;
  host: string;
  entityId: string;
  outlet1: string;
  outlet2: string;
  /** All report permissions plus export, tenant scope. */
  full: Member;
  /** Same role as `full`: a second owner in the same tenant. */
  peer: Member;
  /** All report permissions plus export, outlet1 only. */
  outletManager: Member;
  /** report.aggregate.view only (shareholder). */
  shareholder: Member;
  /** Report permissions but no export permission. */
  noExport: Member;
  /** Signed in, no assignment. */
  nobody: Member;
  roles: Record<"full" | "outlet" | "noExport" | "shareholder", string>;
};

export const REPORT_PERMISSIONS = [
  "dashboard.owner.view",
  "dashboard.management.view",
  "report.operational.view",
  "report.sales.view",
  "report.financial.view",
  "report.aggregate.view",
];
export const EXPORT_PERMISSIONS = [
  "export.data.run",
  "export.personal_data.request",
];

export const JUNE = { startDate: "2025-06-01", endDate: "2025-06-30" };

export function tenantContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

export async function insertRole(
  tenantId: string,
  name: string,
  permissions: string[],
  scopes: string[],
  templateKey: string | null = null,
): Promise<string> {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, $4, $5, $6, false, $7)`,
    [
      roleId,
      tenantId,
      name,
      templateKey !== null,
      templateKey,
      JSON.stringify(permissions),
      JSON.stringify(scopes),
    ],
  );
  return roleId;
}

export async function memberWithRole(
  app: Express,
  input: {
    tenantId: string;
    host: string;
    roleId: string | null;
    scopeType: "tenant" | "outlet";
    scopeId?: string;
    label: string;
  },
): Promise<Member> {
  const client = agent(app);
  const email = await signUp(client, input.label);
  await setRole(email, null);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  if (input.roleId !== null)
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        input.tenantId,
        userId,
        input.roleId,
        input.scopeType,
        input.scopeType === "tenant" ? null : (input.scopeId ?? null),
      ],
    );
  await verifySessionMfa(email);
  return { client, host: input.host, userId, email };
}

function line(
  accountId: string,
  debit: number,
  credit: number,
  outletId: string,
): JournalLineInput {
  return {
    accountId: accountIdSchema.parse(accountId),
    debitIdr: idr(debit),
    creditIdr: idr(credit),
    outletId: outletId as JournalLineInput["outletId"],
    costCenter: null,
  };
}

export async function makeDeliveryWorld(
  app: Express,
  label: string,
): Promise<DeliveryWorld> {
  const tenant = await createIsolatedTenant(
    `rd-${label}-${randomUUID().slice(0, 6)}`,
  );
  const outlet2 = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Dua', address, timezone, opening_hours, status
     FROM outlets WHERE id = $3`,
    [outlet2, `O2-${randomUUID().slice(0, 8)}`.toUpperCase(), tenant.outletId],
  );
  const cash = randomUUID();
  const revenue = randomUUID();
  const discount = randomUUID();
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $4, $5, '1101', 'Kas', 'asset', 'cash_and_equivalents'),
            ($2, $4, $5, '4101', 'Penjualan', 'revenue', 'revenue'),
            ($3, $4, $5, '4201', 'Diskon penjualan', 'revenue', 'revenue')`,
    [cash, revenue, discount, tenant.tenantId, tenant.legalEntityId],
  );
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, 'sales_revenue', $3), ($1, $2, 'sales_discount', $4)
     ON CONFLICT DO NOTHING`,
    [tenant.tenantId, tenant.legalEntityId, revenue, discount],
  );
  await owner.query(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, '2025-06')`,
    [tenant.tenantId, tenant.legalEntityId],
  );
  const ctx = tenantContext(tenant.tenantId);
  const post = (date: string, outletId: string, lines: JournalLineInput[]) =>
    withTenant(db, ctx, (tx) =>
      postJournalInTransaction(tx, ctx, {
        legalEntityId: tenant.legalEntityId,
        outletId,
        entryDate: businessDateSchema.parse(date),
        sourceType: "sale" as const,
        sourceId: randomUUID(),
        description: "Uji ekspor laporan",
        lines,
        postedBy: null,
        idempotencyKey: `report-delivery-${randomUUID()}`,
      }),
    );
  await post("2025-06-10", tenant.outletId, [
    line(cash, 1_000_000, 0, tenant.outletId),
    line(revenue, 0, 1_000_000, tenant.outletId),
  ]);
  await post("2025-06-20", tenant.outletId, [
    line(discount, 50_000, 0, tenant.outletId),
    line(cash, 0, 50_000, tenant.outletId),
  ]);
  await post("2025-06-11", outlet2, [
    line(cash, 400_000, 0, outlet2),
    line(revenue, 0, 400_000, outlet2),
  ]);

  const roles = {
    full: await insertRole(
      tenant.tenantId,
      "Penuh uji ekspor",
      [...REPORT_PERMISSIONS, ...EXPORT_PERMISSIONS],
      ["tenant", "brand"],
    ),
    outlet: await insertRole(
      tenant.tenantId,
      "Manajer outlet uji ekspor",
      [...REPORT_PERMISSIONS, ...EXPORT_PERMISSIONS],
      ["outlet"],
    ),
    noExport: await insertRole(
      tenant.tenantId,
      "Laporan tanpa ekspor",
      REPORT_PERMISSIONS,
      ["tenant"],
    ),
    shareholder: await insertRole(
      tenant.tenantId,
      "Pemegang saham uji ekspor",
      ["dashboard.shareholder.view", "report.aggregate.view"],
      ["tenant"],
      "shareholder",
    ),
  };
  const common = { tenantId: tenant.tenantId, host: tenant.hostname };
  return {
    tenantId: tenant.tenantId,
    host: tenant.hostname,
    entityId: tenant.legalEntityId,
    outlet1: tenant.outletId,
    outlet2,
    roles,
    full: await memberWithRole(app, {
      ...common,
      roleId: roles.full,
      scopeType: "tenant",
      label: `Penuh ${label}`,
    }),
    peer: await memberWithRole(app, {
      ...common,
      roleId: roles.full,
      scopeType: "tenant",
      label: `Rekan ${label}`,
    }),
    outletManager: await memberWithRole(app, {
      ...common,
      roleId: roles.outlet,
      scopeType: "outlet",
      scopeId: tenant.outletId,
      label: `Outlet ${label}`,
    }),
    shareholder: await memberWithRole(app, {
      ...common,
      roleId: roles.shareholder,
      scopeType: "tenant",
      label: `Saham ${label}`,
    }),
    noExport: await memberWithRole(app, {
      ...common,
      roleId: roles.noExport,
      scopeType: "tenant",
      label: `Tanpa ekspor ${label}`,
    }),
    nobody: await memberWithRole(app, {
      ...common,
      roleId: null,
      scopeType: "tenant",
      label: `Tanpa izin ${label}`,
    }),
  };
}

export function worldUsers(w: DeliveryWorld): string[] {
  return [
    w.full,
    w.peer,
    w.outletManager,
    w.shareholder,
    w.noExport,
    w.nobody,
  ].map((m) => m.userId);
}
