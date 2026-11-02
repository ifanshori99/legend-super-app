import {
  Clock,
  Gift,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { formatNumber } from "@starter/shared/i18n";
import type { PointLedgerEntry } from "@starter/shared/crm";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { formatMemberDate } from "../format";

const ICONS: Record<PointLedgerEntry["type"], LucideIcon> = {
  earn: Plus,
  bonus: Sparkles,
  redeem: Gift,
  expire: Clock,
  reverse: RotateCcw,
  adjust: SlidersHorizontal,
};

// Append-only point ledger (PRD §3.20 "Poin", LOY-01). Each row shows the
// signed change, its date, and the expiry of points it granted; the balance
// itself always comes from the server.
export function LedgerList({
  entries,
}: {
  entries: readonly PointLedgerEntry[];
}) {
  const t = useT();
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-container border-(length:--border-w) bg-card shadow-hairline">
      {entries.map((entry) => {
        const Icon = ICONS[entry.type];
        const positive = entry.points > 0;
        return (
          <li
            key={entry.id}
            className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-2"
          >
            <span className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-container bg-surface-3 text-muted-foreground">
              <Icon className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-(length:--density-text) leading-6 font-medium">
                {t(`member.points.entry.${entry.type}`)}
              </p>
              <p className="text-sm leading-5 text-muted-foreground">
                {formatMemberDate(entry.createdAt)}
                {entry.expiresAt && (
                  <>
                    {" · "}
                    {t("member.points.expiresOn", {
                      date: formatMemberDate(entry.expiresAt),
                    })}
                  </>
                )}
              </p>
            </div>
            <p
              className={cn(
                "tabular type-heading shrink-0",
                positive ? "text-success" : "text-foreground",
              )}
            >
              {positive ? "+" : ""}
              {formatNumber(entry.points)}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
