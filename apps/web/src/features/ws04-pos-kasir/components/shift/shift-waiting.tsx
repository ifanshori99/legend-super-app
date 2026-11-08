import { useT } from "@/components/i18n";
import type { ActiveShift } from "../../types";
import { Button } from "@/components/ui/button";
import { PosPageHeading, PosPanel, StateBlock, StatusPill } from "../shared";
import { useFocusHeading } from "./shift-parts";

// After the cashier sent the count: nothing left to do but wait. Shows no
// system balance and no variance (blind count).
export function ShiftWaiting({
  shift,
  onRecount,
  focusHeading = false,
}: {
  shift: Pick<ActiveShift, "cashierName" | "terminalLabel" | "countSequence">;
  /** Back to the count screen; the new count replaces the old one. */
  onRecount?: () => void;
  /** Move focus to the heading on mount (after a step swapped the screen). */
  focusHeading?: boolean;
}) {
  const t = useT();
  const rootRef = useFocusHeading(focusHeading);
  return (
    <div ref={rootRef} className="grid gap-4">
      <PosPageHeading
        title={t("posKasirShift.waiting.heading")}
        subtitle={t("posKasirShift.waiting.subtitle")}
        action={
          <StatusPill tone="warning">
            {t("posKasirShift.count.shiftPill", {
              cashier: shift.cashierName,
              terminal: shift.terminalLabel,
            })}
          </StatusPill>
        }
      />
      <PosPanel title={t("posKasirShift.waiting.status")}>
        <StateBlock
          mark="ok"
          title={t("posKasirShift.waiting.title")}
          description={t("posKasirShift.waiting.description")}
          role="status"
          aria-live="polite"
        />
        {shift.countSequence !== null && (
          <p className="tabular text-base font-semibold">
            {t("posKasirShift.waiting.sequence", {
              sequence: shift.countSequence,
            })}
          </p>
        )}
        {onRecount && (
          <div className="grid gap-2">
            <p className="text-base text-muted-foreground">
              {t("posKasirShift.waiting.recountNote")}
            </p>
            <Button variant="outline" onClick={onRecount}>
              {t("posKasirShift.waiting.recount")}
            </Button>
          </div>
        )}
      </PosPanel>
    </div>
  );
}
