// Toolbar shared by the two kitchen screens: the screen switch (a tab group),
// when the board was last read, and the manual refresh. The OperationsShell
// status bar already names the area, so the screen title is carried by the tab
// group and repeated only for screen readers — no second visible page title.
import type { ReactNode } from "react";
import { RotateCw } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { formatOutletTime } from "../format.ts";
import { KitchenScreenNav, type KitchenScreen } from "./screen-nav.tsx";

export function KitchenScreenHeader({
  title,
  intro,
  current,
  updatedAt,
  refreshPending,
  onRefresh,
  actions,
}: {
  title: string;
  intro: string;
  current: KitchenScreen;
  /** The board's `generatedAt`; absent while the first read is in flight. */
  updatedAt: string | null;
  refreshPending: boolean;
  onRefresh: () => void;
  actions?: ReactNode;
}) {
  const t = useT();
  return (
    <header className="flex flex-col gap-3">
      {/* The tab group shows the screen name; the heading stays for the
          document outline and screen readers (DESIGN.md §5: no duplicate
          page title when the shell and the tab group already name the view). */}
      <h1 className="sr-only">{title}</h1>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <KitchenScreenNav current={current} />
        <div className="flex flex-wrap items-center gap-2">
          {updatedAt && (
            <p className="text-sm leading-5 text-muted-foreground tabular">
              {t("expo.updatedAt", { time: formatOutletTime(updatedAt) })}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            loading={refreshPending}
          >
            <RotateCw aria-hidden="true" />
            {t("expo.refresh")}
          </Button>
          {actions}
        </div>
      </div>
      <p className="max-w-prose text-sm leading-5 text-muted-foreground">
        {intro}
      </p>
    </header>
  );
}
