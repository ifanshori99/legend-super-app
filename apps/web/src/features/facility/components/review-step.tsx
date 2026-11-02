// Step 4: review and pay (PRD §3 F22, alur S langkah 4: "Pelanggan membayar
// dengan QRIS; setelah webhook terverifikasi diterima, sistem menerbitkan
// tiket akses"). The payment intent itself is WS-05 (Payment & EDC); this
// screen posts the booking once the mock provider settles, and the
// integration bead swaps the fake settle for the real intent state machine.
import { CreditCard } from "lucide-react";
import type { FacilityAddon, FacilityProduct } from "@starter/shared/facility";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { API_MOCK } from "@/lib/api/mock-flag.ts";
import { formatClock } from "../flow";
import type { BookingDraft } from "../flow";
import { ApiFailure } from "./shared";

export function ReviewStep({
  draft,
  areaName,
  product,
  addons,
  payableIdr,
  onBack,
  onPay,
  pending,
  error,
}: {
  draft: BookingDraft;
  areaName: string;
  product: FacilityProduct;
  addons: readonly FacilityAddon[];
  payableIdr: number;
  onBack: () => void;
  onPay: () => void;
  pending: boolean;
  error: unknown;
}) {
  const t = useT();
  const timing =
    draft.timing?.kind === "now"
      ? t("facility.schedule.now")
      : draft.timing?.kind === "slot"
        ? formatClock(draft.timing.startsAt)
        : "—";
  const redeeming = draft.source === "subscription";
  // A quota session still pays for its add-ons (PRD §3 F22 "Add-on
  // Opsional"): only a zero total skips the QRIS payment.
  const needsPayment = payableIdr > 0;

  return (
    <div className="grid gap-5">
      <h2 className="font-brand type-title">{t("facility.review.title")}</h2>

      <Card>
        <dl className="grid gap-3 text-sm leading-5">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">
              {t("facility.review.area")}
            </dt>
            <dd className="text-right font-medium">{areaName}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">
              {t("facility.review.timing")}
            </dt>
            <dd className="text-right font-medium tabular">{timing}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">
              {t("facility.review.product")}
            </dt>
            <dd className="text-right font-medium">{product.name}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-muted-foreground">
              {t("facility.review.addons")}
            </dt>
            <dd className="min-w-0 text-right font-medium">
              {addons.length > 0
                ? addons.map((addon) => addon.name).join(", ")
                : t("facility.review.noAddons")}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">
              {redeeming
                ? t("facility.review.sourceSubscription")
                : t("facility.review.sourcePurchase")}
            </dt>
            <dd className="text-right font-medium">
              {redeeming ? t("facility.review.redeemTotal") : "QRIS"}
            </dd>
          </div>
          <div className="grid gap-1 border-t pt-3">
            <dt className="type-eyebrow text-muted-foreground">
              {t("facility.review.total")}
            </dt>
            <dd>
              <Money amount={payableIdr} size="stat" />
            </dd>
          </div>
        </dl>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("facility.extras.taxNote")}
        </p>
      </Card>

      {error !== null && <ApiFailure error={error} />}

      <div className="grid gap-2">
        <Button size="lg" onClick={onPay} loading={pending}>
          {needsPayment && <CreditCard aria-hidden="true" />}
          {needsPayment
            ? pending
              ? t("facility.review.paying")
              : t("facility.review.pay")
            : t("facility.review.issueTicket")}
        </Button>
        {needsPayment && (
          <>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("facility.extras.payHint")}
            </p>
            {API_MOCK && (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("facility.review.mockPayNote")}
              </p>
            )}
          </>
        )}
      </div>

      <Button variant="outline" onClick={onBack} disabled={pending}>
        {t("facility.review.change")}
      </Button>
    </div>
  );
}
