// Header shared by the two kitchen screens: the screen switch (a tab group)
// and the intro. The screen title, when the board was last read, and the
// manual refresh go to the OperationsShell status bar (useOperationsScreen);
// the h1 stays for screen readers only.
import { useState, type ReactNode } from "react";
import { RotateCw } from "lucide-react";
import { useT } from "@/components/i18n";
import { useOperationsScreen } from "@/components/shells/operations-screen";
import { Button } from "@/components/ui/button";
import { useOutletClock } from "@/lib/tenant-context";
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
  // The same zone as the shell clock beside it, so the two never disagree.
  const { timeZone } = useOutletClock();
  // The board polls every 10-15 s; only a tap on Muat ulang shows the busy
  // state, so the button is not disabled or resized on every background poll.
  const [manual, setManual] = useState<"idle" | "tapped" | "busy">("idle");
  if (manual === "tapped" && refreshPending) setManual("busy");
  else if (manual === "busy" && !refreshPending) setManual("idle");
  // The shell status bar names the screen and carries the freshness + refresh.
  useOperationsScreen({
    title,
    actions: (
      <>
        {updatedAt && (
          <p
            role="status"
            className="text-sm leading-5 whitespace-nowrap text-muted-foreground tabular"
          >
            {t("expo.updatedAt", {
              time: formatOutletTime(updatedAt, timeZone),
            })}
          </p>
        )}
        <Button
          variant="outline"
          size="sm"
          className="border-input"
          onClick={() => {
            setManual("tapped");
            onRefresh();
          }}
          loading={manual === "busy"}
        >
          <RotateCw aria-hidden="true" />
          {t("expo.refresh")}
        </Button>
      </>
    ),
  });
  return (
    <header className="flex flex-col gap-3">
      {/* The shell status bar shows the screen name; the heading stays for
          the document outline and screen readers (DESIGN.md §5: no duplicate
          page title). */}
      <h1 className="sr-only">{title}</h1>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <KitchenScreenNav current={current} />
        {actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
      <p className="max-w-prose text-sm leading-5 text-muted-foreground">
        {intro}
      </p>
    </header>
  );
}
