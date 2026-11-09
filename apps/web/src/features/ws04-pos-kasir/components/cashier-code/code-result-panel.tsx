import { Link } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRupiah } from "@starter/shared/i18n";
import { Notice, StateBlock, StatusPill } from "../shared";
import { formatReference, type CashierCodeOrder } from "../../types";

const PANEL_CLASS =
  "flex h-full min-h-80 flex-col gap-4 rounded-container border-(length:--border-w) border-border bg-card p-card";

export type CodeResultView =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "found"; order: CashierCodeOrder }
  | { kind: "invalid" }
  | { kind: "error"; pending: boolean };

// Right-hand panel of the code screen. It is a polite live region, so the
// result of a search is announced without moving focus.
export function CodeResultPanel({ view }: { view: CodeResultView }) {
  return (
    <section
      data-slot="code-result"
      aria-live="polite"
      aria-busy={view.kind === "loading"}
      className={PANEL_CLASS}
    >
      {view.kind === "idle" && <IdleResult />}
      {view.kind === "loading" && <LoadingResult />}
      {view.kind === "found" && <FoundResult order={view.order} />}
      {view.kind === "invalid" && <InvalidResult />}
      {view.kind === "error" && <ErrorResult pending={view.pending} />}
    </section>
  );
}

function IdleResult() {
  const t = useT();
  return (
    <div className="grid flex-1 place-items-center">
      <StateBlock
        title={t("posKasirCode.idle.title")}
        description={t("posKasirCode.idle.description")}
      />
    </div>
  );
}

function LoadingResult() {
  const t = useT();
  return (
    <div className="grid gap-4">
      <p className="sr-only">{t("posKasirCode.loading")}</p>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

function FoundResult({ order }: { order: CashierCodeOrder }) {
  const t = useT();
  const payable = order.status === "unpaid";
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {order.status === "unpaid" && (
          <StatusPill tone="success">{t("posKasirCode.found.pill")}</StatusPill>
        )}
        {order.status === "paid" && (
          <StatusPill tone="success">{t("posKasirCode.paid.pill")}</StatusPill>
        )}
        {order.status === "cancelled" && (
          <StatusPill tone="danger">
            {t("posKasirCode.cancelled.pill")}
          </StatusPill>
        )}
        <span className="text-base text-muted-foreground">
          {t("posKasirCode.found.source")}
        </span>
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="type-display tabular">{formatReference(order.code)}</p>
        <p className="type-title">{order.tableLabel}</p>
      </div>
      <ul className="divide-y-(length:--border-w) divide-border border-y-(length:--border-w) border-border">
        {order.items.map((item, index) => (
          <li
            key={`${item.name}-${index}`}
            className="grid grid-cols-[3.25rem_minmax(0,1fr)_auto] items-center gap-4 py-4"
          >
            <span
              className="grid size-13 place-items-center rounded-control bg-muted text-2xl font-bold tabular"
              role="img"
              aria-label={t("posKasirCode.found.quantity", {
                qty: item.qty,
              })}
            >
              {item.qty}
            </span>
            <div className="min-w-0">
              <p className="text-(length:--density-text) font-semibold">
                {item.name}
              </p>
              <p className="text-base text-muted-foreground">
                {t("posKasirCode.found.itemNote")}
              </p>
            </div>
            <Money amount={item.amountIdr} size="lg" />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-(length:--density-text) font-semibold">
            {t("posKasirCode.found.total")}
          </p>
          <p className="text-base text-muted-foreground">
            {t("posKasirCode.found.noPayment")}
          </p>
        </div>
        <Money amount={order.totalIdr} size="stat" />
      </div>
      {payable && (
        <>
          <Notice tone="warning" title={t("posKasirCode.found.unpaidTitle")}>
            {t("posKasirCode.found.unpaidBody")}
          </Notice>
          <div className="mt-auto grid gap-3">
            <Button asChild size="lg" className="w-full">
              <Link
                to="/pos/bayar/$orderId"
                params={{ orderId: order.orderId }}
              >
                {t("posKasirCode.found.continue", {
                  amount: formatRupiah(order.totalIdr),
                })}
              </Link>
            </Button>
            <p className="text-center text-base text-muted-foreground">
              {t("posKasirCode.found.continueNote")}
            </p>
          </div>
        </>
      )}
      {order.status === "paid" && (
        <Notice tone="info" title={t("posKasirCode.paid.title")}>
          {t("posKasirCode.paid.body")}
        </Notice>
      )}
      {order.status === "cancelled" && (
        <Notice tone="danger" title={t("posKasirCode.cancelled.title")}>
          {t("posKasirCode.cancelled.body")}
        </Notice>
      )}
    </>
  );
}

function InvalidResult() {
  const t = useT();
  return (
    <div className="flex flex-1 flex-col justify-center gap-5">
      <span
        className="grid size-16 place-items-center rounded-full bg-danger-subtle text-danger"
        aria-hidden="true"
      >
        <CircleAlert className="size-8" />
      </span>
      <div className="grid max-w-lg gap-3">
        <h2 className="type-title">{t("posKasirCode.invalid.title")}</h2>
        <p className="text-(length:--density-text) leading-6 text-muted-foreground">
          {t("posKasirCode.invalid.description")}
        </p>
      </div>
      <Notice
        tone="info"
        title={t("posKasirCode.invalid.noteTitle")}
        className="max-w-lg"
      >
        {t("posKasirCode.invalid.noteBody")}
      </Notice>
    </div>
  );
}

function ErrorResult({ pending }: { pending: boolean }) {
  const t = useT();
  return (
    <div className="flex flex-1 flex-col justify-center gap-5">
      <span
        className="grid size-16 place-items-center rounded-full bg-danger-subtle text-danger"
        aria-hidden="true"
      >
        <CircleAlert className="size-8" />
      </span>
      <div className="grid max-w-lg gap-3">
        <h2 className="type-title">
          {pending
            ? t("posKasirCode.error.pendingTitle")
            : t("posKasirCode.error.genericTitle")}
        </h2>
        <p className="text-(length:--density-text) leading-6 text-muted-foreground">
          {pending
            ? t("posKasirCode.error.pendingBody")
            : t("posKasirCode.error.genericBody")}
        </p>
      </div>
      <Notice
        tone="info"
        title={t("posKasirCode.invalid.noteTitle")}
        className="max-w-lg"
      >
        {t("posKasirCode.invalid.noteBody")}
      </Notice>
    </div>
  );
}
