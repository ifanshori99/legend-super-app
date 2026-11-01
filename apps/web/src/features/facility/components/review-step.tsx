// Step 4: review and pay (PRD §3 F22, alur S langkah 4: "Pelanggan membayar
// dengan QRIS; setelah webhook terverifikasi diterima, sistem menerbitkan
// tiket akses"). The payment intent itself is WS-05 (Payment & EDC); this
// screen posts the booking once the mock provider settles, and the
// integration bead swaps the fake settle for the real intent state machine.
import { CreditCard } from "lucide-react";
import type { FacilityAddon, FacilityProduct } from "@starter/shared/facility";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
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

  return (
    <div className="grid gap-5">
      <h2 className="text-xl leading-7 font-semibold">
        {t("facility.review.title")}
      </h2>

      <dl className="grid gap-2 rounded-xl border-(length:--border-w) bg-card p-card text-sm leading-5">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{t("facility.review.area")}</dt>
          <dd className="font-medium">{areaName}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">
            {t("facility.review.timing")}
          </dt>
          <dd className="font-medium tabular">{timing}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">
            {t("facility.review.product")}
          </dt>
          <dd className="font-medium">{product.name}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">
            {t("facility.review.addons")}
          </dt>
          <dd className="text-right font-medium">
            {addons.length > 0
              ? addons.map((addon) => addon.name).join(", ")
              : t("facility.review.noAddons")}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">
            {redeeming
              ? t("facility.review.sourceSubscription")
              : t("facility.review.sourcePurchase")}
          </dt>
          <dd className="font-medium">
            {redeeming ? t("facility.review.redeemTotal") : "QRIS"}
          </dd>
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-3 border-t pt-2">
          <dt className="font-semibold">{t("facility.review.total")}</dt>
          <dd>
            <Money amount={payableIdr} size="lg" />
          </dd>
        </div>
        <p className="text-muted-foreground">{t("facility.extras.taxNote")}</p>
      </dl>

      {error !== null && <ApiFailure error={error} />}

      {redeeming ? (
        <Button size="lg" onClick={onPay} loading={pending}>
          {t("facility.review.issueTicket")}
        </Button>
      ) : (
        <div className="grid gap-2">
          <Button size="lg" onClick={onPay} loading={pending}>
            <CreditCard aria-hidden="true" />
            {pending ? t("facility.review.paying") : t("facility.review.pay")}
          </Button>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("facility.extras.payHint")}
          </p>
          {API_MOCK && (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("facility.review.mockPayNote")}
            </p>
          )}
        </div>
      )}

      <Button variant="outline" onClick={onBack} disabled={pending}>
        {t("facility.review.change")}
      </Button>
    </div>
  );
}
