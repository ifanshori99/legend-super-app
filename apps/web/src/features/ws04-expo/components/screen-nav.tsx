// Which screen of the kitchen area is open, and the way to the other one. The
// OperationsShell has no navigation chrome (it owns the whole screen), so the
// kitchen screens carry their own two-item switch (docs/frontend.md, area
// `kitchen`: /kds/*, /expo, /pickup).
//
// v3: the switch is a tab group (DESIGN.md §4 Tabs, §5 Operations) — the same
// bordered surface-2 track and card chip as <Tabs>, with the current screen in
// ink. It is navigation, not the screen's one accent action (Q21).
import { Link } from "@tanstack/react-router";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { tabsListClass, tabsTriggerClass } from "@/components/ui/tabs";

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
    <nav aria-label={t("expo.screens")} className={tabsListClass}>
      {SCREENS.map(({ key, to, labelKey }) => (
        <Link
          key={key}
          to={to}
          aria-current={key === current ? "page" : undefined}
          className={tabsTriggerClass}
        >
          {t(labelKey)}
        </Link>
      ))}
    </nav>
  );
}
