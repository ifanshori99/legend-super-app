import { Badge } from "@/components/ui/badge";
import { useT } from "@/components/i18n";
import { API_MOCK } from "@/lib/api/mock-flag";
import type { Translate } from "@starter/shared/i18n";
import type { CaptainTable, CartLine } from "@/features/ws04-pos-order/types";

/** One unit: base price plus every chosen modifier (whole rupiah). */
export function lineTotalIdr(
  line: Pick<CartLine, "unitPriceIdr" | "quantity" | "modifiers">,
): number {
  const unit = line.modifiers.reduce(
    (sum, modifier) => sum + modifier.priceDeltaIdr,
    line.unitPriceIdr,
  );
  return unit * line.quantity;
}

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
