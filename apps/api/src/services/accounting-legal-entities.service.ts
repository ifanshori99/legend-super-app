// Legal-entity picker for the finance screens (legend-bddb). Reuses the org
// read model (`listLegalEntities`, RLS-scoped to the tenant in the context)
// and narrows it to the fields in `accountingLegalEntitySchema`: id, name,
// masked NPWP (last four digits) and PKP flag. The org route and its
// `org.structure.manage` guard are untouched.

import {
  accountingLegalEntitySchema,
  type AccountingLegalEntity,
} from "@starter/shared/accounting";
import type { ScopedTenantContext } from "@starter/shared/core";
import { listLegalEntities as listOrgLegalEntities } from "./org.service.ts";

export async function listAccountingLegalEntities(
  context: ScopedTenantContext,
): Promise<AccountingLegalEntity[]> {
  const { data } = await listOrgLegalEntities(context);
  return data.map((row) =>
    accountingLegalEntitySchema.parse({
      id: row.id,
      name: row.name,
      npwpLast4: row.npwpLast4,
      isPkp: row.isPkp,
    }),
  );
}
