// Dynamic QRIS panel (PRD §3 F11 "Pembayaran" and §3 F13 "QRIS Dinamis"): the
// code, the amount, and a live countdown. When the code expires the query reads
// a fresh one (lib.ts displayRefetchMs); this panel shows that the old code is
// no longer payable instead of silently leaving it on screen.
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { CustomerDisplayQris } from "@starter/shared/pos";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/utils";
import {
  formatCountdown,
  isQrisExpired,
  secondsUntilExpiry,
} from "../lib.ts";
import { DisplayQr } from "./display-qr.tsx";

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
    <section
      aria-labelledby="display-qris"
      className="rounded-xl border-(length:--border-w) bg-card p-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="display-qris" className="text-lg leading-7 font-semibold">
          {t("posDisplay.qris.title")}
        </h2>
        <Badge tone="brand">QRIS</Badge>
      </div>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("posDisplay.qris.hint")}
      </p>
      <div
        className={cn(
          "mx-auto w-full max-w-72 transition-opacity duration-(--duration-base)",
          expired && "opacity-40",
        )}
      >
        <DisplayQr
          payload={qris.payload}
          label={t("posDisplay.qris.alt", { amount })}
        />
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm leading-5 text-muted-foreground">
          {t("posDisplay.qris.amount")}
        </span>
        <Money amount={qris.amountIdr} size="lg" />
      </div>
      <p
        aria-live="polite"
        className={cn(
          "flex items-center gap-2 text-sm leading-5",
          expired ? "font-semibold text-warning" : "text-muted-foreground tabular",
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
    </section>
  );
}
