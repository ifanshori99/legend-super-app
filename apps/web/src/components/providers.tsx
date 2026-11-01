import { MotionConfig } from "motion/react";
import { z } from "zod";
import { I18nProvider } from "@/components/i18n";
import { Toaster } from "@/components/ui/toast";
import { ThemeBootScript } from "@/lib/theme";

// Zod's built-in messages in Bahasa Indonesia for forms that do not set
// their own (Bahasa Indonesia is the default UI language).
z.config(z.locales.id());

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ThemeBootScript />
      <MotionConfig reducedMotion="user">
        <I18nProvider>
          <Toaster>{children}</Toaster>
        </I18nProvider>
      </MotionConfig>
    </>
  );
}
