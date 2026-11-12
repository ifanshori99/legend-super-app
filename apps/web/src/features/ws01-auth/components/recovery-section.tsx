import * as React from "react";
import { KeyRound, RotateCw } from "lucide-react";
import { MFA_RECOVERY_CODE_COUNT } from "@starter/shared/identity";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { recoveryGenerateErrorKey } from "../errors";
import { formatDateTime } from "../format";
import { useGenerateRecoveryCodes, useMfaRecoveryStatus } from "../hooks";
import {
  recoveryNeedsRegeneration,
  recoveryStatusView,
} from "../recovery-state";
import { RecoveryCodesCard } from "./recovery-codes-card";

/**
 * "Kode cadangan" inside the security page's second-factor card (bead
 * legend-sw980): how many single-use codes are left, make the first set, or
 * replace it. Generating needs a session that already verified the factor, so
 * the API's refusal is shown as a hint, not as a failure.
 */
export function RecoverySection({
  hasFactor,
  onEnroll,
}: {
  /** At least one second factor is enrolled. */
  hasFactor: boolean;
  /** Opens the enrollment flow (the empty state's action). */
  onEnroll: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const status = useMfaRecoveryStatus();
  const generate = useGenerateRecoveryCodes();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [codes, setCodes] = React.useState<readonly string[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  function createCodes() {
    setError(null);
    generate.mutate(undefined, {
      onSuccess: (result) => {
        setConfirmOpen(false);
        setCodes(result.codes);
      },
      onError: (cause) => setError(t(recoveryGenerateErrorKey(cause))),
    });
  }

  function codesSaved() {
    setCodes(null);
    generate.reset();
    toast({ title: t("staffAuth.recovery.savedToast"), tone: "success" });
  }

  const view = status.data ? recoveryStatusView(status.data) : null;
  const firstTime = view === "not_generated";

  let body: React.ReactNode;
  if (!hasFactor && !status.isPending) {
    body = (
      <>
        <div className="grid gap-0.5">
          <p className="text-sm leading-5 font-semibold">
            {t("staffAuth.recovery.emptyTitle")}
          </p>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("staffAuth.recovery.emptyHint")}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onEnroll}>
          {t("staffAuth.recovery.emptyAction")}
        </Button>
      </>
    );
  } else if (status.isPending) {
    body = (
      <div
        className="grid flex-1 gap-2"
        role="status"
        aria-label={t("staffAuth.recovery.loading")}
      >
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  } else if (status.isError) {
    body = (
      <>
        <div className="grid gap-0.5" role="alert">
          <p className="text-sm leading-5 font-semibold">
            {t("staffAuth.recovery.errorBanner")}
          </p>
          <p className="text-sm leading-5 text-muted-foreground">
            {status.error instanceof ApiError &&
            status.error.code === "NETWORK_ERROR"
              ? t("staffAuth.recovery.offline")
              : t("staffAuth.recovery.errorHint")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void status.refetch()}
        >
          <RotateCw aria-hidden="true" />
          {t("common.retry")}
        </Button>
      </>
    );
  } else if (status.data && view) {
    body = (
      <>
        <div className="grid gap-0.5">
          <p className="text-sm leading-5 font-semibold">
            {firstTime
              ? t("staffAuth.recovery.notGeneratedTitle")
              : t("staffAuth.recovery.remaining", {
                  count: status.data.remaining,
                  total: MFA_RECOVERY_CODE_COUNT,
                })}
          </p>
          <p className="text-sm leading-5 text-muted-foreground">
            {firstTime
              ? t("staffAuth.recovery.notGeneratedHint")
              : view === "depleted"
                ? t("staffAuth.recovery.depletedHint")
                : view === "low"
                  ? t("staffAuth.recovery.lowHint")
                  : status.data.generatedAt
                    ? t("staffAuth.recovery.generatedAt", {
                        time: formatDateTime(status.data.generatedAt),
                      })
                    : ""}
          </p>
        </div>
        <Button
          variant={
            firstTime || recoveryNeedsRegeneration(view) ? "default" : "outline"
          }
          size="sm"
          loading={firstTime && generate.isPending}
          onClick={() => {
            if (firstTime) createCodes();
            else {
              setError(null);
              setConfirmOpen(true);
            }
          }}
        >
          {firstTime
            ? t("staffAuth.recovery.generate")
            : t("staffAuth.recovery.regenerate")}
        </Button>
      </>
    );
  }

  return (
    <>
      <div className="mt-4 flex flex-wrap items-start gap-3 rounded-container border-(length:--border-w) border-dashed p-3">
        <KeyRound
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="grid min-w-0 flex-1 gap-2">
          <div className="grid gap-0.5">
            <p className="text-sm leading-5 font-semibold">
              {t("staffAuth.mfa.backupTitle")}
            </p>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("staffAuth.mfa.backupHint")}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            {body}
          </div>
          {error && !confirmOpen && (
            <p role="alert" className="text-sm leading-5 text-danger">
              {error}
            </p>
          )}
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("staffAuth.recovery.regenerateTitle")}</DialogTitle>
            <DialogDescription>
              {t("staffAuth.recovery.regenerateDescription")}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm leading-5 text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button loading={generate.isPending} onClick={createCodes}>
              {t("staffAuth.recovery.regenerateConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* The plaintext exists once: only the confirm button closes this. */}
      <Dialog open={codes !== null} onOpenChange={() => undefined}>
        <DialogContent
          hideClose
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogTitle className="sr-only">
            {t("staffAuth.recovery.title")}
          </DialogTitle>
          {codes && <RecoveryCodesCard codes={codes} onSaved={codesSaved} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
