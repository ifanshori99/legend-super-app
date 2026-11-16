import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { formatClock } from "../../../facility/flow";
import type {
  TicketCustomer,
  TicketProduct,
  TicketTiming,
} from "../../ticket/types";
import { Notice, PosPanel } from "../shared";
import { TicketError } from "./ticket-error";

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-(length:--density-text)">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-semibold">{children}</dd>
    </div>
  );
}

// The sale card: what will be sold, the product's price and the sell button.
// The button is locked while the request runs, so a double tap sells once.
export function SaleSummary({
  product,
  customer,
  areaName,
  timing,
  canSell,
  connected,
  selling,
  error,
  onSell,
}: {
  product: TicketProduct | null;
  customer: TicketCustomer | null;
  areaName: string | null;
  timing: TicketTiming;
  canSell: boolean;
  /** False when the server has no payment contract for the sale. */
  connected: boolean;
  selling: boolean;
  error: unknown;
  onSell: () => void;
}) {
  const t = useT();
  const none = t("posKasirTicket.summary.none");
  const when =
    timing.kind === "now"
      ? t("posKasirTicket.summary.now")
      : timing.startsAt === ""
        ? none
        : t("posKasirTicket.summary.slot", {
            from: formatClock(timing.startsAt),
            until: formatClock(timing.endsAt),
          });

  return (
    <PosPanel
      title={t("posKasirTicket.summary.title")}
      footer={
        <Button
          type="button"
          size="lg"
          className="w-full"
          disabled={!connected || !canSell || selling}
          aria-busy={selling}
          onClick={() => {
            if (selling || !canSell || !connected) return;
            onSell();
          }}
        >
          {selling
            ? t("posKasirTicket.summary.selling")
            : t("posKasirTicket.summary.sell")}
        </Button>
      }
    >
      <div className="grid gap-4">
        <dl className="grid gap-2">
          <Row label={t("posKasirTicket.summary.product")}>
            {product?.name ?? none}
          </Row>
          <Row label={t("posKasirTicket.summary.customer")}>
            {customer?.name ?? none}
          </Row>
          <Row label={t("posKasirTicket.summary.area")}>{areaName ?? none}</Row>
          <Row label={t("posKasirTicket.summary.when")}>{when}</Row>
          <hr className="my-1 border-border" />
          <Row label={t("posKasirTicket.summary.price")}>
            {product ? <Money amount={product.priceIdr} size="lg" /> : none}
          </Row>
        </dl>
        <p className="text-sm text-muted-foreground">
          {canSell
            ? t("posKasirTicket.summary.priceHint")
            : t("posKasirTicket.summary.incomplete")}
        </p>
        {!connected ? (
          <Notice
            tone="warning"
            title={t("posKasirTicket.summary.pendingTitle")}
          >
            {t("posKasirTicket.summary.pendingHint")}
          </Notice>
        ) : null}
        {error ? (
          <TicketError
            error={error}
            title={t("posKasirTicket.summary.saleErrorTitle")}
            hint={t("posKasirTicket.summary.saleErrorHint")}
          />
        ) : null}
      </div>
    </PosPanel>
  );
}
