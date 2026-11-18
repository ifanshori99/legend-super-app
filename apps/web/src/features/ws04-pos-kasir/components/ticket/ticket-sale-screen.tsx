import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useSellTicketAtPos, useTicketSaleConnected } from "../../ticket/hooks";
import type {
  TicketCustomer,
  TicketProduct,
  TicketTiming,
} from "../../ticket/types";
import { PosPageHeading, PosTwoPane } from "../shared";
import { CustomerPicker } from "./customer-picker";
import { ProductPicker } from "./product-picker";
import { SaleSummary } from "./sale-summary";
import { TimingPicker } from "./timing-picker";

const NOW: TicketTiming = { kind: "now" };

// /pos/tiket — sell a facility ticket from the counter: pick the product and
// the customer, choose area and time, sell, then pay the bill it opens. The
// ticket is issued from /pos/tiket?order&tiket once the bill is paid. The price
// is the product's price from the server; the screen only shows it.
export function TicketSaleScreen() {
  const t = useT();
  const sell = useSellTicketAtPos();
  const navigate = useNavigate();
  const connected = useTicketSaleConnected();
  const [product, setProduct] = useState<TicketProduct | null>(null);
  const [customer, setCustomer] = useState<TicketCustomer | null>(null);
  const [areaId, setAreaId] = useState("");
  const [timing, setTiming] = useState<TicketTiming>(NOW);

  const area = product?.areas.find((item) => item.id === areaId) ?? null;
  const timingReady = timing.kind === "now" || timing.startsAt !== "";
  const canSell =
    product !== null && customer !== null && area !== null && timingReady;

  const pickProduct = (next: TicketProduct) => {
    setProduct(next);
    setAreaId(next.areas[0]?.id ?? "");
    setTiming(NOW);
    sell.reset();
  };

  const runSell = () => {
    if (
      !connected ||
      sell.isPending ||
      !product ||
      !customer ||
      !area ||
      !timingReady
    )
      return;
    sell.mutate(
      { product, areaId: area.id, customer, timing },
      {
        onSuccess: (sale) =>
          void navigate({
            to: "/pos/bayar/$orderId",
            params: { orderId: sale.orderId },
          }),
      },
    );
  };

  return (
    <div data-slot="ticket-sale-screen" className="grid gap-4">
      <PosPageHeading
        title={t("posKasirTicket.title")}
        subtitle={t("posKasirTicket.subtitle")}
        action={
          <Button asChild variant="outline">
            <Link to="/pos/kasir">
              <ArrowLeft aria-hidden="true" />
              {t("posKasirTicket.back")}
            </Link>
          </Button>
        }
      />
      <PosTwoPane
        sidePosition="end"
        side={
          <SaleSummary
            product={product}
            customer={customer}
            areaName={area?.name ?? null}
            timing={timing}
            canSell={canSell}
            connected={connected}
            selling={sell.isPending}
            error={sell.error}
            onSell={runSell}
          />
        }
      >
        <div className="grid gap-4">
          <ProductPicker
            selectedId={product?.id ?? null}
            disabled={sell.isPending}
            onSelect={pickProduct}
          />
          <CustomerPicker
            selected={customer}
            disabled={sell.isPending}
            onSelect={(next) => {
              setCustomer(next);
              sell.reset();
            }}
            onClear={() => setCustomer(null)}
          />
          <TimingPicker
            product={product}
            areaId={areaId}
            timing={timing}
            disabled={sell.isPending}
            onArea={(next) => {
              setAreaId(next);
              setTiming(NOW);
              sell.reset();
            }}
            onTiming={(next) => {
              setTiming(next);
              sell.reset();
            }}
          />
        </div>
      </PosTwoPane>
    </div>
  );
}
