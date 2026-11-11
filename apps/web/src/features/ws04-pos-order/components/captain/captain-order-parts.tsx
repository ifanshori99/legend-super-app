import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/components/i18n";
import { API_MOCK } from "@/lib/api/mock-flag";
import type { Translate } from "@starter/shared/i18n";
import type { CaptainTable, CartLine } from "@/features/ws04-pos-order/types";

/** Chosen modifier names, then the note, as short detail parts. */
export function lineDetails(
  line: Pick<CartLine, "modifiers" | "note">,
): string[] {
  const parts = line.modifiers.map((modifier) => modifier.name);
  const note = line.note.trim();
  return note ? [...parts, note] : parts;
}

/** Header meta line: QR session and guests, or an empty table. */
export function tableSessionText(t: Translate, table: CaptainTable): string {
  if (table.status === "empty")
    return t("posCaptainOrder.table.sessionEmpty", { seats: table.seats });
  return table.qrSessionActive
    ? t("posCaptainOrder.table.sessionActive", { count: table.guestCount })
    : t("posCaptainOrder.table.sessionOccupied", { count: table.guestCount });
}

/** "14.10" in the device's clock, for "catalog last updated". */
export function formatClock(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** "Contoh data" marker while the screens run on mock data. */
export function SampleBadge() {
  const t = useT();
  if (!API_MOCK) return null;
  return (
    <Badge tone="neutral" className="rounded-full px-3 text-sm">
      {t("posCaptainOrder.sample")}
    </Badge>
  );
}

/**
 * What the screen is for, under the header. The header already holds the only
 * `<h1>`, so the optional title here is an `<h2>`.
 */
export function CaptainIntro({
  title,
  subtitle,
  action,
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  if (!title && !subtitle && !action) return null;
  return (
    <div
      data-slot="captain-intro"
      className="flex flex-wrap items-start justify-between gap-3"
    >
      <div className="min-w-0">
        {title && <h2 className="type-title">{title}</h2>}
        {subtitle && (
          <p className="text-(length:--density-text) text-muted-foreground">
            {subtitle}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
