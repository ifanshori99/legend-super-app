import { Receipt } from "lucide-react";
import { formatNumber } from "@starter/shared/i18n";
import type { CustomerVisit } from "@starter/shared/crm";
import { useT } from "@/components/i18n";
import { Money } from "@/components/ui/money";
import { formatMemberDate } from "../format";

// Visit history (PRD §3.20 "Halaman Member": riwayat kunjungan). Visits are
// the paid orders linked to the member; the outlet name is staff-side data,
// so the member sees the date, spend and item count.
export function VisitList({ visits }: { visits: readonly CustomerVisit[] }) {
  const t = useT();
  return (
    <ul className="divide-y divide-border rounded-xl border-(length:--border-w) bg-card">
      {visits.map((visit) => (
        <li key={visit.orderId} className="flex items-start gap-3 p-card">
          <span className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
            <Receipt className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-(length:--density-text) leading-6 font-medium">
              {formatMemberDate(visit.visitedAt)}
            </p>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("member.visits.items", {
                count: formatNumber(visit.itemCount),
              })}
            </p>
          </div>
          <p className="shrink-0 text-base leading-6 font-semibold">
            <Money amount={visit.spendIdr} />
          </p>
        </li>
      ))}
    </ul>
  );
}
