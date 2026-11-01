// Text catalog access for components: const t = useT(); t("common.save").
// Tenant overrides (PRD §7 "override per tenant") are passed to I18nProvider
// once tenant config is resolved; until then the Indonesian catalog applies.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  createTranslator,
  messagesId,
  type MessageOverrides,
  type Translate,
} from "@starter/shared/i18n";

const defaultT = createTranslator(messagesId);
const I18nContext = createContext<Translate>(defaultT);

export function I18nProvider({
  overrides,
  children,
}: {
  overrides?: MessageOverrides;
  children: ReactNode;
}) {
  const t = useMemo(
    () => (overrides ? createTranslator(messagesId, overrides) : defaultT),
    [overrides],
  );
  return <I18nContext.Provider value={t}>{children}</I18nContext.Provider>;
}

export function useT(): Translate {
  return useContext(I18nContext);
}
