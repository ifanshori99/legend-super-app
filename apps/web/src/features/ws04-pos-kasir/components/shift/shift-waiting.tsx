import { useT } from "@/components/i18n";
import type { ActiveShift } from "../../types";
import { PosPageHeading, PosPanel, StateBlock, StatusPill } from "../shared";

// After the cashier sent the count: nothing left to do but wait. Shows no
// system balance and no variance (blind count).
export function ShiftWaiting({
  shift,
}: {
  shift: Pick<ActiveShift, "cashierName" | "terminalLabel">;
}) {
  const t = useT();
  return (
    <div className="grid gap-4">
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
      </PosPanel>
    </div>
  );
}
