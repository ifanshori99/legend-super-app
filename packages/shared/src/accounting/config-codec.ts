// Config bundle codec for the `chart_of_accounts` section (legend-tct8,
// TEN-09). Turns one legal entity's accounts into tenant-free template items
// (parents by item key, no ids) and back into drafts the importer can insert
// parents-first.
//
// Item shape (legend-5cwrq): the codec speaks the `kind`-discriminated shape
// of `configSectionItemSchemas` (platform/config.ts) that tenant-config-export
// writes: kind "account" (key, code, parentKey -> the parent's item key) and
// kind "mapping" (posting role -> accountKey). fromTemplate and `itemSchema`
// also still READ the old kind-less shape (key = account code, parentCode) so
// files stored by legend-tct8 exports keep importing. `kind` present means the
// new shape and is validated strictly; `kind` absent means the old shape.
//
// Rules:
// - Account codes are unique per section, and so are item keys (accounts and
//   mappings share one key space).
// - toTemplate takes the accounts of ONE legal entity and throws on
//   programmer-level inconsistency (mixed entities, missing parent). It emits
//   account items only; the exporter adds the mapping items.
// - fromTemplate never throws on bad user data: it returns issue strings that
//   name the account. It checks the report group against the type, that the
//   parent exists in the set and has the same type, that the tree has no
//   cycle, and that every mapping names an account of the section (and each
//   role is mapped once, to a postable leaf of a type the role allows, as
//   coa.ts accountMappingIssues requires).
// - fromTemplate returns the accounts as `drafts` (parents first, parent by
//   code) and the mapping items as `mappings` (account by code). Posting
//   roles that no mapping item covers are re-derived by the importer from the
//   standard template roles.
// - Structural plain object on purpose: it must not import from ../platform
//   (platform imports this domain).

import { z } from "zod";
import {
  accountCodeSchema,
  accountTypeSchema,
  allowedAccountTypesForRole,
  REPORT_GROUPS,
  postingAccountRoleSchema,
  reportGroupSchema,
} from "./coa.ts";
import type { Account } from "./coa.ts";

/** Same shape as the bundle's generic item key (platform/config.ts). */
const itemKeySchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/);
const ACCOUNT_KEY_PREFIX = "acct.";

const accountFields = {
  name: z.string().trim().min(1).max(150),
  type: accountTypeSchema,
  reportGroup: reportGroupSchema,
  isActive: z.boolean(),
};
const accountKindItemSchema = z.strictObject({
  ...accountFields,
  key: itemKeySchema,
  kind: z.literal("account"),
  code: accountCodeSchema,
  /** Item key of the parent account in the same section; null for a root. */
  parentKey: itemKeySchema.nullable(),
});
const mappingKindItemSchema = z.strictObject({
  key: itemKeySchema,
  kind: z.literal("mapping"),
  role: postingAccountRoleSchema,
  /** Item key of the account that takes this posting role. */
  accountKey: itemKeySchema,
});
const chartOfAccountsKindItemSchema = z.discriminatedUnion("kind", [
  accountKindItemSchema,
  mappingKindItemSchema,
]);
/** Old (legend-tct8) account item: no `kind`, key = code, parent by code. */
const accountLegacyItemSchema = z.strictObject({
  ...accountFields,
  key: accountCodeSchema,
  parentCode: accountCodeSchema.nullable(),
});

/**
 * Reads the `kind` shape when the item carries a `kind`, the legacy shape
 * otherwise. Issues come from the one schema that applies, so a bad item
 * reports its real problem (not "invalid union").
 */
export const chartOfAccountsItemSchema = z
  .unknown()
  .transform(
    (
      value,
      ctx,
    ): z.infer<typeof chartOfAccountsKindItemSchema> | LegacyAccountItem => {
      const hasKind =
        typeof value === "object" && value !== null && "kind" in value;
      const result = (
        hasKind ? chartOfAccountsKindItemSchema : accountLegacyItemSchema
      ).safeParse(value);
      if (result.success) return result.data;
      for (const issue of result.error.issues)
        ctx.issues.push({
          code: "custom",
          message: issue.message,
          path: issue.path,
          input: value,
        });
      return z.NEVER;
    },
  );

type LegacyAccountItem = z.infer<typeof accountLegacyItemSchema>;
export type ChartOfAccountsConfigItem = z.infer<typeof accountKindItemSchema>;
export type ChartOfAccountsMappingItem = z.infer<typeof mappingKindItemSchema>;
export type LegacyChartOfAccountsConfigItem = LegacyAccountItem;

/** An account row without ids, timestamps or foreign keys; parent by code. */
export type ChartOfAccountsConfigDraft = {
  key: string;
  code: string;
  name: string;
  type: z.infer<typeof accountTypeSchema>;
  reportGroup: z.infer<typeof reportGroupSchema>;
  parentCode: string | null;
  isActive: boolean;
};

/** A posting-role mapping without ids; the account is named by its code. */
export type ChartOfAccountsMappingDraft = {
  key: string;
  role: z.infer<typeof postingAccountRoleSchema>;
  accountCode: string;
};

export type ChartOfAccountsFromTemplate =
  | {
      ok: true;
      drafts: ChartOfAccountsConfigDraft[];
      mappings: ChartOfAccountsMappingDraft[];
    }
  | { ok: false; issues: string[] };

function compareCodes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toTemplate(accounts: readonly Account[]): ChartOfAccountsConfigItem[] {
  const entityIds = new Set(accounts.map((account) => account.legalEntityId));
  if (entityIds.size > 1)
    throw new Error(
      "chart_of_accounts toTemplate needs accounts of one legal entity",
    );
  const codeById = new Map(
    accounts.map((account) => [account.id, account.code]),
  );
  return accounts
    .map((account): ChartOfAccountsConfigItem => {
      let parentKey: string | null = null;
      if (account.parentId !== null) {
        const found = codeById.get(account.parentId);
        if (found === undefined)
          throw new Error(
            `Account ${account.code}: parent account is not in the chart`,
          );
        parentKey = `${ACCOUNT_KEY_PREFIX}${found}`;
      }
      return {
        key: `${ACCOUNT_KEY_PREFIX}${account.code}`,
        kind: "account",
        code: account.code,
        name: account.name,
        type: account.type,
        reportGroup: account.reportGroup,
        parentKey,
        isActive: account.isActive,
      };
    })
    .sort((a, b) => compareCodes(a.code, b.code));
}

/** An account of either shape, parent reference not yet resolved. */
type AccountNode = ChartOfAccountsConfigDraft & {
  /** How `parentRef` names its target: an item key or an account code. */
  parentBy: "key" | "code";
  parentRef: string | null;
};

function fromTemplate(
  items: readonly (
    | ChartOfAccountsConfigItem
    | ChartOfAccountsMappingItem
    | LegacyChartOfAccountsConfigItem
  )[],
): ChartOfAccountsFromTemplate {
  const issues: string[] = [];
  const byKey = new Map<string, AccountNode>();
  const byCode = new Map<string, AccountNode>();
  const mappingItems: ChartOfAccountsMappingItem[] = [];
  // Account and mapping items share one key space, like the bundle section.
  const keysSeen = new Set<string>();

  for (const raw of items) {
    const label = String((raw as { key?: unknown } | null)?.key);
    const parsed = chartOfAccountsItemSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        issues.push(
          `Account ${label}: ${issue.path.join(".") || "item"} ${issue.message}`,
        );
      continue;
    }
    const item = parsed.data;
    if (keysSeen.has(item.key)) {
      issues.push(`Account ${item.key}: duplicate key`);
      continue;
    }
    keysSeen.add(item.key);
    if ("kind" in item && item.kind === "mapping") {
      mappingItems.push(item);
      continue;
    }
    const node: AccountNode =
      "kind" in item
        ? {
            key: item.key,
            code: item.code,
            name: item.name,
            type: item.type,
            reportGroup: item.reportGroup,
            parentCode: null,
            isActive: item.isActive,
            parentBy: "key",
            parentRef: item.parentKey,
          }
        : {
            key: item.key,
            code: item.key,
            name: item.name,
            type: item.type,
            reportGroup: item.reportGroup,
            parentCode: null,
            isActive: item.isActive,
            parentBy: "code",
            parentRef: item.parentCode,
          };
    if (byCode.has(node.code)) {
      issues.push(`Account ${node.key}: duplicate code ${node.code}`);
      continue;
    }
    byKey.set(node.key, node);
    byCode.set(node.code, node);
    if (REPORT_GROUPS[node.reportGroup] !== node.type)
      issues.push(
        `Account ${node.key}: reportGroup ${node.reportGroup} needs type ${REPORT_GROUPS[node.reportGroup]}`,
      );
  }

  const parentOf = (node: AccountNode): AccountNode | undefined =>
    node.parentRef === null
      ? undefined
      : (node.parentBy === "key" ? byKey : byCode).get(node.parentRef);
  const parentLabel = (node: AccountNode): string =>
    node.parentBy === "key" ? "parentKey" : "parentCode";

  for (const node of byKey.values()) {
    if (node.parentRef === null) continue;
    const parent = parentOf(node);
    if (!parent) {
      issues.push(
        `Account ${node.key}: ${parentLabel(node)} ${node.parentRef} is not in the chart`,
      );
      continue;
    }
    if (parent.type !== node.type)
      issues.push(
        `Account ${node.key}: ${parentLabel(node)} ${node.parentRef} has another type`,
      );
  }

  // Cycle: walking up from an account returns to that same account.
  for (const start of byKey.values()) {
    const seen = new Set<string>();
    let cursor: AccountNode | undefined = start;
    while (cursor && cursor.parentRef !== null) {
      cursor = parentOf(cursor);
      if (!cursor || seen.has(cursor.key)) break;
      seen.add(cursor.key);
      if (cursor.key === start.key) {
        issues.push(`Account ${start.key}: parent cycle`);
        break;
      }
    }
  }

  // Mappings: the account must be one of this section, one mapping per role.
  const roleOwner = new Map<string, string>();
  const mappings: ChartOfAccountsMappingDraft[] = [];
  for (const mapping of mappingItems) {
    const account = byKey.get(mapping.accountKey);
    if (!account) {
      issues.push(
        `Mapping ${mapping.key}: accountKey ${mapping.accountKey} is not in the chart`,
      );
      continue;
    }
    // Type must fit the role. Header accounts are accepted: the server
    // exports and accepts such mappings today, so old exports must import.
    const allowed = allowedAccountTypesForRole(mapping.role);
    if (allowed !== null && !allowed.includes(account.type))
      issues.push(
        `Mapping ${mapping.key}: role ${mapping.role} needs a ${allowed.join(" or ")} account`,
      );
    const first = roleOwner.get(mapping.role);
    if (first !== undefined) {
      issues.push(
        `Mapping ${mapping.key}: role ${mapping.role} is already mapped by ${first}`,
      );
      continue;
    }
    roleOwner.set(mapping.role, mapping.key);
    mappings.push({
      key: mapping.key,
      role: mapping.role,
      accountCode: account.code,
    });
  }

  if (issues.length > 0) return { ok: false, issues };

  const depthOf = (node: AccountNode): number => {
    let depth = 0;
    let cursor = node;
    while (cursor.parentRef !== null) {
      cursor = parentOf(cursor) as AccountNode;
      depth += 1;
    }
    return depth;
  };
  const drafts = [...byKey.values()]
    .map((node) => ({ node, depth: depthOf(node) }))
    .sort((a, b) => a.depth - b.depth || compareCodes(a.node.code, b.node.code))
    .map(({ node }): ChartOfAccountsConfigDraft => ({
      key: node.key,
      code: node.code,
      name: node.name,
      type: node.type,
      reportGroup: node.reportGroup,
      parentCode: parentOf(node)?.code ?? null,
      isActive: node.isActive,
    }));
  return { ok: true, drafts, mappings };
}

export const chartOfAccountsConfigCodec = {
  section: "chart_of_accounts" as const,
  version: 1 as const,
  itemSchema: chartOfAccountsItemSchema,
  toTemplate,
  fromTemplate,
};
