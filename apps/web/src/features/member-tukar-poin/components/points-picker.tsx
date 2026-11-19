import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  MemberOpenBill,
  MemberPointsQuote,
} from "@starter/shared/crm/member-points-redeem";
import { formatIdr, formatPoints, previewRedeem } from "../view-model";
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
  const showError = preview.error !== null && (touched || raw !== "");
  const canSubmit =
    preview.error === null &&
    preview.points !== null &&
    !submitting &&
    !blockedReason;
  const key = (name: string) => `member.tukarPoin.picker.${name}`;

  function errorText(error: PreviewError): string {
    switch (error) {
      case "empty":
        return t(key("errorEmpty"));
      case "not_integer":
        return t(key("errorNotInteger"));
      case "below_min":
        return t(key("errorBelowMin"), { min: formatPoints(quote.minPoints) });
      case "over_balance":
        return t(key("errorOverBalance"), {
          balance: formatPoints(quote.balancePoints),
        });
      case "over_bill":
        return t(key("errorOverBill"), {
          max: formatPoints(quote.maxPoints),
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
            points: formatPoints(quote.balancePoints),
          })}
        />
      </SummaryBox>
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
              points: formatPoints(1),
              amount: formatIdr(quote.pointValueIdr),
            })}
          </p>
        </div>

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
            onChange={(event) => {
              setRaw(event.target.value);
              setTouched(true);
            }}
            onBlur={() => setTouched(true)}
          />
          <p id={hintId} className="text-sm text-muted-foreground">
            {t(key("fieldHint"), {
              min: formatPoints(quote.minPoints),
              max: formatPoints(quote.maxPoints),
            })}
          </p>
          {showError && preview.error !== null ? (
            <p
              id={errorId}
              role="alert"
              className="text-sm font-medium text-danger"
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
                  points: formatPoints(preview.points),
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
                  points: formatPoints(preview.balanceAfter),
                })}
              />
            </SummaryBox>
            <Note>
              {t(key("scopeNote"), { points: formatPoints(preview.points) })}
            </Note>
          </>
        ) : showError ? (
          <Note tone="warning">{t(key("limitNote"))}</Note>
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
                ? t(key("submit"), { points: formatPoints(preview.points) })
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

  return <FlowGrid context={context} panel={panel} busy={submitting} />;
}
