import { useState } from "react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  isContractPending,
  usePointsAccount,
  useQuotePoints,
  useRedeemPoints,
} from "../../hooks";
import type { PointsAccount } from "../../types";
import { Notice, PosPanel } from "../shared";
import type { AdjustmentPanelProps } from "./adjustment-types";
import { LoadingPanel } from "./gateway-parts";

// Member points redemption (brief 936, legend-5w6). The server owns the rules:
// the min/max limits, the rupiah value of the points and the new bill total.
// This panel only forwards the points and shows the amounts it gets back.
export function PointsPanel({
  orderId,
  onDone,
  onCancel,
}: AdjustmentPanelProps) {
  const t = useT();
  const account = usePointsAccount(orderId);

  if (account.isLoading)
    return <LoadingPanel title={t("posKasirPoints.title")} />;

  if (account.error != null) {
    const pending = isContractPending(account.error);
    return (
      <PosPanel
        title={t("posKasirPoints.title")}
        footer={
          <>
            {!pending && (
              <Button variant="outline" onClick={() => void account.refetch()}>
                {t("posKasirPoints.retry")}
              </Button>
            )}
            <Button onClick={onCancel}>{t("posKasirPoints.cancel")}</Button>
          </>
        }
      >
        <div className="mx-auto max-w-3xl py-4">
          {pending ? (
            <Notice tone="warning" title={t("posKasirPoints.contractPending")}>
              {t("posKasirPoints.contractPendingHint")}
            </Notice>
          ) : (
            <Notice tone="danger" title={t("posKasirPoints.loadError")}>
              {t("posKasirPoints.loadErrorHint")}
            </Notice>
          )}
        </div>
      </PosPanel>
    );
  }

  const data = account.data;
  if (!data)
    return (
      <PosPanel
        title={t("posKasirPoints.title")}
        footer={
          <Button onClick={onCancel}>{t("posKasirPoints.cancel")}</Button>
        }
      >
        <div className="mx-auto max-w-3xl py-4">
          <Notice tone="info" title={t("posKasirPoints.noMemberTitle")}>
            {t("posKasirPoints.noMemberBody")}
          </Notice>
        </div>
      </PosPanel>
    );

  return (
    <PointsForm
      orderId={orderId}
      account={data}
      onDone={onDone}
      onCancel={onCancel}
    />
  );
}

function PointsForm({
  orderId,
  account,
  onDone,
  onCancel,
}: AdjustmentPanelProps & { account: PointsAccount }) {
  const t = useT();
  const quote = useQuotePoints(orderId);
  const redeem = useRedeemPoints(orderId);
  const [text, setText] = useState("");

  const points = text === "" ? null : Number(text);
  const inRange =
    points !== null &&
    Number.isInteger(points) &&
    points >= account.minRedeemPoints &&
    points <= account.maxRedeemPoints;
  const outOfRange = points !== null && !inRange;
  const busy = quote.isPending || redeem.isPending;
  // The quote shown must belong to the number in the field.
  const shownQuote =
    quote.data && quote.data.points === points ? quote.data : null;

  const change = (next: string) => {
    setText(next.replace(/\D/g, "").slice(0, 9));
    quote.reset();
    redeem.reset();
  };
  const getQuote = () => {
    if (busy || !inRange || points === null) return;
    quote.mutate({ points });
  };
  const doRedeem = () => {
    if (busy || !inRange || points === null || shownQuote === null) return;
    redeem.mutate({ points }, { onSuccess: () => onDone() });
  };

  const range = {
    min: account.minRedeemPoints.toLocaleString("id-ID"),
    max: account.maxRedeemPoints.toLocaleString("id-ID"),
  };

  return (
    <PosPanel
      title={t("posKasirPoints.title")}
      footer={
        <>
          <Button
            variant="outline"
            onClick={onCancel}
            disabled={redeem.isPending}
          >
            {t("posKasirPoints.cancel")}
          </Button>
          <Button
            onClick={doRedeem}
            loading={redeem.isPending}
            disabled={!inRange || shownQuote === null || busy}
          >
            {redeem.isPending
              ? t("posKasirPoints.redeeming")
              : t("posKasirPoints.redeemButton")}
          </Button>
        </>
      }
    >
      <form
        className="mx-auto grid max-w-3xl gap-4 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          getQuote();
        }}
      >
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">
              {t("posKasirPoints.memberLabel")}
            </dt>
            <dd className="type-title">{account.memberName}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">
              {t("posKasirPoints.balanceLabel")}
            </dt>
            <dd className="type-title tabular">
              {t("posKasirPoints.balanceValue", {
                points: account.balancePoints.toLocaleString("id-ID"),
              })}
            </dd>
          </div>
        </dl>

        <div className="flex flex-wrap items-end gap-3">
          <FormField
            label={t("posKasirPoints.pointsLabel")}
            hint={t("posKasirPoints.pointsHint", range)}
            error={
              outOfRange ? t("posKasirPoints.outOfRange", range) : undefined
            }
            className="min-w-48 flex-1"
          >
            <Input
              name="points"
              value={text}
              onChange={(event) => change(event.target.value)}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              className="tabular"
            />
          </FormField>
          <Button
            type="button"
            variant="outline"
            onClick={() => change(String(account.maxRedeemPoints))}
            disabled={busy || account.maxRedeemPoints < account.minRedeemPoints}
          >
            {t("posKasirPoints.maxButton")}
          </Button>
          <Button
            type="submit"
            variant="outline"
            loading={quote.isPending}
            disabled={!inRange || busy}
          >
            {quote.isPending
              ? t("posKasirPoints.quoting")
              : t("posKasirPoints.quoteButton")}
          </Button>
        </div>

        <div aria-live="polite">
          {shownQuote && (
            <Notice
              tone="info"
              title={t("posKasirPoints.quoteResult", {
                points: shownQuote.points.toLocaleString("id-ID"),
                amount: formatRupiah(shownQuote.valueIdr),
              })}
            >
              {t("posKasirPoints.quoteHint")}
            </Notice>
          )}
        </div>
        {quote.error != null && (
          <PointsError
            error={quote.error}
            title={t("posKasirPoints.quoteError")}
          />
        )}
        {redeem.error != null && (
          <PointsError
            error={redeem.error}
            title={t("posKasirPoints.redeemError")}
          />
        )}
      </form>
    </PosPanel>
  );
}

/** A failed call in catalog words: never the raw server message. */
function PointsError({ error, title }: { error: unknown; title: string }) {
  const t = useT();
  if (isContractPending(error))
    return (
      <Notice tone="warning" title={t("posKasirPoints.contractPending")}>
        {t("posKasirPoints.contractPendingHint")}
      </Notice>
    );
  return (
    <Notice tone="danger" title={title}>
      {t("posKasirPoints.errorRecovery")}
    </Notice>
  );
}
