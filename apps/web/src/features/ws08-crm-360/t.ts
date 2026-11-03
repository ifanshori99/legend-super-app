// CRM texts live in the shared catalog under "crm360.*"
// (packages/shared/src/i18n/messages/ws08-crm-360.ts, registered as
// `crm360: crm360Messages` in id.ts). This hook keeps call sites short and
// reads the keys as strings, like the promo admin
// (features/ws08-promo/t.ts), so a key rename is one catalog edit.
import { useMemo } from "react";
import type { TranslateVars } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";

export type Crm360T = (key: string, vars?: TranslateVars) => string;

export function useCrm360T(): Crm360T {
  const t = useT();
  return useMemo(
    () => (key, vars) =>
      (t as (k: string, v?: TranslateVars) => string)(
        key.startsWith("crm360.") ? key : `crm360.${key}`,
        vars,
      ),
    [t],
  );
}
