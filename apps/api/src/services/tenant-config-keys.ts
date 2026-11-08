// TEN-09: one id → key map per referenced row kind, built the same way for
// every section. Keys come from names/codes (tenant-config-types.ts helpers);
// two rows whose names slug to the same key ("Kasir A" / "kasir-a", two
// facilities with one name) get `-2`, `-3`, … in a stable order (created_at,
// id), so the owning section and every section referencing it agree.
//
// Built on the SOURCE tenant at export, and on the TARGET tenant at import to
// pre-fill `ImportKeyMap` with rows that already exist there, so a partial
// import (e.g. only `wifi_policies`) resolves references to existing zones.

import { asc, eq } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import {
  facilities,
  floorZones,
  outlets,
  roles,
  taxRules,
} from "../db/schema/index.ts";
import {
  type ConfigTx,
  type ImportKeyMap,
  facilityConfigKey,
  roleConfigKey,
  taxRuleConfigKey,
  uniqueKeys,
  zoneConfigKey,
} from "./tenant-config-types.ts";

export type TenantKeyMaps = {
  /** zone / facility id → outlet id. */
  zoneOutlet: Map<string, string>;
  facilityOutlet: Map<string, string>;
  /** outlet id → outlet code. */
  outletCode: Map<string, string>;
  role: Map<string, string>;
  zone: Map<string, string>;
  facility: Map<string, string>;
  /** Every tax-rule version id → the rule's key (all versions share it). */
  taxRule: Map<string, string>;
};

export async function loadTenantKeyMaps(
  tx: ConfigTx,
  tenantId: string,
): Promise<TenantKeyMaps> {
  const outletRows = await tx
    .select({ id: outlets.id, code: outlets.code })
    .from(outlets)
    .where(eq(outlets.tenantId, tenantId))
    .orderBy(asc(outlets.code));
  const outletCode = new Map(outletRows.map((row) => [row.id, row.code]));

  const roleRows = await tx
    .select({
      id: roles.id,
      isTemplate: roles.isTemplate,
      templateKey: roles.templateKey,
      name: roles.name,
    })
    .from(roles)
    .where(eq(roles.tenantId, tenantId))
    .orderBy(asc(roles.createdAt), asc(roles.id));
  const roleKey = uniqueKeys();
  const role = new Map(
    roleRows.map((row) => [row.id, roleKey(roleConfigKey(row))]),
  );

  const zoneRows = await tx
    .select({
      id: floorZones.id,
      outletId: floorZones.outletId,
      name: floorZones.name,
    })
    .from(floorZones)
    .where(eq(floorZones.tenantId, tenantId as TenantId))
    .orderBy(asc(floorZones.createdAt), asc(floorZones.id));
  const zoneKey = uniqueKeys();
  const zone = new Map<string, string>();
  const zoneOutlet = new Map<string, string>();
  for (const row of zoneRows) {
    const code = outletCode.get(row.outletId);
    if (!code) continue;
    zone.set(row.id, zoneKey(zoneConfigKey(code, row.name)));
    zoneOutlet.set(row.id, row.outletId);
  }

  const facilityRows = await tx
    .select({
      id: facilities.id,
      outletId: facilities.outletId,
      name: facilities.name,
    })
    .from(facilities)
    .where(eq(facilities.tenantId, tenantId as TenantId))
    .orderBy(asc(facilities.id));
  const facilityKey = uniqueKeys();
  const facility = new Map<string, string>();
  const facilityOutlet = new Map<string, string>();
  for (const row of facilityRows) {
    const code = outletCode.get(row.outletId);
    if (!code) continue;
    facility.set(row.id, facilityKey(facilityConfigKey(code, row.name)));
    facilityOutlet.set(row.id, row.outletId);
  }

  // One key per (outlet, code); every version of that rule maps to it.
  const taxRows = await tx
    .select({
      id: taxRules.id,
      outletId: taxRules.outletId,
      code: taxRules.code,
    })
    .from(taxRules)
    .where(eq(taxRules.tenantId, tenantId as TenantId))
    .orderBy(asc(taxRules.createdAt), asc(taxRules.id));
  const taxKey = uniqueKeys();
  const byRule = new Map<string, string>();
  const taxRule = new Map<string, string>();
  for (const row of taxRows) {
    const code = row.outletId ? outletCode.get(row.outletId) : null;
    if (row.outletId && !code) continue;
    const natural = `${row.outletId ?? ""}\u0000${row.code}`;
    let key = byRule.get(natural);
    if (!key) {
      key = taxKey(taxRuleConfigKey(code ?? null, row.code));
      byRule.set(natural, key);
    }
    taxRule.set(row.id, key);
  }

  return {
    outletCode,
    role,
    zone,
    zoneOutlet,
    facility,
    facilityOutlet,
    taxRule,
  };
}

/**
 * Import pre-fill: rows the target already has, under the keys a bundle would
 * use for them. Handlers then add entries for rows they insert. A tax-rule key
 * maps to the newest version row (rows are read in created_at order).
 */
export async function prefillImportKeys(
  tx: ConfigTx,
  tenantId: string,
  keys: ImportKeyMap,
): Promise<void> {
  const maps = await loadTenantKeyMaps(tx, tenantId);
  for (const [id, key] of maps.role) keys.roles.set(key, id);
  for (const [id, key] of maps.zone) {
    keys.zones.set(key, id);
    keys.zoneOutlets.set(key, maps.zoneOutlet.get(id)!);
  }
  for (const [id, key] of maps.facility) {
    keys.facilities.set(key, id);
    keys.facilityOutlets.set(key, maps.facilityOutlet.get(id)!);
  }
  for (const [id, key] of maps.taxRule) keys.taxRules.set(key, id);
}
