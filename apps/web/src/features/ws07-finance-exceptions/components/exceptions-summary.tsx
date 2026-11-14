// One block per kind. The amounts are per kind and never added together: a
// tax figure, an order total and a transfer fee mean different things. A card
// is a toggle that filters the list to its kind.
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Money, NumberDisplay } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import {
  FINANCE_EXCEPTION_KINDS,
  KIND_LABEL_KEYS,
  type FinanceExceptionKind,
  type KindSummary,
} from "../lib";

const CARD_GRID =
  "grid gap-3 min-[700px]:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]";

export function SummarySkeleton() {
  const t = useT();
  return (
    <div className={CARD_GRID} aria-busy="true">
      <span className="sr-only">
        {t("financeExceptions.states.loadingTitle")}
      </span>
      {FINANCE_EXCEPTION_KINDS.map((kind) => (
        <Skeleton key={kind} className="h-24 rounded-container" />
      ))}
    </div>
  );
}

function AmountLine({
  entry,
  outletFiltered,
}: {
  entry: KindSummary;
  outletFiltered: boolean;
}) {
  const t = useT();
  const muted = "text-sm text-muted-foreground";
  if (entry.kind === "payout_fee_not_posted" && outletFiltered)
    return (
      <p className={muted}>{t("financeExceptions.summary.notForOutlet")}</p>
    );
  // The server hides the payout kind from outlet-limited users, so zero here
  // does not prove there is none: say who sees it instead of "no events".
  if (entry.count === 0 && entry.kind === "payout_fee_not_posted")
    return (
      <p className={muted}>{t("financeExceptions.summary.payoutScope")}</p>
    );
  if (entry.count === 0)
    return <p className={muted}>{t("financeExceptions.summary.noEvents")}</p>;
  if (entry.unavailable)
    return (
      <p className={muted}>{t("financeExceptions.summary.unavailable")}</p>
    );
  return (
    <p className="flex flex-wrap items-baseline gap-x-1.5">
      <Money amount={entry.amountIdr} className="font-semibold" />
      {entry.partial && (
        <span className="text-xs text-muted-foreground">
          {t("financeExceptions.summary.partial")}
        </span>
      )}
    </p>
  );
}

export function ExceptionsSummary({
  entries,
  activeKind,
  outletFiltered,
  onSelectKind,
}: {
  entries: readonly KindSummary[];
  activeKind: FinanceExceptionKind | undefined;
  outletFiltered: boolean;
  onSelectKind: (kind: FinanceExceptionKind | undefined) => void;
}) {
  const t = useT();
  return (
    // One merged strip: a single border, thin separators from the 1px gap
    // showing the strip's own background through.
    <ul className="grid list-none gap-px overflow-hidden rounded-container border-(length:--border-w) border-border bg-border shadow-hairline min-[700px]:grid-cols-2 lg:grid-cols-5">
      {entries.map((entry) => {
        const active = entry.kind === activeKind;
        const label = t(KIND_LABEL_KEYS[entry.kind]);
        return (
          <li
            key={entry.kind}
            className="min-w-0 bg-card min-[700px]:max-lg:last:col-span-2"
          >
            <button
              type="button"
              aria-pressed={active}
              onClick={() => onSelectKind(active ? undefined : entry.kind)}
              className={cn(
                "grid h-full min-h-11 w-full min-w-0 grid-cols-[1fr_auto] content-start gap-x-3 gap-y-2 border-(length:--border-w) p-card text-left transition-colors duration-(--duration-fast) focus-visible:relative focus-visible:z-10 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
                active
                  ? "border-primary bg-brand-subtle"
                  : "border-transparent hover:bg-surface-2",
                // Label, count and amount start on the same line in every card.
                "min-[700px]:grid-cols-1 min-[700px]:grid-rows-[minmax(2.5rem,auto)_auto_auto]",
              )}
            >
              <span className="min-w-0 text-sm leading-5 font-semibold">
                {label}
              </span>
              <span className="flex items-baseline gap-1.5 max-[699px]:col-start-2 max-[699px]:row-span-2 max-[699px]:row-start-1 max-[699px]:flex-col max-[699px]:items-end max-[699px]:gap-0">
                <NumberDisplay value={entry.count} size="xl" />
                <span className="text-xs text-muted-foreground">
                  {t("financeExceptions.summary.countUnit")}
                </span>
              </span>
              <AmountLine entry={entry} outletFiltered={outletFiltered} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
