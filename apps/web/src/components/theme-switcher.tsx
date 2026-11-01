import { Monitor, Moon, Sun } from "lucide-react";
import type { ThemePreference } from "@starter/shared/theme";
import { useT } from "@/components/i18n";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useTheme } from "@/lib/theme";

/** Light / dark / follow device. The choice persists in localStorage. */
export function ThemeSwitcher({ className }: { className?: string }) {
  const t = useT();
  const { preference, setPreference } = useTheme();
  return (
    <SegmentedControl<ThemePreference>
      label={t("theme.label")}
      value={preference}
      onValueChange={setPreference}
      className={className}
      options={[
        { value: "light", label: t("theme.light"), icon: Sun },
        { value: "dark", label: t("theme.dark"), icon: Moon },
        { value: "system", label: t("theme.system"), icon: Monitor },
      ]}
    />
  );
}
