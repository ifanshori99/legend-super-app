import { Link } from "@tanstack/react-router";
import { BellRing } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import type { ServiceCall } from "@/features/ws04-pos-order/types";

// The newest unanswered waiter call above the table picker. Amber fill plus the
// bell icon and the word "Panggilan baru": never color alone. The screen wraps
// it in an `aria-live` region that is always present, so a call that arrives
// while the captain is on the screen is announced.
export function CallBanner({
  call,
  zone,
  moreCount,
}: {
  call: ServiceCall;
  /** Zone of the call's table, when known. */
  zone: string | null;
  /** Other calls still new, besides this one. */
  moreCount: number;
}) {
  const t = useT();
  // The reason is what the guest asked for; fall back to the call type.
  const reason = call.reason || t(`posCaptainTables.calls.type.${call.type}`);
  const description = zone
    ? t("posCaptainTables.banner.description", { reason, zone })
    : t("posCaptainTables.banner.descriptionNoZone", { reason });
  return (
    <div
      data-slot="captain-call-banner"
      className="flex items-center justify-between gap-3 rounded-container border-l-[5px] border-warning bg-warning-subtle p-3 text-foreground"
    >
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-base leading-6 font-bold">
          <BellRing className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            {t("posCaptainTables.banner.title", { table: call.tableLabel })}
          </span>
        </p>
        <p className="text-sm leading-5">{description}</p>
        {moreCount > 0 && (
          <p className="text-sm leading-5 font-semibold">
            {t("posCaptainTables.banner.more", { count: moreCount })}
          </p>
        )}
      </div>
      <Button asChild variant="outline" className="shrink-0 px-4">
        <Link to="/pos/captain/panggilan">
          {t("posCaptainTables.banner.view")}
        </Link>
      </Button>
    </div>
  );
}
