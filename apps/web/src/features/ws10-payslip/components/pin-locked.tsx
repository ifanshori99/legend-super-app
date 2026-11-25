// Lock notice shared by every payslip PIN screen (bead legend-ilzrj): the
// danger notice with its left rule, minutes left (ticking every 30 seconds),
// the way back and the "Lupa PIN?" link. It is the card body only; the caller
// wraps it in PinLayout with the terkunci title, description and side text.
// `onUnlocked` fires once the lock time has passed so the caller can show its
// form again. `lockedUntil` null means "locked, no clock": no minutes line and
// no expiry.
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { LockKeyhole } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { minutesUntil } from "../pin-state.ts";

type PinLockedProps = {
  lockedUntil: string | null;
  onUnlocked?: () => void;
};

const TICK_MS = 30_000;

function PinLocked({ lockedUntil, onUnlocked }: PinLockedProps) {
  const t = useT();
  const [now, setNow] = useState(() => new Date());
  const minutes = minutesUntil(lockedUntil, now);
  const expired = minutes === 0;

  useEffect(() => {
    if (lockedUntil === null) return;
    const timer = window.setInterval(() => setNow(new Date()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [lockedUntil]);

  useEffect(() => {
    if (expired) onUnlocked?.();
  }, [expired, onUnlocked]);

  return (
    <>
      <div
        role="status"
        className="flex items-start gap-3 rounded-field border-l-4 border-danger bg-danger-subtle p-4"
      >
        <LockKeyhole
          className="mt-0.5 size-5 shrink-0 text-danger"
          aria-hidden="true"
        />
        <div className="grid gap-0.5">
          <p className="text-base font-bold">
            {t("payslipPin.terkunci.noticeTitle")}
          </p>
          <p className="text-sm leading-5">{t("payslipPin.terkunci.notice")}</p>
          {minutes !== null && (
            <p className="text-sm leading-5 font-medium">
              {t("payslipPin.terkunci.remaining", { minutes })}
            </p>
          )}
        </div>
      </div>
      <Button asChild variant="outline" size="lg" className="w-full">
        <Link to="/karyawan/slip-gaji">
          {t("payslipPin.common.backToList")}
        </Link>
      </Button>
      <Button asChild variant="link" className="min-h-11 w-full sm:min-h-0">
        <Link to="/karyawan/slip-gaji/lupa-pin">
          {t("payslipPin.common.forgotPin")}
        </Link>
      </Button>
    </>
  );
}

export { PinLocked };
export type { PinLockedProps };
