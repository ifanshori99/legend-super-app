// Compile-time contract tests, checked by `pnpm typecheck` (never imported at
// runtime). Each @ts-expect-error line must fail to compile; if a refactor
// makes it compile, typecheck fails because the directive is unused.

import { cafeLegendFixtures, clientInputSchema, z } from "../core/index.ts";
import type { MessageKey } from "../i18n/index.ts";
import { createTermDictionary } from "./dictionary.ts";
import type { TextOverrideInput } from "./schemas.ts";
import type { TermKey } from "./terms.ts";

export function typeTests(): void {
  const key: TermKey = "terms.table";
  // @ts-expect-error a catalog key outside the registry is not a TermKey
  const notATerm: TermKey = "common.save";
  // @ts-expect-error a term key must be a catalog key
  const notInCatalog: MessageKey = "terms.notInCatalog";

  const dictionary = createTermDictionary({
    tenantId: cafeLegendFixtures.tenant.id,
  });
  // @ts-expect-error an arbitrary catalog key is not a term key
  dictionary.term("common.save");

  const withTenant: TextOverrideInput = {
    locale: "id",
    key: "terms.table",
    value: "Table",
    // @ts-expect-error request input never carries tenantId (TEN-02)
    tenantId: "0b6f1c2e-7d4a-4c1e-9a3b-2f5d8e1a4c70",
  };

  // @ts-expect-error a tenant field is forbidden in client input (TEN-02)
  clientInputSchema({ tenant_id: z.string() });

  void [key, notATerm, notInCatalog, dictionary, withTenant];
}
