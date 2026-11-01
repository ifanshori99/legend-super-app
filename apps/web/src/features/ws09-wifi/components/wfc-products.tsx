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
import type { SubscriptionPlan } from "@starter/shared/facility";
import { useWfcPlans } from "../hooks";

function ProductRow({ name, hint }: { name: string; hint: string }) {
  return (
    <li className="grid gap-1 p-4">
      <p className="text-sm leading-5 font-semibold">{name}</p>
      <p className="text-sm leading-5 text-muted-foreground">{hint}</p>
    </li>
  );
}

function PlanRow({ plan }: { plan: SubscriptionPlan }) {
  const t = useT();
  return (
    <li className="flex items-start justify-between gap-4 p-4">
      <div className="grid min-w-0 gap-1">
        <p className="text-sm leading-5 font-semibold">{plan.name}</p>
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
      <Money amount={plan.priceIdr} size="sm" className="font-semibold" />
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
    <section aria-labelledby="wfc-title" className="mt-6 grid gap-3">
      <div>
        <h2 id="wfc-title" className="text-lg leading-7 font-semibold">
          {t("wifi.wfcTitle")}
        </h2>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          {t("wifi.wfcHint")}
        </p>
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border-(length:--border-w) bg-card">
        <ProductRow
          name={t("wifi.wfcDayPass")}
          hint={t("wifi.wfcDayPassHint")}
        />
        <ProductRow name={t("wifi.wfcSeat")} hint={t("wifi.wfcSeatHint")} />
        {plans.isPending && facilityId && (
          <li className="grid gap-2 p-4" aria-busy="true">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-4 w-24" />
          </li>
        )}
        {plans.isError && (
          <li className="flex flex-wrap items-center gap-2 p-4" role="alert">
            <p className="text-sm leading-5 text-danger">
              {t("state.errorHint")}
            </p>
            <Button variant="ghost" size="sm" onClick={() => plans.refetch()}>
              {t("common.retry")}
            </Button>
          </li>
        )}
        {plans.data?.length === 0 && (
          <li className="p-4 text-sm leading-5 text-muted-foreground">
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
