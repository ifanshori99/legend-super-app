// The promotion slide of the pickup display (PRD §3 F12 "... dengan promosi").
// Display-safe copy only: the feed carries a title, a body and an end date, not
// the campaign's codes, quotas or budget.
import type { PickupPromotion } from "@starter/shared/kitchen";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { formatOutletDate } from "../format.ts";

export function PickupPromoCard({ promotion }: { promotion: PickupPromotion }) {
  const t = useT();
  return (
    <aside
      data-slot="pickup-promo"
      aria-label={t("pickup.promoLabel")}
      className="flex flex-col gap-2 rounded-container border-(length:--border-w) bg-brand-subtle p-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="brand">{t("pickup.promoLabel")}</Badge>
        {promotion.validUntil !== null && (
          <span className="text-sm leading-5 text-muted-foreground tabular">
            {t("pickup.promoUntil", {
              date: formatOutletDate(promotion.validUntil),
            })}
          </span>
        )}
      </div>
      <p className="type-title">{promotion.title}</p>
      <p className="text-sm leading-5 text-muted-foreground">
        {promotion.body}
      </p>
    </aside>
  );
}
