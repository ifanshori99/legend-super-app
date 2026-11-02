// Dynamic QRIS panel (PRD §3 F11 "Pembayaran" and §3 F13 "QRIS Dinamis"): the
// code, the amount, and a live countdown. When the code expires the query reads
// a fresh one (lib.ts displayRefetchMs); this panel shows that the old code is
// no longer payable instead of silently leaving it on screen.
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { CustomerDisplayQris } from "@starter/shared/pos";
import { formatRupiah } from "@starter/shared/i18n";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { QrCode } from "@/components/ui/qr-code";
import { formatCountdown, isQrisExpired, secondsUntilExpiry } from "../lib.ts";

/** Re-renders once a second so the countdown stays true. */
function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

export function QrisPanel({ qris }: { qris: CustomerDisplayQris }) {
  const t = useT();
  const now = useNowMs();
  const expired = isQrisExpired(qris, now);
  const remaining = secondsUntilExpiry(qris.expiresAt, now);
  const amount = formatRupiah(qris.amountIdr);

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="type-title">{t("posDisplay.qris.title")}</h2>
        <Badge tone="brand">{t("posDisplay.tender.qris")}</Badge>
      </div>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("posDisplay.qris.hint")}
      </p>
      <div className="grid justify-items-center gap-3">
        {/* An expired code is removed, not dimmed: a faded QR still scans
            (PRD §3 F13, the customer must never pay a dead code). */}
        {expired ? (
          <div
            aria-hidden="true"
            className="size-58 rounded-container border-(length:--border-w) border-dashed border-border bg-surface-2 sm:size-62 2xl:size-78"
          />
        ) : (
          <QrCode
            value={qris.payload}
            label={t("posDisplay.qris.alt", { amount })}
            size={288}
            svgClassName="size-52 sm:size-56 2xl:size-72"
            className="rounded-container border-(length:--border-w) border-border p-3"
          />
        )}
        <p
          // Announce the switch to "expired", not every countdown second.
          aria-live={expired ? "polite" : "off"}
          className={cn(
            "flex items-center gap-2 text-sm leading-5",
            expired
              ? "font-semibold text-warning"
              : "text-muted-foreground tabular",
          )}
        >
          {expired ? (
            <>
              <Loader2
                className="size-4 motion-safe:animate-spin"
                aria-hidden="true"
              />
              {t("posDisplay.qris.expired")}
            </>
          ) : (
            t("posDisplay.qris.expires", {
              time: formatCountdown(remaining),
            })
          )}
        </p>
      </div>
    </Card>
  );
}
