// Event pre-order packages catalogue (PRD §3.22 "Pre-order Event"): what the
// host can attach to a group reservation. Prices are per person and exclude
// tax and service charge (owner decision, 1 Nov 2026).
import { Users } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { usePackages } from "../hooks";

export function PackagesTab({ outletId }: { outletId: string }) {
  const t = useT();
  const packages = usePackages(outletId);

  if (packages.isPending)
    return (
      <div aria-busy="true" className="grid gap-2">
        <span className="sr-only" role="status">
          {t("reservation.packages.loading")}
        </span>
        {Array.from({ length: 2 }, (_, index) => (
          <Skeleton key={index} className="h-32 w-full rounded-xl" />
        ))}
      </div>
    );

  if (packages.error)
    return (
      <ErrorState
        title={t("reservation.packages.errorTitle")}
        description={t("reservation.packages.errorHint")}
        onRetry={() => void packages.refetch()}
      />
    );

  if (packages.data.length === 0)
    return (
      <EmptyState
        title={t("reservation.packages.emptyTitle")}
        description={t("reservation.packages.emptyHint")}
      />
    );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <div className="grid gap-1">
        <h2 className="text-base font-semibold">{t("reservation.packages.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("reservation.packages.subtitle")}
        </p>
      </div>
      <ul className="grid list-none gap-2 p-0 md:grid-cols-2">
        {packages.data.map((pack) => (
          <li
            key={pack.id}
            data-package-id={pack.id}
            className="grid gap-2 rounded-xl border-(length:--border-w) bg-card p-card"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h3 className="text-base font-semibold">{pack.name}</h3>
              <Badge tone={pack.status === "active" ? "success" : "neutral"}>
                {pack.status === "active"
                  ? t("reservation.packages.active")
                  : t("reservation.packages.inactive")}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{pack.description}</p>
            <p className="flex items-baseline gap-1">
              <Money
                amount={pack.pricePerPaxIdr}
                size="lg"
                className="tabular"
              />
              <span className="text-sm text-muted-foreground">
                {t("reservation.packages.perPax")}
              </span>
            </p>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground tabular">
              <span className="flex items-center gap-1">
                <Users className="size-4" aria-hidden="true" />
                {t("reservation.packages.paxRange", {
                  min: pack.minPax,
                  max: pack.maxPax,
                })}
              </span>
              <span>
                {t("reservation.packages.leadTime", {
                  hours: pack.leadTimeHours,
                })}
              </span>
              <span>
                {t("reservation.packages.items", { count: pack.items.length })}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
