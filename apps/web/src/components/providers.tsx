import { MotionConfig } from "motion/react";
import { z } from "zod";
import type { MessageOverrides } from "@starter/shared/i18n";
import { I18nProvider } from "@/components/i18n";
import { Toaster } from "@/components/ui/toast";
import { ThemeBootScript } from "@/lib/theme";

// Zod's built-in messages in Bahasa Indonesia for forms that do not set
// their own (Bahasa Indonesia is the default UI language).
z.config(z.locales.id());

export function Providers({
  overrides,
  chunks,
  children,
}: {
  /** Tenant text overrides (PRD §7); none until a public source exists. */
  overrides?: MessageOverrides;
  /** Catalog chunks of the matched areas, as in `data-i18n-chunks`. */
  chunks?: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <ThemeBootScript />
      <MotionConfig reducedMotion="user">
        <I18nProvider overrides={overrides} chunks={chunks}>
          <Toaster>{children}</Toaster>
        </I18nProvider>
      </MotionConfig>
    </>
  );
}
