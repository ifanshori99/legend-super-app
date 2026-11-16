import { Monitor, Moon, Sun } from "lucide-react";
import type { ThemePreference } from "@starter/shared/theme";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme";

const NEXT: Record<ThemePreference, ThemePreference> = {
  light: "dark",
  dark: "system",
  system: "light",
};
const ICON = { light: Sun, dark: Moon, system: Monitor } as const;

/** One-tap theme cycle (terang → gelap → ikuti perangkat) for shell headers. */
export function ThemeToggle({ className }: { className?: string }) {
  const t = useT();
  const { preference, setPreference } = useTheme();
  const Icon = ICON[preference];
  return (
    <Button
      variant="ghost"
      size="icon"
      className={className}
      onClick={() => setPreference(NEXT[preference])}
    >
      <Icon aria-hidden="true" />
      <span className="sr-only">
        {t("layout.themeToggle")}: {t(`theme.${preference}`)}
      </span>
    </Button>
  );
}
