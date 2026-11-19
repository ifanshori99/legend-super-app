import { formatNumber } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BigAmount,
  Eyebrow,
  FlowGrid,
  Note,
  Panel,
  PanelTitle,
  SummaryBox,
} from "./flow-parts";

export type StatusVariant = "loading" | "offline" | "error";

// The three states the page owns itself (mockups loading, offline, and the
// read failure): data not here yet, no connection, or the read failed. The QR
// is never part of any of them. Presentational: the page owns the actions.
export function StatusView({
  variant,
  memberName,
  balancePoints,
  onAction,
  actionBusy = false,
  checkFailed = false,
  pointsUncertain = false,
}: {
  variant: StatusVariant;
  memberName?: string;
  /** Last balance the page knows; null when none was ever received. */
  balancePoints: number | null;
  onAction?: () => void;
  actionBusy?: boolean;
  /** The last status check did not complete: shown next to the action. */
  checkFailed?: boolean;
  /** A token may still exist: the error note cannot say points are unspent. */
  pointsUncertain?: boolean;
}) {
  const t = useT();
  const key = <N extends string>(name: N) =>
    `member.tukarPoin.page.${name}` as const;
  const identity =
    memberName === undefined
      ? t(key("identityFallback"))
      : t(key("identity"), { name: memberName });
  const showBalance = variant !== "error" || balancePoints !== null;
  const balanceKnown = variant !== "loading" && balancePoints !== null;

  return (
    <FlowGrid
      busy={variant === "loading" || actionBusy}
      context={
        <div className="grid content-start gap-3">
          <Eyebrow>{identity}</Eyebrow>
          <h2 className="font-brand type-title">
            {t(key(`${variant}ContextTitle`))}
          </h2>
          <p className="text-muted-foreground">
            {t(key(`${variant}ContextSub`))}
          </p>
          {showBalance && (
            <SummaryBox>
              <p className="text-sm text-muted-foreground">
                {variant === "offline"
                  ? t(key("offlineBalanceLabel"))
                  : t(key("balanceLabel"))}
              </p>
              {balanceKnown ? (
                <BigAmount>
                  {t(key("pointsValue"), {
                    points: formatNumber(balancePoints),
                  })}
                </BigAmount>
              ) : (
                <BigAmount label={t(key("balancePendingSr"))}>
                  {t(key("balancePending"))}
                </BigAmount>
              )}
              {variant === "offline" && (
                <p className="text-sm text-muted-foreground">
                  {t(key("offlineBalanceNote"))}
                </p>
              )}
            </SummaryBox>
          )}
        </div>
      }
      panel={
        <Panel>
          <div className="grid gap-1">
            <Eyebrow>{t(key(`${variant}Eyebrow`))}</Eyebrow>
            {variant === "loading" ? (
              <div aria-live="polite">
                <PanelTitle>{t(key("loadingTitle"))}</PanelTitle>
              </div>
            ) : (
              <PanelTitle>{t(key(`${variant}Title`))}</PanelTitle>
            )}
          </div>
          {variant === "loading" && (
            <SummaryBox>
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-9 w-3/5" />
              <Skeleton className="h-4 w-4/5" />
            </SummaryBox>
          )}
          <p>{t(key(`${variant}Body`))}</p>
          <Note tone={variant === "offline" ? "warning" : "info"}>
            {variant === "error" && pointsUncertain
              ? t(key("errorNoteUncertain"))
              : t(key(`${variant}Note`))}
          </Note>
          {variant !== "loading" && onAction && checkFailed && (
            <Note tone="warning">{t(key("checkFailed"))}</Note>
          )}
          {variant !== "loading" && onAction && (
            <Button
              className="min-h-11 w-full"
              loading={actionBusy}
              onClick={onAction}
            >
              {actionBusy && variant === "offline"
                ? t(key("offlineChecking"))
                : t(key(`${variant}Action`))}
            </Button>
          )}
        </Panel>
      }
    />
  );
}
