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
    <ul
      aria-label={t("posDisplay.linesLabel")}
      className="divide-y divide-border"
    >
      {lines.map((line, index) => (
        <li
          key={`${index}-${line.name}`}
          className="flex items-start gap-3 px-4 py-3"
        >
          <span
            aria-hidden="true"
            className="mt-0.5 inline-flex min-w-10 shrink-0 justify-center rounded-md bg-surface-3 px-2 py-0.5 text-sm leading-5 font-semibold tabular"
          >
            {t("posDisplay.quantityTimes", { count: line.quantity })}
          </span>
          <div className="min-w-0 flex-1">
            {/* The wall display is read from a step back, so item names take
                the 21px title step, not body size. */}
            <p className="type-title break-words">{line.name}</p>
            {line.note && (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("posDisplay.note", { note: line.note })}
              </p>
            )}
          </div>
          <Money amount={line.lineTotalIdr} size="lg" />
        </li>
      ))}
    </ul>
  );
}
