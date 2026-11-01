// Which screen of the kitchen area is open, and the way to the other one. The
// OperationsShell has no navigation chrome (it owns the whole screen), so the
// kitchen screens carry their own two-item switch (docs/frontend.md, area
// `kitchen`: /kds/*, /expo, /pickup).
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";

export type KitchenScreen = "expo" | "pickup";

const SCREENS: readonly {
  key: KitchenScreen;
  to: "/expo" | "/pickup";
  labelKey: MessageKey;
}[] = [
  { key: "expo", to: "/expo", labelKey: "expo.title" },
  { key: "pickup", to: "/pickup", labelKey: "pickup.title" },
];

export function KitchenScreenNav({ current }: { current: KitchenScreen }) {
  const t = useT();
  return (
    <nav aria-label={t("expo.screens")} className="flex flex-wrap gap-1">
      {SCREENS.map(({ key, to, labelKey }) => {
        const active = key === current;
        return (
          <Link
            key={key}
            to={to}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex min-h-control-sm items-center rounded-control px-3 text-sm font-semibold transition-colors duration-(--duration-fast)",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {t(labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}
