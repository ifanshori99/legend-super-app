// The order lines of the customer display (PRD §3 F11 "Customer Display":
// items, quantity, note and line total; money always through <Money>).
import type { CustomerDisplayLine } from "@starter/shared/pos";
import { useT } from "@/components/i18n";
import { Money } from "@/components/ui/money";

export function BillLines({ lines }: { lines: CustomerDisplayLine[] }) {
  const t = useT();
  if (lines.length === 0)
    return (
      <p className="px-4 py-6 text-sm leading-5 text-muted-foreground">
        {t("posDisplay.emptyLines")}
      </p>
    );
  return (
    <ul aria-label={t("posDisplay.linesLabel")} className="divide-y divide-border">
      {lines.map((line, index) => (
        <li
          key={`${index}-${line.name}`}
          className="flex items-start gap-3 px-4 py-3"
        >
          <span
            aria-hidden="true"
            className="mt-0.5 inline-flex min-w-9 shrink-0 justify-center rounded-md bg-muted px-2 py-0.5 text-sm leading-5 font-semibold tabular"
          >
            {t("posDisplay.quantityTimes", { count: line.quantity })}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-(length:--density-text) leading-7 font-semibold break-words">
              {line.name}
            </p>
            {line.note && (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("posDisplay.note", { note: line.note })}
              </p>
            )}
          </div>
          <Money amount={line.lineTotalIdr} className="font-semibold" />
        </li>
      ))}
    </ul>
  );
}
