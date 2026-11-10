// TEN-09 (PRD v1.7 §3 F4 "Konfigurasi sebagai Data & Template Tenant"):
// shared plumbing for the per-section exporters/importers. Each owning area
// exports its rows as tenant-free items (references by `key`, never by id)
// and imports them into a target tenant inside ONE transaction opened by
// tenant-config.service.ts.

import type { ScopedTenantContext } from "@starter/shared/core";
import type { ConfigSection } from "@starter/shared/platform";
import type { db } from "../db/index.ts";

/** The transaction handle `withTenant` passes to its callback. */
export type ConfigTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Section payload in the bundle: `{ version, items }` for generic sections. */
export type GenericSectionPayload = {
  version: number;
  items: Array<Record<string, unknown> & { key: string }>;
};

/**
 * Key → target-tenant id, filled while importing so later sections can
 * resolve references made by earlier ones. Importers record a key for rows
 * they insert AND for rows that already existed (skip-if-exists), so a
 * re-import resolves references to the earlier copy.
 */
export class ImportKeyMap {
  /** Source outlet key (lower-cased outlet code) → target outlet id. */
  readonly outlets = new Map<string, string>();
  readonly roles = new Map<string, string>();
  readonly accounts = new Map<string, string>();
  readonly taxRules = new Map<string, string>();
  readonly zones = new Map<string, string>();
  readonly facilities = new Map<string, string>();
  readonly facilityAreas = new Map<string, string>();
  /** Zone / facility key → its target outlet id: a row may only reference a
   * zone or facility of its own outlet (`needInOutlet`). */
  readonly zoneOutlets = new Map<string, string>();
  readonly facilityOutlets = new Map<string, string>();

  /** Like `need`, and the referenced zone/facility must sit in `outletId`. */
  needInOutlet(
    kind: "zones" | "facilities",
    key: string,
    outletId: string,
  ): string {
    const id = this.need(kind, key);
    const owner = (
      kind === "zones" ? this.zoneOutlets : this.facilityOutlets
    ).get(key);
    if (owner !== outletId)
      throw new ConfigImportError(
        `The ${kind} reference "${key}" belongs to another outlet.`,
      );
    return id;
  }

  /** Resolve a reference or fail the whole import (atomic rollback). */
  need(
    kind:
      | "outlets"
      | "roles"
      | "accounts"
      | "taxRules"
      | "zones"
      | "facilities"
      | "facilityAreas",
    key: string,
  ): string {
    const id = (this[kind] as Map<string, string>).get(key);
    if (!id)
      throw new ConfigImportError(
        `Unknown ${kind} reference "${key}" in the bundle.`,
      );
    return id;
  }
}

export type ExportContext = {
  tx: ConfigTx;
  ctx: ScopedTenantContext;
  tenantId: string;
};

export type ImportContext = ExportContext & {
  keys: ImportKeyMap;
  actorUserId: string;
  now: Date;
  /** Human-readable notes (e.g. items skipped because no target outlet). */
  warn: (message: string) => void;
};

/** Thrown by an importer to abort the import: rolls back, status `failed`. */
export class ConfigImportError extends Error {
  override readonly name = "ConfigImportError";
}

export type SectionHandler = {
  section: ConfigSection;
  /** Read the source tenant's rows; `undefined` when it has none. */
  exportSection: (input: ExportContext) => Promise<unknown | undefined>;
  /** Apply into the target tenant. Must be idempotent: skip-if-exists on a
   * natural key, never duplicate, never edit an existing row. */
  importSection: (input: ImportContext, payload: unknown) => Promise<void>;
};

/**
 * A bundle item key: lower-case, `[a-z0-9][a-z0-9_.-]{0,99}` (shared
 * `itemKey`). Parts are slugged and joined with `.`.
 */
export function configKey(...parts: Array<string | number>): string {
  const slug = parts
    .map((part) =>
      String(part)
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean)
    .join(".");
  const key = (/^[a-z0-9]/.test(slug) ? slug : `k${slug}`).slice(0, 100);
  return key || "k";
}

/** Make keys unique inside one section (`name`, `name-2`, …). */
export function uniqueKeys(): (base: string) => string {
  const seen = new Map<string, number>();
  return (base) => {
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : configKey(`${base.slice(0, 95)}-${count}`);
  };
}

/** Outlet key for a source outlet code (codes are `[A-Z0-9-]`). */
export const outletKey = (code: string) => code.toLowerCase();

// Cross-section key rules. A section that references another section's row
// (checklist → role, service charge → zone, product → tax rule, …) derives
// the key with the SAME helper the owning exporter uses.

/** Role key: template roles by template key, custom roles by name. */
export const roleConfigKey = (role: {
  isTemplate: boolean;
  templateKey: string | null;
  name: string;
}) =>
  role.isTemplate && role.templateKey
    ? configKey("tpl", role.templateKey)
    : configKey("role", role.name);

/** Floor zone key: unique per outlet by name. */
export const zoneConfigKey = (outletCode: string, name: string) =>
  configKey(outletKey(outletCode), name);

/** Tax / service-charge rule key: `tenant` default or an outlet override. */
export const taxRuleConfigKey = (outletCode: string | null, code: string) =>
  configKey(outletCode ? outletKey(outletCode) : "tenant", code);

/** Facility key: unique per outlet by name. */
export const facilityConfigKey = (outletCode: string, name: string) =>
  configKey(outletKey(outletCode), name);

/** Account key in the CoA section: by account code. */
export const accountConfigKey = (code: string) => configKey("acct", code);
