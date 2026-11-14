// Edge master sync snapshot (bead legend-9ppw; PRD v1.7 §3 F5 "Server Lokal").
// The edge node posts stock movements against stock locations, and journals
// against accounts, that must exist in the cloud with the SAME ids. The cloud
// owns these masters; the edge pulls a full snapshot at first boot and again
// when they change:
//   - `uoms`: tenant-wide unit catalog;
//   - `stock_locations`: the credential's outlet ONLY;
//   - `chart_of_accounts` + `account_mappings`: the outlet's legal entity ONLY.
// It is a full snapshot, not a cursor: `uoms` and `stock_locations` have no
// `updated_at`, so changes cannot be listed. The edge upserts uoms, locations
// and accounts by id and never deletes them (ledger rows reference them). The
// mapping set is replaced: a role missing from the snapshot is deleted on the
// edge, as the cloud replaces the whole set per legal entity.
//
// Mapping `role` travels as a bounded string, not the closed posting-role enum
// (legend-dhbt1): a newer cloud may map a role this edge build does not know
// yet. The schema still rejects an empty, over-long (column is varchar(40)) or
// duplicate role; `partitionEdgeMasterMappings` splits the known roles from the
// unknown ones, and the edge drops (logs and counts) the unknown ones before it
// applies the rest. The signature covers the snapshot as sent, unknown roles
// included, so filtering happens only after the signature check.
// Rollout rules while edges of different builds run:
//   - Edges built before legend-dhbt1 still refuse a snapshot with an unknown
//     role (BAD_SNAPSHOT). Ship this build to every edge before the cloud maps
//     any new posting role.
//   - Roles are additive only. A renamed or split role makes an older edge drop
//     the new name and delete its local mapping for the old one, so its own
//     postings to that role fail until it is upgraded.
//
// `signature` is HMAC-SHA256 (hex) over `canonicalJson(snapshot)`, keyed with
// the node's credential digest, exactly like the bootstrap bundle (see
// ./bootstrap.ts for what that does and does not prove: integrity and
// misrouting only; authenticity comes from TLS).
//
// Rows are FK-complete inside the snapshot: parent accounts and the accounts
// named by mappings are present, and every row carries the snapshot's scope.

import {
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  z,
} from "../core/index.ts";
import {
  accountTypeSchema,
  postingAccountRoleSchema,
  reportGroupSchema,
  type PostingAccountRole,
} from "../accounting/coa.ts";
import { accountIdSchema } from "../accounting/ids.ts";
import {
  stockLocationIdSchema,
  stockLocationTypeSchema,
  uomIdSchema,
} from "../inventory/schemas.ts";
import { legalEntityIdSchema } from "../platform/ids.ts";

export const EDGE_MASTER_SNAPSHOT_PATH = "/api/edge-sync/bootstrap/masters";
export const EDGE_MASTER_SNAPSHOT_VERSION = 1;

/** Caps keep a corrupt or hostile response from exhausting edge memory. */
const MAX_UOMS = 1000;
const MAX_LOCATIONS = 200;
const MAX_ACCOUNTS = 5000;
const MAX_MAPPINGS = 200;

const name150 = z.string().min(1).max(150);

export const edgeMasterUomSchema = z.strictObject({
  id: uomIdSchema,
  tenantId: tenantIdSchema,
  code: z.string().min(1).max(10),
  name: name150,
  isSystem: z.boolean().default(false),
  createdAt: isoDateTimeSchema,
});
export type EdgeMasterUom = z.infer<typeof edgeMasterUomSchema>;

export const edgeMasterStockLocationSchema = z.strictObject({
  id: stockLocationIdSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  name: name150,
  type: stockLocationTypeSchema,
  isActive: z.boolean(),
  createdAt: isoDateTimeSchema,
});
export type EdgeMasterStockLocation = z.infer<
  typeof edgeMasterStockLocationSchema
>;

export const edgeMasterAccountSchema = z.strictObject({
  id: accountIdSchema,
  tenantId: tenantIdSchema,
  legalEntityId: legalEntityIdSchema,
  code: z.string().min(1).max(20),
  name: name150,
  type: accountTypeSchema,
  reportGroup: reportGroupSchema,
  parentId: accountIdSchema.nullable(),
  isActive: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type EdgeMasterAccount = z.infer<typeof edgeMasterAccountSchema>;

export const edgeMasterAccountMappingSchema = z.strictObject({
  tenantId: tenantIdSchema,
  legalEntityId: legalEntityIdSchema,
  /** Any posting role name, known to this build or not (see the header). */
  role: z.string().min(1).max(40),
  accountId: accountIdSchema,
});
export type EdgeMasterAccountMapping = z.infer<
  typeof edgeMasterAccountMappingSchema
>;
/** A snapshot mapping whose role this build knows. */
export type KnownEdgeMasterAccountMapping = Omit<
  EdgeMasterAccountMapping,
  "role"
> & { role: PostingAccountRole };

/** Scope-consistent: one tenant, one outlet, one legal entity, ids unique. */
export const edgeMasterSnapshotSchema = z
  .strictObject({
    version: z.literal(EDGE_MASTER_SNAPSHOT_VERSION),
    issuedAt: isoDateTimeSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    legalEntityId: legalEntityIdSchema,
    uoms: z.array(edgeMasterUomSchema).max(MAX_UOMS),
    stockLocations: z.array(edgeMasterStockLocationSchema).max(MAX_LOCATIONS),
    chartOfAccounts: z.array(edgeMasterAccountSchema).max(MAX_ACCOUNTS),
    accountMappings: z.array(edgeMasterAccountMappingSchema).max(MAX_MAPPINGS),
  })
  .superRefine((snapshot, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const { tenantId, outletId, legalEntityId } = snapshot;

    const checkUnique = (
      key: "uoms" | "stockLocations" | "chartOfAccounts",
    ) => {
      const seen = new Set<string>();
      snapshot[key].forEach((row, index) => {
        if (seen.has(row.id)) issue([key, index, "id"], "Duplicate id");
        seen.add(row.id);
      });
    };
    checkUnique("uoms");
    checkUnique("stockLocations");
    checkUnique("chartOfAccounts");

    const wrongTenant = (path: (string | number)[]) =>
      issue(path, "Row does not belong to the snapshot's tenant");
    snapshot.uoms.forEach((row, index) => {
      if (row.tenantId !== tenantId) wrongTenant(["uoms", index, "tenantId"]);
    });
    snapshot.stockLocations.forEach((row, index) => {
      if (row.tenantId !== tenantId)
        wrongTenant(["stockLocations", index, "tenantId"]);
      if (row.outletId !== outletId)
        issue(
          ["stockLocations", index, "outletId"],
          "Location does not belong to the snapshot's outlet",
        );
    });
    const accountIds = new Set<string>(
      snapshot.chartOfAccounts.map((account) => account.id),
    );
    snapshot.chartOfAccounts.forEach((row, index) => {
      if (row.tenantId !== tenantId)
        wrongTenant(["chartOfAccounts", index, "tenantId"]);
      if (row.legalEntityId !== legalEntityId)
        issue(
          ["chartOfAccounts", index, "legalEntityId"],
          "Account does not belong to the snapshot's legal entity",
        );
      if (row.parentId !== null && !accountIds.has(row.parentId))
        issue(
          ["chartOfAccounts", index, "parentId"],
          "Parent account is not in the snapshot",
        );
    });
    const roles = new Set<string>();
    snapshot.accountMappings.forEach((row, index) => {
      if (roles.has(row.role))
        issue(["accountMappings", index, "role"], "Duplicate role");
      roles.add(row.role);
      if (row.tenantId !== tenantId)
        wrongTenant(["accountMappings", index, "tenantId"]);
      if (row.legalEntityId !== legalEntityId)
        issue(
          ["accountMappings", index, "legalEntityId"],
          "Mapping does not belong to the snapshot's legal entity",
        );
      if (!accountIds.has(row.accountId))
        issue(
          ["accountMappings", index, "accountId"],
          "Mapped account is not in the snapshot",
        );
    });
  });
export type EdgeMasterSnapshot = z.infer<typeof edgeMasterSnapshotSchema>;

export const edgeMasterSnapshotResponseSchema = z.strictObject({
  snapshot: edgeMasterSnapshotSchema,
  /** HMAC-SHA256 (lowercase hex) over canonicalJson(snapshot). */
  signature: z.string().regex(/^[0-9a-f]{64}$/),
});
export type EdgeMasterSnapshotResponse = z.infer<
  typeof edgeMasterSnapshotResponseSchema
>;

/**
 * Splits snapshot mappings into the roles this build knows (typed) and the
 * names of the roles it does not know, in snapshot order (legend-dhbt1).
 */
export function partitionEdgeMasterMappings(
  mappings: readonly EdgeMasterAccountMapping[],
): { known: KnownEdgeMasterAccountMapping[]; unknownRoles: string[] } {
  const known: KnownEdgeMasterAccountMapping[] = [];
  const unknownRoles: string[] = [];
  for (const row of mappings) {
    const role = postingAccountRoleSchema.safeParse(row.role);
    if (role.success) known.push({ ...row, role: role.data });
    else unknownRoles.push(row.role);
  }
  return { known, unknownRoles };
}
