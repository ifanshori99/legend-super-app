import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { MemberOpenBill, MemberPointsQuote } from "@starter/shared/crm";
import { formatNumber } from "@starter/shared/i18n";
import { formatIdr, previewRedeem } from "../view-model";
import { BillCard } from "./bill-card";
import {
  Eyebrow,
  FlowGrid,
  Note,
  Panel,
  SummaryBox,
  SummaryRow,
} from "./flow-parts";

/** Id of the panel heading: the page moves focus here when the step changes. */
export const POINTS_PICKER_TITLE_ID = "tukar-poin-picker-title";

type PreviewError = NonNullable<ReturnType<typeof previewRedeem>["error"]>;

export function PointsPicker({
  bill,
  quote,
  initialPoints,
  blockedReason,
  submitting,
  onSubmit,
  onBack,
}: {
  bill: MemberOpenBill;
  quote: MemberPointsQuote;
  initialPoints?: number;
  // Set while an earlier QR is still live: no new mint until it ends.
  blockedReason?: ReactNode;
  submitting: boolean;
  onSubmit: (points: number) => void;
  onBack: () => void;
}) {
  const t = useT();
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const [raw, setRaw] = useState(
    initialPoints === undefined ? "" : String(initialPoints),
  );
  const [touched, setTouched] = useState(false);

  const preview = previewRedeem(quote, raw);
  const showError = preview.error !== null && touched;
  const canSubmit =
    preview.error === null &&
    preview.points !== null &&
    !submitting &&
    !blockedReason;
  const key = <N extends string>(name: N) =>
    `member.tukarPoin.picker.${name}` as const;

  function errorText(error: PreviewError): string {
    switch (error) {
      case "empty":
        return t(key("errorEmpty"));
      case "not_integer":
        return t(key("errorNotInteger"));
      case "below_min":
        return t(key("errorBelowMin"), { min: formatNumber(quote.minPoints) });
      case "over_balance":
        return t(key("errorOverBalance"), {
          balance: formatNumber(quote.balancePoints),
        });
      case "over_bill":
        return t(key("errorOverBill"), {
          max: formatNumber(quote.maxPoints),
          amount: formatIdr(quote.maxPoints * quote.pointValueIdr),
        });
      case "not_eligible":
        return t(key("errorNotEligible"));
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    if (canSubmit && preview.points !== null) onSubmit(preview.points);
  }

  const context = (
    <div className="grid gap-4">
      <div>
        <Eyebrow>{t(key("contextEyebrow"))}</Eyebrow>
        <h2 className="text-lg font-semibold text-foreground">
          {t(key("contextTitle"))}
        </h2>
      </div>
      <BillCard bill={bill} />
      <SummaryBox>
        <SummaryRow
          label={t(key("remainingLabel"))}
          value={formatIdr(quote.remainingIdr)}
        />
        <SummaryRow
          label={t(key("balanceLabel"))}
          value={t(key("balanceValue"), {
            points: formatNumber(quote.balancePoints),
          })}
        />
      </SummaryBox>
    </div>
  );

  const outlet = bill.outletArea
    ? t(key("outletArea"), { outlet: bill.outletName, area: bill.outletArea })
    : bill.outletName;
  const ref = bill.tableLabel
    ? t(key("billRefTable"), {
        number: bill.billNumber,
        table: bill.tableLabel,
      })
    : t(key("billRef"), { number: bill.billNumber });

  // Phone only: the short bill line above the form; the full context is in the
  // disclosure below the card.
  const compactBill = (
    <div className="grid gap-1 border-y border-border py-3 md:hidden">
      <p className="font-semibold">{outlet}</p>
      <p>{ref}</p>
      <p className="flex items-baseline justify-between gap-3">
        <span>{t(key("remainingLabel"))}</span>
        <span className="font-semibold tabular">
          {formatIdr(quote.remainingIdr)}
        </span>
      </p>
    </div>
  );

  const panel = (
    <Panel labelledBy={POINTS_PICKER_TITLE_ID}>
      <form className="grid gap-4" onSubmit={handleSubmit} noValidate>
        <div>
          <Eyebrow>{t(key("eyebrow"))}</Eyebrow>
          <h2
            id={POINTS_PICKER_TITLE_ID}
            tabIndex={-1}
            className="text-xl font-semibold text-foreground outline-none"
          >
            {t(key("title"))}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(key("rateHint"), {
              points: formatNumber(1),
              amount: formatIdr(quote.pointValueIdr),
            })}
          </p>
        </div>

        {compactBill}

        <div className="grid gap-1.5">
          <Label htmlFor={fieldId}>{t(key("fieldLabel"))}</Label>
          <Input
            id={fieldId}
            name="points"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={raw}
            disabled={submitting}
            aria-invalid={showError ? true : undefined}
            aria-describedby={showError ? `${hintId} ${errorId}` : hintId}
            onChange={(event) => setRaw(event.target.value)}
            onBlur={() => setTouched(true)}
          />
          <p id={hintId} className="text-base text-muted-foreground">
            {t(key("fieldHint"), {
              min: formatNumber(quote.minPoints),
              max: formatNumber(quote.maxPoints),
            })}
          </p>
          {showError && preview.error !== null ? (
            <p
              id={errorId}
              role="alert"
              className="text-base font-medium text-danger"
            >
              {errorText(preview.error)}
            </p>
          ) : null}
        </div>

        {preview.error === null && preview.points !== null ? (
          <>
            <SummaryBox label={t(key("summaryLabel"))}>
              <SummaryRow
                label={t(key("valueLabel"), {
                  points: formatNumber(preview.points),
                })}
                value={formatIdr(preview.valueIdr)}
              />
              <SummaryRow
                label={t(key("remainingAfterLabel"))}
                value={formatIdr(preview.remainingAfterIdr)}
              />
              <SummaryRow
                strong
                label={t(key("balanceAfterLabel"))}
                value={t(key("balanceValue"), {
                  points: formatNumber(preview.balanceAfter),
                })}
              />
            </SummaryBox>
            <Note>
              {t(key("scopeNote"), { points: formatNumber(preview.points) })}
            </Note>
          </>
        ) : null}

        {blockedReason ? <Note tone="warning">{blockedReason}</Note> : null}

        <div className="grid gap-2">
          <Button
            type="submit"
            disabled={!canSubmit}
            aria-busy={submitting || undefined}
          >
            {submitting
              ? t(key("submitting"))
              : preview.error === null && preview.points !== null
                ? t(key("submit"), { points: formatNumber(preview.points) })
                : t(key("submitDisabled"))}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={onBack}
          >
            {t(key("back"))}
          </Button>
        </div>
      </form>
    </Panel>
  );

  return (
    <div className="grid gap-6">
      <FlowGrid
        context={<div className="hidden md:block">{context}</div>}
        panel={panel}
        busy={submitting}
      />
      <details className="group border-t border-border pt-3 md:hidden">
        <summary className="flex min-h-11 cursor-pointer items-center font-semibold">
          {t(key("detailsToggle"))}
        </summary>
        <div className="pt-3">{context}</div>
      </details>
    </div>
  );
}
