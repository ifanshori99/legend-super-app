// "Bukan saya" (legend-l2zru): the page the payout step receipt links to. It
// shows one step logged on the signed-in login and lets that person say it was
// not them. Saying so freezes the batch and re-asks the account password. It
// asks for no payroll permission on purpose: an approver whose access an
// attacker removed must still be able to freeze. The server answers 404 for
// anyone else's step.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api/errors";
import { formatDateTime } from "../../ws10-payroll-run/lib";
import { isPayoutOffline, payoutErrorMessage } from "../errors";
import { useApprovalLog, useDisownApproval } from "../hooks";

const REASON_MAX = 500;

export function DisownPage({ logId }: { logId: string }) {
  const t = useT();
  const query = useApprovalLog(logId);

  if (query.isPending) {
    return (
      <div
        role="status"
        aria-label={t("payrollPayoutReview.common.loadingLabel")}
        className="grid max-w-2xl gap-4"
      >
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-11 w-48" />
      </div>
    );
  }
  if (query.isError || !query.data) {
    const missing =
      query.error instanceof ApiError && query.error.status === 404;
    return missing ? (
      <EmptyState
        data-testid="disown-not-found"
        icon={ShieldAlert}
        title={t("payrollPayoutReceipt.disown.title")}
        description={t("payrollPayoutReceipt.disown.notFound")}
      />
    ) : (
      <ErrorState
        error={query.error}
        title={t(
          isPayoutOffline(query.error)
            ? "payrollPayout.error.offlineTitle"
            : "payrollPayoutReceipt.disown.title",
        )}
        description={t("payrollPayoutReceipt.disown.loadError")}
        onRetry={() => void query.refetch()}
      />
    );
  }
  return <DisownStep log={query.data} />;
}

function disownErrorMessage(
  failure: unknown,
  t: ReturnType<typeof useT>,
): string {
  if (failure instanceof ApiError) {
    if (failure.code === "REAUTH_PASSWORD_INVALID")
      return t("payrollPayout.error.reauthPasswordInvalid");
    if (failure.code === "NETWORK_ERROR")
      return t("payrollPayout.error.offline");
    if ([401, 403, 409].includes(failure.status))
      return t("payrollPayoutReceipt.disown.error.refused");
    return t("payrollPayoutReceipt.disown.error.generic");
  }
  return payoutErrorMessage(failure, t);
}

function DisownStep({
  log,
}: {
  log: NonNullable<ReturnType<typeof useApprovalLog>["data"]>;
}) {
  const t = useT();
  const disown = useDisownApproval();
  const [asking, setAsking] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  const submit = () => {
    if (disown.isPending || password === "") return;
    setError(null);
    const note = reason.trim();
    disown.mutate(
      {
        logId: log.id,
        password,
        ...(note === "" ? {} : { reason: note }),
      },
      {
        onSuccess: () => {
          setPassword("");
          setDone(true);
        },
        onError: (failure) => {
          setPassword("");
          setError(disownErrorMessage(failure, t));
        },
      },
    );
  };

  const summary = t("payrollPayoutReceipt.disown.summary", {
    verb: t(`payrollPayoutReceipt.verb.${log.step}`),
    kind: t(`payrollPayoutReceipt.kind.${log.kind}`),
    period: log.period,
    count: log.itemCount,
    time: formatDateTime(log.loggedAt),
  });

  return (
    <section
      aria-labelledby="disown-title"
      data-testid="disown-page"
      className="grid max-w-2xl gap-4 rounded-shell border-(length:--border-w) bg-card p-card shadow-hairline"
    >
      <h2 id="disown-title" className="type-title">
        {t("payrollPayoutReceipt.disown.title")}
      </h2>
      <p>{summary}</p>

      {done || log.disowned ? (
        <p
          role="status"
          data-testid="disown-done"
          className="rounded-container bg-warning-subtle p-3 text-sm text-foreground"
        >
          {t(
            done
              ? "payrollPayoutReceipt.disown.done"
              : "payrollPayoutReceipt.disown.alreadyDone",
          )}
        </p>
      ) : asking ? (
        <form
          noValidate
          aria-label={t("payrollPayoutReceipt.disown.no")}
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <p
            data-testid="disown-warning"
            className="rounded-container bg-warning-subtle p-3 text-sm text-foreground"
          >
            {t("payrollPayoutReceipt.disown.warning")}
          </p>
          <FormField
            label={t("payrollPayoutReceipt.disown.reasonLabel")}
            hint={t("payrollPayoutReceipt.disown.reasonHint")}
          >
            <Textarea
              value={reason}
              maxLength={REASON_MAX}
              rows={3}
              onChange={(event) => setReason(event.target.value)}
            />
          </FormField>
          <FormField
            label={t("payrollPayoutReceipt.disown.passwordLabel")}
            required
          >
            <Input
              type="password"
              autoComplete="current-password"
              className="min-h-11"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </FormField>
          {error && (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 min-[700px]:flex-row min-[700px]:justify-end">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => {
                setAsking(false);
                setError(null);
                setPassword("");
              }}
            >
              {t("payrollPayoutReceipt.disown.cancel")}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              className="min-h-11"
              loading={disown.isPending}
              disabled={password === ""}
            >
              {disown.isPending
                ? t("payrollPayoutReceipt.disown.confirming")
                : t("payrollPayoutReceipt.disown.confirm")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="grid gap-3">
          <p className="font-medium">
            {t("payrollPayoutReceipt.disown.question")}
          </p>
          <div className="flex flex-col gap-2 min-[700px]:flex-row">
            <Button asChild variant="outline" className="min-h-11">
              <Link
                to="/kelola/payroll/pencairan"
                search={{ tab: "approval", batch: log.batchId }}
              >
                {t("payrollPayoutReceipt.disown.yes")}
              </Link>
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              data-testid="disown-no"
              onClick={() => setAsking(true)}
            >
              {t("payrollPayoutReceipt.disown.no")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
