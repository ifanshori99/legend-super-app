// WFC products sold at the venue (PRD §3 "Produk WFC", §4 Alur X step 6): a
// day pass, a seat reservation per slot and the monthly subscription. They use
// the same facility, slot and subscription model as the shower rooms, so every
// purchase happens on the facility's own booking screen; the portal only shows
// what is on offer and the monthly plan's real price from the contract.
import { Link } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { type PublicSubscriptionPlan } from "@starter/shared/facility";
import { useWfcPlans } from "../hooks";

function ProductRow({ name, hint }: { name: string; hint: string }) {
  return (
    <li className="grid gap-0.5 px-4 py-3">
      <p className="type-heading">{name}</p>
      <p className="text-sm leading-5 text-muted-foreground">{hint}</p>
    </li>
  );
}

function PlanRow({ plan }: { plan: PublicSubscriptionPlan }) {
  const t = useT();
  return (
    <li className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="grid min-w-0 gap-0.5">
        <p className="type-heading">{plan.name}</p>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("wifi.wfcPlanAmount", {
            sessions: plan.quotaPerPeriod,
            interval:
              plan.interval === "month"
                ? t("wifi.intervalMonth")
                : t("wifi.intervalYear"),
          })}
        </p>
      </div>
      <Money amount={plan.priceIdr} className="font-semibold" />
    </li>
  );
}

export function WfcProducts({
  facilityId,
}: {
  facilityId: string | undefined;
}) {
  const t = useT();
  const plans = useWfcPlans(facilityId);
  return (
    <section aria-labelledby="wfc-title" className="grid gap-3">
      <div className="grid gap-1">
        <h2 id="wfc-title" className="font-brand type-title">
          {t("wifi.wfcTitle")}
        </h2>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("wifi.wfcHint")}
        </p>
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-container border-(length:--border-w) bg-card shadow-hairline">
        <ProductRow
          name={t("wifi.wfcDayPass")}
          hint={t("wifi.wfcDayPassHint")}
        />
        <ProductRow name={t("wifi.wfcSeat")} hint={t("wifi.wfcSeatHint")} />
        {plans.isPending && facilityId && (
          <li className="grid gap-2 px-4 py-3" aria-busy="true">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-4 w-24" />
          </li>
        )}
        {plans.isError && (
          <li
            className="flex flex-wrap items-center gap-2 px-4 py-3"
            role="alert"
          >
            <p className="text-sm leading-5 text-danger">
              {t("state.errorHint")}
            </p>
            <Button variant="ghost" size="sm" onClick={() => plans.refetch()}>
              {t("common.retry")}
            </Button>
          </li>
        )}
        {plans.data?.length === 0 && (
          <li className="px-4 py-3 text-sm leading-5 text-muted-foreground">
            {t("wifi.wfcPlanEmpty")}
          </li>
        )}
        {plans.data?.map((plan) => (
          <PlanRow key={plan.id} plan={plan} />
        ))}
      </ul>
      {facilityId ? (
        <Button variant="outline" asChild>
          <Link to="/f/$facility" params={{ facility: facilityId }}>
            {t("wifi.wfcCta")}
          </Link>
        </Button>
      ) : (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("wifi.wfcNoFacility")}
        </p>
      )}
    </section>
  );
}
