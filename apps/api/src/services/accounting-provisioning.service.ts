// Standard chart provisioning per legal entity (PRD v1.7 §3.19 "Chart of
// Accounts [P0] — CoA standar F&B yang dapat disesuaikan, per badan usaha";
// bead legend-a7x7).
//
// A new legal entity gets a copy of `standardFnbChartTemplate` and the default
// role → account mapping taken from each template row's `roles`. The mapping
// decides where automatic journals post money, so the copy is validated with
// the contract (`chartOfAccountsIssues`, `accountMappingIssues`) before any
// insert; a template the contract rejects is a bug and throws.
//
// Never mixes: an entity that already holds even one account keeps its chart
// untouched (`already_present`), and mappings are only inserted when the
// entity has none. Tenants edit the chart afterwards through the existing CoA
// routes; nothing here locks the result.
//
// Database rules repeated by migration 0027 (`app.assert_account_parent`): a
// parent must exist in the same entity with the same type before its child is
// inserted, so rows go in level by level, parents first.

import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  accountMappingIssues,
  accountMappingSchema,
  accountSchema,
  chartOfAccountsIssues,
  POSTING_ACCOUNT_ROLES,
  standardFnbChartTemplate,
  type Account,
  type AccountMapping,
} from "@starter/shared/accounting";
import type { ScopedTenantContext, UserId } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db";
import { accountMappings, chartOfAccounts, legalEntities } from "../db/schema";
import { withTenant } from "../db/tenant";
import {
  auditAccountingChange,
  requireLegalEntity,
  type TenantTransaction,
} from "./accounting-shared";

/**
 * `accounts` and `mappings` count the rows this call inserted (0 for
 * `already_present`).
 */
export type ChartProvisionResult = {
  legalEntityId: string;
  status: "provisioned" | "already_present";
  accounts: number;
  mappings: number;
  /**
   * Posting roles with no mapping after this call. Always 0 for `provisioned`;
   * for `already_present` it flags an older entity whose chart was never
   * fully mapped (automatic journals for those roles will be refused). It is
   * reported, never fixed here: the tenant maps them through the CoA routes.
   */
  missingRoles: number;
};

const ALL_POSTING_ROLES = Object.keys(
  POSTING_ACCOUNT_ROLES,
) as readonly string[];

/** Tenant-wide platform context, same shape as platform-org.service.ts. */
function backfillScope(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

/** The template copied for one entity, with fresh ids and parents resolved. */
function chartCandidates(
  tenantId: string,
  legalEntityId: string,
): { accounts: Account[]; mappings: AccountMapping[] } {
  const idByCode = new Map(
    standardFnbChartTemplate.map((row) => [row.code, randomUUID()]),
  );
  const accounts = standardFnbChartTemplate.map((row) => {
    const parentId =
      row.parentCode === null ? null : idByCode.get(row.parentCode);
    if (parentId === undefined)
      throw new Error(
        `Standard chart template: parent ${row.parentCode} of ${row.code} missing`,
      );
    return accountSchema.parse({
      id: idByCode.get(row.code),
      tenantId,
      legalEntityId,
      code: row.code,
      name: row.name,
      type: row.type,
      reportGroup: row.reportGroup,
      parentId,
      isActive: true,
    });
  });
  const mappings = standardFnbChartTemplate.flatMap((row) =>
    row.roles.map((role) =>
      accountMappingSchema.parse({
        tenantId,
        legalEntityId,
        role,
        accountId: idByCode.get(row.code),
      }),
    ),
  );
  const issues = [
    ...chartOfAccountsIssues(accounts),
    ...accountMappingIssues(mappings, accounts),
  ];
  // `accountMappingIssues` checks each mapping, not coverage: a role added to
  // the contract without a template row would leave new entities unable to
  // post it, so the template must map every posting role.
  const mapped = new Set<string>(mappings.map((mapping) => mapping.role));
  for (const role of ALL_POSTING_ROLES)
    if (!mapped.has(role)) issues.push(`role ${role} has no template account`);
  if (issues.length > 0)
    throw new Error(`Standard chart template invalid: ${issues.join("; ")}`);
  return { accounts, mappings };
}

/** Parents before children: each batch only names parents already inserted. */
function insertionLevels(accounts: readonly Account[]): Account[][] {
  const levels: Account[][] = [];
  const placed = new Set<string>();
  let remaining = [...accounts];
  while (remaining.length > 0) {
    const level = remaining.filter(
      (account) => account.parentId === null || placed.has(account.parentId),
    );
    if (level.length === 0)
      throw new Error("Standard chart template: unresolved parent chain");
    for (const account of level) placed.add(account.id);
    remaining = remaining.filter((account) => !placed.has(account.id));
    levels.push(level);
  }
  return levels;
}

/**
 * Copies the standard F&B chart and default mappings into an entity with an
 * empty chart, inside the caller's transaction. Idempotent: serialised per
 * entity by an advisory lock, and a no-op once the entity has any account.
 */
export async function provisionStandardChart(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  legalEntityId: string,
  actorId: UserId | null,
): Promise<ChartProvisionResult> {
  const tenantId = context.tenant.tenantId;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`chart_of_accounts:${tenantId}:${legalEntityId}`}, 0))`,
  );
  await requireLegalEntity(tx, tenantId, legalEntityId);
  const [existingAccount] = await tx
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.tenantId, tenantId),
        eq(chartOfAccounts.legalEntityId, legalEntityId),
      ),
    )
    .limit(1);
  if (existingAccount) {
    const mappedRows = await tx
      .select({ role: accountMappings.role })
      .from(accountMappings)
      .where(
        and(
          eq(accountMappings.tenantId, tenantId),
          eq(accountMappings.legalEntityId, legalEntityId),
        ),
      );
    const mappedRoles = new Set<string>(mappedRows.map((row) => row.role));
    return {
      legalEntityId,
      status: "already_present",
      accounts: 0,
      mappings: 0,
      missingRoles: ALL_POSTING_ROLES.filter((role) => !mappedRoles.has(role))
        .length,
    };
  }

  const { accounts, mappings } = chartCandidates(tenantId, legalEntityId);
  for (const level of insertionLevels(accounts))
    await tx.insert(chartOfAccounts).values(
      level.map((account) => ({
        id: account.id,
        tenantId,
        legalEntityId,
        code: account.code,
        name: account.name,
        type: account.type,
        reportGroup: account.reportGroup,
        parentId: account.parentId,
        isActive: account.isActive,
      })),
    );

  const [existingMapping] = await tx
    .select({ role: accountMappings.role })
    .from(accountMappings)
    .where(
      and(
        eq(accountMappings.tenantId, tenantId),
        eq(accountMappings.legalEntityId, legalEntityId),
      ),
    )
    .limit(1);
  const insertedMappings = existingMapping ? [] : mappings;
  if (insertedMappings.length > 0)
    await tx.insert(accountMappings).values(
      insertedMappings.map((mapping) => ({
        tenantId,
        legalEntityId,
        role: mapping.role,
        accountId: mapping.accountId,
      })),
    );

  const codeById = new Map(
    accounts.map((account) => [account.id, account.code]),
  );
  // Key names avoid the audit deny list ("account" is masked); only `count`,
  // `role` and `glCode` leaves are kept, per AUDIT_SAFE_FIELDS.
  await auditAccountingChange(tx, context, {
    actorId,
    action: "accounting.chart.provisioned",
    objectType: "legal_entity",
    objectId: legalEntityId,
    before: null,
    after: {
      chart: { count: accounts.length },
      mappings: {
        count: insertedMappings.length,
        roles: insertedMappings.map((mapping) => ({
          role: mapping.role,
          glCode: codeById.get(mapping.accountId) ?? null,
        })),
      },
    },
  });
  return {
    legalEntityId,
    status: "provisioned",
    accounts: accounts.length,
    mappings: insertedMappings.length,
    missingRoles: 0,
  };
}

/** Provisions every legal entity of one tenant; entities with a chart are left as is. */
export async function backfillTenantCharts(
  tenantId: string,
): Promise<ChartProvisionResult[]> {
  const context = backfillScope(tenantId);
  return withTenant(db, context, async (tx) => {
    const entities = await tx
      .select({ id: legalEntities.id })
      .from(legalEntities)
      .where(eq(legalEntities.tenantId, tenantId))
      .orderBy(asc(legalEntities.createdAt), asc(legalEntities.id));
    const results: ChartProvisionResult[] = [];
    for (const entity of entities)
      results.push(await provisionStandardChart(tx, context, entity.id, null));
    return results;
  });
}
