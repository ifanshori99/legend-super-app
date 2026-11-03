// Catalog access for the outlet settings screen (bead legend-1mi5, follow-up
// legend-5kop). The `orgOutlet.*` strings are real catalog keys
// (packages/shared/src/i18n/messages/org-outlet.ts), so the typed `MessageKey`
// union covers them and the screen cannot render a raw key: a typo fails the
// typecheck instead of reaching the browser.
import { useMemo } from "react";
import type { MessageKey, TranslateVars } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";

/** Every key this screen may read: the catalog's `orgOutlet.*` namespace. */
export type OrgOutletKey = Extract<MessageKey, `orgOutlet.${string}`>;

export type OrgOutletT = (key: OrgOutletKey, vars?: TranslateVars) => string;

export function useOrgOutletT(): OrgOutletT {
  const t = useT();
  return useMemo(() => (key, vars) => t(key, vars), [t]);
}
