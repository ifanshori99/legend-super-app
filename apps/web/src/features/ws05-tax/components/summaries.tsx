// One-line summaries of what a tax rule covers. The contract stores ids and
// enum values; the screens show catalog text and counts (the category/item
// names arrive with the picker follow-up bead).
import { useT } from "@/components/i18n";
import type { TaxAppliesTo, TaxChannel } from "@starter/shared/tax";
import { CHANNEL_KEYS, ITEM_CLASS_KEYS } from "../labels";
import { appliesToCounts } from "../lib";

export function AppliesToSummary({ appliesTo }: { appliesTo: TaxAppliesTo }) {
  const t = useT();
  const counts = appliesToCounts(appliesTo);
  const parts = counts.itemClasses.map((itemClass) =>
    t(ITEM_CLASS_KEYS[itemClass]),
  );
  if (counts.categoryCount > 0)
    parts.push(t("tax.appliesTo.categories", { count: counts.categoryCount }));
  if (counts.itemCount > 0)
    parts.push(t("tax.appliesTo.items", { count: counts.itemCount }));
  return <>{parts.join(" · ")}</>;
}

export function ChannelsSummary({
  channels,
}: {
  channels: readonly TaxChannel[];
}) {
  const t = useT();
  if (channels.length === 0) return <>{t("tax.channels.all")}</>;
  return <>{channels.map((channel) => t(CHANNEL_KEYS[channel])).join(", ")}</>;
}

export function ZoneSummary({
  zoneId,
  zoneName,
}: {
  zoneId: string | null;
  zoneName: string | undefined;
}) {
  const t = useT();
  if (zoneId === null) return <>{t("tax.serviceCharge.allZones")}</>;
  return <>{zoneName ?? t("tax.serviceCharge.zoneUnknown")}</>;
}
