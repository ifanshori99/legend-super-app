// Config bundle codec for the `chart_of_accounts` section (legend-tct8,
// TEN-09). Turns one legal entity's accounts into tenant-free template items
// (parents by account code, no ids) and back into drafts the importer can
// insert parents-first.
//
// Rules:
// - The item key is the account code. Codes are unique per section.
// - toTemplate takes the accounts of ONE legal entity and throws on
//   programmer-level inconsistency (mixed entities, missing parent).
// - fromTemplate never throws on bad user data: it returns issue strings that
//   name the account code. It checks the report group against the type, that
//   the parent exists in the set and has the same type, and that the tree has
//   no cycle.
// - account_mappings (posting roles) are not part of this section; the
//   importer re-derives them from the standard template roles.
// - Structural plain object on purpose: it must not import from ../platform
//   (platform imports this domain).

import { z } from "zod";
import {
  accountCodeSchema,
  accountTypeSchema,
  REPORT_GROUPS,
  reportGroupSchema,
} from "./coa.ts";
import type { Account } from "./coa.ts";

export const chartOfAccountsItemSchema = z.strictObject({
  key: accountCodeSchema,
  name: z.string().trim().min(1).max(150),
  type: accountTypeSchema,
  reportGroup: reportGroupSchema,
  parentCode: accountCodeSchema.nullable(),
  isActive: z.boolean(),
});
export type ChartOfAccountsConfigItem = z.infer<
  typeof chartOfAccountsItemSchema
>;

/** An account row without ids, timestamps or foreign keys; parent by code. */
export type ChartOfAccountsConfigDraft = ChartOfAccountsConfigItem & {
  code: string;
};

export type ChartOfAccountsFromTemplate =
  | { ok: true; drafts: ChartOfAccountsConfigDraft[] }
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
      let parentCode: string | null = null;
      if (account.parentId !== null) {
        const found = codeById.get(account.parentId);
        if (found === undefined)
          throw new Error(
            `Account ${account.code}: parent account is not in the chart`,
          );
        parentCode = found;
      }
      return {
        key: account.code,
        name: account.name,
        type: account.type,
        reportGroup: account.reportGroup,
        parentCode,
        isActive: account.isActive,
      };
    })
    .sort((a, b) => compareCodes(a.key, b.key));
}

function fromTemplate(
  items: readonly ChartOfAccountsConfigItem[],
): ChartOfAccountsFromTemplate {
  const issues: string[] = [];
  const byKey = new Map<string, ChartOfAccountsConfigItem>();

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
    if (byKey.has(item.key)) {
      issues.push(`Account ${item.key}: duplicate code`);
      continue;
    }
    byKey.set(item.key, item);
    if (REPORT_GROUPS[item.reportGroup] !== item.type)
      issues.push(
        `Account ${item.key}: reportGroup ${item.reportGroup} needs type ${REPORT_GROUPS[item.reportGroup]}`,
      );
  }

  for (const item of byKey.values()) {
    if (item.parentCode === null) continue;
    const parent = byKey.get(item.parentCode);
    if (!parent) {
      issues.push(
        `Account ${item.key}: parentCode ${item.parentCode} is not in the chart`,
      );
      continue;
    }
    if (parent.type !== item.type)
      issues.push(
        `Account ${item.key}: parentCode ${item.parentCode} has another type`,
      );
  }

  // Cycle: walking up from an item returns to that same item.
  for (const start of byKey.values()) {
    const seen = new Set<string>();
    let cursor: ChartOfAccountsConfigItem | undefined = start;
    while (cursor && cursor.parentCode !== null) {
      cursor = byKey.get(cursor.parentCode);
      if (!cursor || seen.has(cursor.key)) break;
      seen.add(cursor.key);
      if (cursor.key === start.key) {
        issues.push(`Account ${start.key}: parent cycle`);
        break;
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  const depthOf = (item: ChartOfAccountsConfigItem): number => {
    let depth = 0;
    let cursor = item;
    while (cursor.parentCode !== null) {
      cursor = byKey.get(cursor.parentCode) as ChartOfAccountsConfigItem;
      depth += 1;
    }
    return depth;
  };
  const drafts = [...byKey.values()]
    .map((item) => ({ item, depth: depthOf(item) }))
    .sort((a, b) => a.depth - b.depth || compareCodes(a.item.key, b.item.key))
    .map(({ item }): ChartOfAccountsConfigDraft => ({
      ...item,
      code: item.key,
    }));
  return { ok: true, drafts };
}

export const chartOfAccountsConfigCodec = {
  section: "chart_of_accounts" as const,
  version: 1 as const,
  itemSchema: chartOfAccountsItemSchema,
  toTemplate,
  fromTemplate,
};
