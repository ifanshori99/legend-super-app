import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { RotateCw } from "lucide-react";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/errors";
import { StateBlock } from "../../ws04-pos-kasir/components/shared";
import { useCorrectionOrder } from "../hooks";
import { CORRECTION_MODES, type CorrectionMode } from "../modes";
import { DiscountForm } from "./discount-form";
import { BackButton, CorrectionLayout } from "./parts";
import { ReceiptPreview } from "./receipt-preview";
import { RefundForm } from "./refund-form";
import { VoidForm } from "./void-form";

type Props = {
  orderId: string;
  /** From `?mode=`; without one a paid order opens on refund, others on discount. */
  mode?: CorrectionMode;
  /** From `?itemId=`: the line "Ajukan void item" was tapped on. */
  itemId?: string;
  onModeChange: (mode: CorrectionMode) => void;
};

const SERVICE_TYPE_KEYS: Record<string, MessageKey> = {
  dine_in: "posCorrection.serviceType.dine_in",
  takeaway: "posCorrection.serviceType.takeaway",
  delivery: "posCorrection.serviceType.delivery",
};

const MODE_KEYS: Record<CorrectionMode, MessageKey> = {
  diskon: "posCorrection.modes.diskon",
  void: "posCorrection.modes.void",
  refund: "posCorrection.modes.refund",
  struk: "posCorrection.modes.struk",
};

function LoadingShape() {
  const t = useT();
  return (
    <CorrectionLayout
      title={t("posCorrection.title.generic")}
      subtitle={t("posCorrection.subtitle.loading")}
      sideTitle={t("posCorrection.state.orderHeading")}
      side={
        <div aria-hidden="true" className="grid gap-4">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      }
      panelTitle={t("posCorrection.state.loading")}
    >
      <div aria-busy="true" role="status" className="grid gap-4">
        <span className="sr-only">{t("posCorrection.state.loading")}</span>
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-2/3" />
        <p className="text-muted-foreground">
          {t("posCorrection.state.loadingHint")}
        </p>
      </div>
    </CorrectionLayout>
  );
}

function EmptyShape() {
  const t = useT();
  return (
    <CorrectionLayout
      title={t("posCorrection.title.generic")}
      subtitle={t("posCorrection.subtitle.empty")}
      sideTitle={t("posCorrection.state.orderHeading")}
      side={
        <p className="text-muted-foreground">
          {t("posCorrection.state.emptyAside")}
        </p>
      }
      panelTitle={t("posCorrection.state.emptyTitle")}
    >
      <p className="text-muted-foreground">
        {t("posCorrection.state.emptyBody")}
      </p>
      <div>
        <Button asChild>
          <Link to="/pos/meja">{t("posCorrection.state.emptyAction")}</Link>
        </Button>
      </div>
    </CorrectionLayout>
  );
}

function ErrorShape({
  retrying,
  onRetry,
}: {
  retrying: boolean;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <CorrectionLayout
      title={t("posCorrection.title.generic")}
      subtitle={t("posCorrection.subtitle.error")}
      sideTitle={t("posCorrection.state.orderHeading")}
      side={
        <p className="text-muted-foreground">
          {t("posCorrection.state.errorAside")}
        </p>
      }
      panelTitle={t("posCorrection.state.errorTitle")}
    >
      <div role="alert" className="grid gap-4">
        <p className="text-muted-foreground">
          {t("posCorrection.state.errorBody")}
        </p>
        <div>
          <Button type="button" loading={retrying} onClick={onRetry}>
            <RotateCw aria-hidden="true" />
            {t("common.retry")}
          </Button>
        </div>
      </div>
    </CorrectionLayout>
  );
}

// /pos/pesanan/$orderId/koreksi: discount, void, refund and the receipt preview
// of one order (bead legend-2fo). This screen only picks the order and the
// mode; each mode owns its form. Data comes from hooks only.
export function CorrectionScreen({
  orderId,
  mode,
  itemId,
  onModeChange,
}: Props) {
  const t = useT();
  const order = useCorrectionOrder(orderId);

  let content: ReactNode;
  if (order.isLoading) content = <LoadingShape />;
  else if (order.error) {
    content =
      order.error instanceof ApiError && order.error.status === 404 ? (
        <EmptyShape />
      ) : (
        <ErrorShape
          retrying={order.isFetching}
          onRetry={() => void order.refetch()}
        />
      );
  } else if (!order.data) content = <EmptyShape />;
  else {
    const data = order.data;
    if (data.status === "voided") {
      content = (
        <StateBlock
          title={t("posCorrection.state.voidedTitle")}
          description={t("posCorrection.state.voidedBody")}
        >
          <BackButton />
        </StateBlock>
      );
    } else {
      const active: CorrectionMode =
        mode ?? (data.status === "completed" ? "refund" : "diskon");
      const subtitle = t("posCorrection.subtitle.order", {
        orderNo: data.number,
        serviceType: t(
          SERVICE_TYPE_KEYS[data.serviceType] ??
            "posCorrection.serviceType.dine_in",
        ),
      });
      const switcher = (
        <SegmentedControl
          label={t("posCorrection.modes.label")}
          value={active}
          onValueChange={onModeChange}
          options={CORRECTION_MODES.map((value) => ({
            value,
            label: t(MODE_KEYS[value]),
          }))}
        />
      );
      content =
        active === "diskon" ? (
          <DiscountForm
            order={data}
            subtitle={subtitle}
            switcher={switcher}
            onOpenRefund={() => onModeChange("refund")}
          />
        ) : active === "void" ? (
          <VoidForm
            order={data}
            itemId={itemId}
            subtitle={subtitle}
            switcher={switcher}
            onOpenRefund={() => onModeChange("refund")}
          />
        ) : active === "refund" ? (
          <RefundForm order={data} switcher={switcher} />
        ) : (
          <ReceiptPreview
            order={data}
            subtitle={
              data.status === "completed"
                ? t("posCorrection.subtitle.paid", { orderNo: data.number })
                : subtitle
            }
            switcher={switcher}
          />
        );
    }
  }

  return <div data-density="kontras">{content}</div>;
}
