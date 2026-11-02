// Promo texts live in the shared catalog under "promo.*" (messages/promo.ts).
// This hook keeps call sites short: t("editor.save") → catalog "promo.editor.save".
import { useMemo } from "react";
import type { TranslateVars } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";

export type PromoKey = string;
export type PromoT = (key: string, vars?: TranslateVars) => string;

export function usePromoT(): PromoT {
  const t = useT();
  return useMemo(
    () => (key, vars) =>
      (t as (k: string, v?: TranslateVars) => string)(`promo.${key}`, vars),
    [t],
  );
}
