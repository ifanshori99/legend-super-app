import { Badge } from "@/components/ui/badge";
import { useT } from "@/components/i18n";
import { API_MOCK } from "@/lib/api/mock-flag";
import type { Translate } from "@starter/shared/i18n";
import type { CaptainTable, CartLine } from "@/features/ws04-pos-order/types";

/**
 * The cart while its order is being sent or its answer is unknown: same lines,
 * every change does nothing, so nothing can change under the keyed send.
 */
export function lockDraft<
  T extends {
    lines: CartLine[];
    add: unknown;
    setQuantity: unknown;
    remove: unknown;
    toggleHold: unknown;
    clear: unknown;
    replace: unknown;
  },
>(draft: T, locked: boolean): T {
  if (!locked) return draft;
  const noop = () => undefined;
  return {
    ...draft,
    add: noop,
    setQuantity: noop,
    remove: noop,
    toggleHold: noop,
    clear: noop,
    replace: noop,
  };
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
