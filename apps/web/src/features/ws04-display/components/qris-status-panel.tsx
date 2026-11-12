// The QRIS panel when there is no payable code (PRD §3 F13 "QRIS Dinamis"):
// the code is still loading, could not be shown, or has expired. In every one
// of these the old code is removed from the screen, never dimmed, and the
// customer is told to wait for the cashier, who checks the payment status
// before a new code is prepared. The amount shown is the one the terminal sent.
import { CircleX, Clock, Loader2, TriangleAlert } from "lucide-react";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";

export type QrisStatusKind = "loading" | "error" | "expired";

const KIND: Record<
  QrisStatusKind,
  {
    tone: "neutral" | "danger" | "warning";
    badge: MessageKey;
    title: MessageKey;
    hint: MessageKey;
    notice: MessageKey | null;
  }
> = {
  loading: {
    tone: "neutral",
    badge: "posDisplay.qris.loadingBadge",
    title: "posDisplay.qris.loadingTitle",
    hint: "posDisplay.qris.loadingHint",
    notice: null,
  },
  error: {
    tone: "danger",
    badge: "posDisplay.qris.errorBadge",
    title: "posDisplay.qris.errorTitle",
    hint: "posDisplay.qris.errorHint",
    notice: "posDisplay.qris.errorNotice",
  },
  expired: {
    tone: "warning",
    badge: "posDisplay.qris.expiredBadge",
    title: "posDisplay.qris.expiredTitle",
    hint: "posDisplay.qris.expiredHint",
    notice: "posDisplay.qris.expiredNotice",
  },
};

export function QrisStatusPanel({
  kind,
  amountIdr,
}: {
  kind: QrisStatusKind;
  /** What the terminal says is left to pay; null when it is not known. */
  amountIdr: number | null;
}) {
  const t = useT();
  const { tone, badge, title, hint, notice } = KIND[kind];
  const Icon =
    kind === "loading" ? Clock : kind === "error" ? CircleX : TriangleAlert;
  return (
    <Card
      // Announce the change of state once, politely.
      role="status"
      aria-live="polite"
      aria-busy={kind === "loading"}
    >
      <div className="grid justify-items-center gap-3 text-center">
        <Badge tone={tone} className="px-3 py-1 text-sm [&_svg]:size-4">
          <Icon aria-hidden="true" />
          {t(badge)}
        </Badge>
        <h2 className="type-title">{t(title)}</h2>
        <p className="max-w-md text-(length:--density-text) leading-7 text-muted-foreground">
          {t(hint)}
        </p>
        {kind === "loading" && (
          <div
            role="img"
            aria-label={t("posDisplay.qris.loadingAlt")}
            className="grid size-52 place-items-center rounded-container border-(length:--border-w) border-dashed border-border bg-surface-2 text-sm font-semibold text-muted-foreground motion-safe:animate-pulse sm:size-56"
          >
            <span className="flex items-center gap-2">
              <Loader2
                className="size-4 motion-safe:animate-spin"
                aria-hidden="true"
              />
              {t("posDisplay.qris.loadingBox")}
            </span>
          </div>
        )}
        {notice !== null && (
          <div className="w-full max-w-md rounded-container border-l-4 border-warning bg-warning-subtle p-3 text-left">
            <p className="font-semibold">{t("posDisplay.qris.unknownTitle")}</p>
            <p className="text-sm leading-5 text-foreground">{t(notice)}</p>
          </div>
        )}
        {amountIdr !== null && (
          <Money amount={amountIdr} size="lg" className="font-semibold" />
        )}
      </div>
    </Card>
  );
}
