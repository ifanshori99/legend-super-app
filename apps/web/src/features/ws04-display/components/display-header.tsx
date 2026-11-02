// Header of the customer display: what the screen is, that it is paired to a
// terminal, when it last read the terminal, and the manual refresh.
import { Monitor, RotateCw } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatOutletTime } from "../format.ts";

export function DisplayHeader({
  updatedAt,
  refreshPending,
  onRefresh,
}: {
  /** The snapshot's `updatedAt`; absent while the first read is in flight. */
  updatedAt: string | null;
  refreshPending: boolean;
  onRefresh: () => void;
}) {
  const t = useT();
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl leading-7 font-bold">{t("posDisplay.title")}</h1>
        <p className="max-w-prose text-sm leading-5 text-muted-foreground">
          {t("posDisplay.intro")}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Badge
          tone="neutral"
          className="rounded-full px-2.5 py-1 text-sm [&_svg]:size-4"
        >
          <Monitor aria-hidden="true" />
          {t("posDisplay.idle.paired")}
        </Badge>
        {updatedAt && (
          <p className="text-sm leading-5 text-muted-foreground tabular">
            {t("posDisplay.updatedAt", {
              time: formatOutletTime(updatedAt),
            })}
          </p>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          loading={refreshPending}
        >
          <RotateCw aria-hidden="true" />
          {t("posDisplay.refresh")}
        </Button>
      </div>
    </header>
  );
}
