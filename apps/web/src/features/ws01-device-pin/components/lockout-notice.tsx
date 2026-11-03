// Shown instead of an open pad's hint once 5 wrong PINs lock it (PRD v1.7 §3
// F6). The countdown is the contract's lock window; a supervisor override
// clears it sooner (AUTH-06).
import { Lock } from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusBand } from "@/components/ui/status-band";
import { formatCountdown } from "../logic.ts";

export function LockoutNotice({ remainingMs }: { remainingMs: number }) {
  const t = useT();
  const time = formatCountdown(remainingMs);
  return (
    <div
      role="alert"
      data-testid="pin-lockout"
      className="overflow-hidden rounded-container border-(length:--border-w)"
    >
      <StatusBand
        tone="danger"
        icon={Lock}
        label={t("devicePin.lockout.title")}
      >
        <p className="text-sm font-semibold">
          {t("devicePin.lockout.countdown")}
        </p>
        <p
          className="tabular text-3xl leading-tight font-semibold"
          data-testid="pin-lockout-time"
        >
          {time}
        </p>
      </StatusBand>
      <div className="grid gap-1 bg-card p-4 text-sm leading-5">
        <p>{t("devicePin.lockout.body", { time })}</p>
        <p className="text-muted-foreground">
          {t("devicePin.lockout.supervisor")}
        </p>
      </div>
    </div>
  );
}
