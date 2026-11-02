import * as React from "react";
import {
  KeyRound,
  Plus,
  ShieldQuestion,
  Smartphone,
  Trash2,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import type { MfaFactor } from "@starter/shared/identity";
import { formatDate } from "../format";
import { useDeleteMfaFactor, useMfaFactors } from "../hooks";
import { canRemoveFactor } from "../state";
import { TotpEnrollFlow } from "./totp-enroll";

/**
 * Enrolled second factors: list, add (TOTP), remove. AUTH-05 keeps the last
 * factor of an MFA role in place, so the account can always open the back
 * office; the API enforces the same rule.
 */
export function MfaPanel({ mfaRequired }: { mfaRequired: boolean }) {
  const t = useT();
  const toast = useToast();
  const factors = useMfaFactors();
  const remove = useDeleteMfaFactor();
  const [chooseOpen, setChooseOpen] = React.useState(false);
  const [enrollOpen, setEnrollOpen] = React.useState(false);
  const [removeTarget, setRemoveTarget] = React.useState<MfaFactor | null>(
    null,
  );
  const [removeError, setRemoveError] = React.useState<string | null>(null);
  const rows = factors.data ?? [];
  const locked = !canRemoveFactor({ factors: rows, mfaRequired });

  function confirmRemove() {
    if (!removeTarget) return;
    setRemoveError(null);
    remove.mutate(removeTarget.id, {
      onSuccess: () => {
        toast({ title: t("staffAuth.mfa.removed"), tone: "success" });
        setRemoveTarget(null);
      },
      onError: () => setRemoveError(t("staffAuth.mfa.removeFailed")),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("staffAuth.mfa.title")}</CardTitle>
        <CardDescription>{t("staffAuth.mfa.description")}</CardDescription>
      </CardHeader>

      <CardContent>
        {factors.isPending ? (
          <div className="grid gap-2" aria-busy="true">
            <span className="sr-only">{t("common.loading")}</span>
            <Skeleton className="h-row w-full" />
            <Skeleton className="h-row w-full" />
          </div>
        ) : factors.isError ? (
          <ErrorState onRetry={() => void factors.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ShieldQuestion}
            title={t("staffAuth.mfa.emptyTitle")}
            description={t("staffAuth.mfa.emptyHint")}
          />
        ) : (
          <ul className="grid gap-2">
            {rows.map((factor) => {
              const Icon = factor.type === "totp" ? Smartphone : KeyRound;
              return (
                <li
                  key={factor.id}
                  className="flex flex-wrap items-center gap-3 rounded-lg border-(length:--border-w) px-3 py-2"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <p className="text-sm leading-5 font-semibold">
                      {factor.type === "totp"
                        ? t("staffAuth.mfa.totpLabel")
                        : t("staffAuth.mfa.passkeyLabel")}
                    </p>
                    <p className="text-xs leading-4 text-muted-foreground">
                      {t("staffAuth.mfa.addedAt", {
                        date: formatDate(factor.createdAt),
                      })}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={locked}
                    onClick={() => {
                      setRemoveError(null);
                      setRemoveTarget(factor);
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                    <span className="sr-only">{t("staffAuth.mfa.remove")}</span>
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {locked && rows.length === 1 && (
          <p className="mt-3 text-sm leading-5 text-muted-foreground">
            {t("staffAuth.mfa.removeLastBlocked")}
          </p>
        )}

        <div className="mt-4 flex items-start gap-3 rounded-lg border border-dashed p-3">
          <KeyRound
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="grid gap-0.5">
            <p className="text-sm leading-5 font-semibold">
              {t("staffAuth.mfa.backupTitle")}
            </p>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("staffAuth.mfa.backupHint")}
            </p>
          </div>
        </div>
      </CardContent>

      <CardFooter>
        {/* Outline: when AUTH-05 blocks the session, "Verifikasi sekarang" is
            the one primary action of this view. */}
        <Button variant="outline" onClick={() => setChooseOpen(true)}>
          <Plus aria-hidden="true" />
          {t("staffAuth.mfa.add")}
        </Button>
      </CardFooter>

      <Dialog open={chooseOpen} onOpenChange={setChooseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("staffAuth.mfa.chooseTitle")}</DialogTitle>
            <DialogDescription>
              {t("staffAuth.mfa.chooseDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="h-auto items-start justify-start py-3 text-left font-normal whitespace-normal"
              onClick={() => {
                setChooseOpen(false);
                setEnrollOpen(true);
              }}
            >
              <Smartphone
                className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="grid min-w-0 gap-0.5">
                <span className="text-sm leading-5 font-semibold">
                  {t("staffAuth.mfa.addTotp")}
                </span>
                <span className="text-sm leading-5 text-muted-foreground">
                  {t("staffAuth.mfa.addTotpHint")}
                </span>
              </span>
            </Button>
            <div className="flex items-start gap-3 rounded-lg border border-dashed p-3">
              <KeyRound
                className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div className="grid gap-0.5">
                <p className="text-sm leading-5 font-semibold">
                  {t("staffAuth.mfa.addPasskey")}
                </p>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("staffAuth.mfa.passkeyUnavailable")}
                </p>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={enrollOpen} onOpenChange={(open) => setEnrollOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("staffAuth.enroll.title")}</DialogTitle>
            <DialogDescription>
              {t("staffAuth.enroll.description")}
            </DialogDescription>
          </DialogHeader>
          <TotpEnrollFlow
            onEnrolled={() => {
              setEnrollOpen(false);
              void factors.refetch();
            }}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("staffAuth.mfa.removeTitle")}</DialogTitle>
            <DialogDescription>
              {t("staffAuth.mfa.removeDescription", {
                name: removeTarget
                  ? removeTarget.type === "totp"
                    ? t("staffAuth.mfa.totpLabel")
                    : t("staffAuth.mfa.passkeyLabel")
                  : "",
              })}
            </DialogDescription>
          </DialogHeader>
          {removeError && (
            <p role="alert" className="text-sm leading-5 text-danger">
              {removeError}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              loading={remove.isPending}
              onClick={confirmRemove}
            >
              {t("staffAuth.mfa.remove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
