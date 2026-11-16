// Dynamic QRIS panel (PRD §3 F11 "Pembayaran" and §3 F13 "QRIS Dinamis"): the
// code, the amount, and a live countdown. When the code expires the query reads
// a fresh one (lib.ts displayRefetchMs); this panel shows that the old code is
// no longer payable instead of silently leaving it on screen.
import { Clock } from "lucide-react";
import type { CustomerDisplayQris } from "@starter/shared/pos";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { QrCode } from "@/components/ui/qr-code";
import { useNowMs } from "../use-now.ts";
import { formatCountdown, isQrisExpired, secondsUntilExpiry } from "../lib.ts";
import { QrisStatusPanel } from "./qris-status-panel.tsx";

export function QrisPanel({ qris }: { qris: CustomerDisplayQris }) {
  const t = useT();
  const now = useNowMs();
  // An expired code is removed, not dimmed: a faded QR still scans (PRD §3
  // F13, the customer must never pay a dead code). The query reads a fresh
  // one at expiry; until the cashier has checked the status, this panel stays.
  if (isQrisExpired(qris, now))
    return <QrisStatusPanel kind="expired" amountIdr={qris.amountIdr} />;
  const remaining = secondsUntilExpiry(qris.expiresAt, now);
  const amount = formatRupiah(qris.amountIdr);

  return (
    <Card>
      <div className="grid justify-items-center gap-3 text-center">
        <Badge tone="warning" className="px-3 py-1 text-sm [&_svg]:size-4">
          <Clock aria-hidden="true" />
          {t("posDisplay.state.awaitingPayment")}
        </Badge>
        <h2 className="type-title">{t("posDisplay.qris.payTitle")}</h2>
        <p className="max-w-md text-(length:--density-text) leading-7 text-muted-foreground">
          {t("posDisplay.qris.payHint")}
        </p>
        <QrCode
          value={qris.payload}
          label={t("posDisplay.qris.alt", { amount })}
          size={288}
          svgClassName="size-52 sm:size-56 2xl:size-72"
          className="rounded-container border-(length:--border-w) border-border p-3"
        />
        <Money amount={qris.amountIdr} size="lg" className="font-semibold" />
        <Badge tone="neutral" className="px-3 py-1 text-sm [&_svg]:size-4">
          <Clock aria-hidden="true" />
          {t("posDisplay.qris.countdown", {
            time: formatCountdown(remaining),
          })}
        </Badge>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("posDisplay.qris.providerLabel", {
            provider: t(`posDisplay.qris.provider.${qris.provider}`),
          })}
        </p>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("posDisplay.qris.wait")}
        </p>
      </div>
    </Card>
  );
}
