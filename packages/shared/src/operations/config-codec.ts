// TEN-09 / legend-f7t7z: daily-operations checklist templates only. HRIS
// onboarding/offboarding templates and checklist runs are different aggregates.
// A template carries keys for its outlet, zone and role; item ids, source
// scope, shift/station ids, template version and transaction state never travel.
// This domain stays independent of the platform registry.

import { z } from "zod";
import {
  checklistEvidenceKindSchema,
  checklistTemplateTypeSchema,
  type ChecklistTemplate,
} from "./schemas.ts";

const itemKeySchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/);
const checklistEntrySchema = z.strictObject({
  label: z.string().trim().min(1).max(300),
  instruction: z.string().trim().min(1).max(1000).nullable(),
  requiredEvidence: z
    .array(checklistEvidenceKindSchema)
    .max(3)
    .refine(
      (kinds) => new Set(kinds).size === kinds.length,
      "Evidence kinds must be unique",
    ),
});

const checklistConfigItemSchema = z.strictObject({
  key: itemKeySchema,
  outletKey: itemKeySchema,
  name: z.string().trim().min(1).max(150),
  type: checklistTemplateTypeSchema,
  items: z.array(checklistEntrySchema).min(1).max(100),
  schedule: z.strictObject({
    dueTime: z.iso.time({ precision: -1 }),
    zoneKey: itemKeySchema.nullable(),
  }),
  roleKey: itemKeySchema.nullable(),
});

export type ChecklistConfigItem = z.infer<typeof checklistConfigItemSchema>;
/** Id-less drafts retain key references for the importer to resolve. */
export type ChecklistConfigDraft = ChecklistConfigItem;

export type ChecklistConfigExportContext = {
  outletKeyById: ReadonlyMap<string, string>;
  zoneKeyById: ReadonlyMap<string, string>;
  roleKeyById: ReadonlyMap<string, string>;
};

export type ChecklistConfigImportContext = {
  /** Omit when parsing a bundle without the target tenant's outlets. */
  outletKeys?: ReadonlySet<string>;
  /** Zone key -> owning outlet key, including existing target zones. */
  zoneOutletKeyByKey: ReadonlyMap<string, string>;
  roleKeys: ReadonlySet<string>;
};

type ChecklistConfigRow = Pick<
  ChecklistTemplate,
  "id" | "outletId" | "name" | "type" | "items" | "schedule" | "roleId"
>;

type ChecklistConfigDecodeResult =
  | { ok: true; drafts: ChecklistConfigDraft[] }
  | { ok: false; issues: string[] };

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Same name-based key convention as the existing tenant exporter. */
function configKey(...parts: string[]): string {
  const slug = parts
    .map((part) =>
      part
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean)
    .join(".");
  return (/^[a-z0-9]/.test(slug) ? slug : `k${slug}`).slice(0, 100) || "k";
}

function uniqueKey(base: string, used: Set<string>): string {
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) {
    const suffix = `-${n}`;
    candidate = base.slice(0, 100 - suffix.length) + suffix;
  }
  used.add(candidate);
  return candidate;
}

function needKey(
  map: ReadonlyMap<string, string>,
  id: string,
  reference: string,
): string {
  const key = map.get(id);
  if (key === undefined)
    throw new Error(`checklists: ${reference} has no exportable key`);
  return key;
}

export const checklistsConfigCodec = {
  section: "checklists" as const,
  version: 1 as const,
  itemSchema: checklistConfigItemSchema,

  toTemplate(
    rows: readonly ChecklistConfigRow[],
    ctx: ChecklistConfigExportContext,
  ): ChecklistConfigItem[] {
    const ordered = rows
      .map((row) => ({
        row,
        outletKey: needKey(ctx.outletKeyById, row.outletId, "outlet"),
      }))
      .sort(
        (a, b) =>
          compare(a.outletKey, b.outletKey) ||
          compare(a.row.name, b.row.name) ||
          compare(a.row.type, b.row.type) ||
          compare(a.row.id, b.row.id),
      );
    const keys = new Set<string>();
    return ordered.map(({ row, outletKey }) =>
      checklistConfigItemSchema.parse({
        key: uniqueKey(configKey(outletKey, "chk", row.name), keys),
        outletKey,
        name: row.name,
        type: row.type,
        items: row.items.map((entry) => ({
          label: entry.label,
          instruction: entry.instruction,
          requiredEvidence: [...entry.requiredEvidence],
        })),
        schedule: {
          dueTime: row.schedule.dueTime,
          zoneKey:
            row.schedule.zoneId === null
              ? null
              : needKey(ctx.zoneKeyById, row.schedule.zoneId, "zone"),
        },
        roleKey:
          row.roleId === null
            ? null
            : needKey(ctx.roleKeyById, row.roleId, "role"),
      }),
    );
  },

  fromTemplate(
    items: readonly unknown[],
    ctx: ChecklistConfigImportContext,
  ): ChecklistConfigDecodeResult {
    const issues: string[] = [];
    const drafts: ChecklistConfigDraft[] = [];
    const keys = new Set<string>();
    for (const raw of items) {
      const parsed = checklistConfigItemSchema.safeParse(raw);
      if (!parsed.success) {
        const key =
          typeof raw === "object" && raw !== null && "key" in raw
            ? raw.key
            : undefined;
        issues.push(
          `checklists item ${String(key)}: ${parsed.error.issues
            .map(
              (issue) => `${issue.path.join(".") || "item"} ${issue.message}`,
            )
            .join("; ")}`,
        );
        continue;
      }
      const item = parsed.data;
      if (keys.has(item.key))
        issues.push(`checklists item ${item.key}: duplicate key`);
      keys.add(item.key);
      if (ctx.outletKeys && !ctx.outletKeys.has(item.outletKey))
        issues.push(
          `checklists item ${item.key}: outletKey ${item.outletKey} is not a known outlet`,
        );
      if (item.roleKey !== null && !ctx.roleKeys.has(item.roleKey))
        issues.push(
          `checklists item ${item.key}: roleKey ${item.roleKey} is not a known role`,
        );
      if (item.schedule.zoneKey !== null) {
        const outletKey = ctx.zoneOutletKeyByKey.get(item.schedule.zoneKey);
        if (outletKey === undefined)
          issues.push(
            `checklists item ${item.key}: zoneKey ${item.schedule.zoneKey} is not a known zone`,
          );
        else if (outletKey !== item.outletKey)
          issues.push(
            `checklists item ${item.key}: zoneKey ${item.schedule.zoneKey} belongs to another outlet`,
          );
      }
      drafts.push(item);
    }
    return issues.length > 0 ? { ok: false, issues } : { ok: true, drafts };
  },
};
