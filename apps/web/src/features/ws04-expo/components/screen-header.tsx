// Page header shared by the two kitchen screens: title, the one-line purpose,
// the screen switch, when the board was last read, and the manual refresh.
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="type-display">{title}</h1>
          <p className="max-w-prose text-sm leading-5 text-muted-foreground">
            {intro}
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <KitchenScreenNav current={current} />
        {updatedAt && (
          <p className="text-sm leading-5 text-muted-foreground tabular">
            {t("expo.updatedAt", { time: formatOutletTime(updatedAt) })}
          </p>
        )}
      </div>
    </header>
  );
}
