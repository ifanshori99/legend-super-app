import { useState, type ReactNode } from "react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useOutletClock } from "@/lib/tenant-context";
import {
  useCancelAttempt,
  useReleaseOnlineCode,
  useResolveApprovers,
} from "../../hooks";
import type { PaymentAttempt } from "../../types";
import { Notice, SupervisorPinDialog } from "../shared";
import {
  BlockNotice,
  ErrorNotice,
  LiveRegion,
  WaitingPanel,
  remainingMsOf,
  useNow,
} from "./gateway-parts";
import { formatClock } from "./payment-helpers";

/** Q93: a manager may release a code from 30 minutes after it lapsed. */
const RELEASE_AFTER_MS = 30 * 60 * 1000;

/** When the release opens (ISO), or undefined for a code without a deadline. */
export function releaseOpensAt(expiresAt: string | undefined) {
  if (expiresAt === undefined) return undefined;
  return new Date(Date.parse(expiresAt) + RELEASE_AFTER_MS).toISOString();
}

// 1269 C3b: a VA or e-wallet code is held like a QRIS. While it lives the bill
// takes nothing else; it ends paid, proven dead by Duitku (`02`), or released
// by a manager from 30 minutes after it lapsed. `children` is the code itself
// (the VA number or the payment page), shown only while the server gives it.
export function OnlineCodeHold({
  orderId,
  attempt,
  title,
  statusLabel,
  heading,
  description,
  noticeTitle,
  noticeBody,
  children,
}: {
  orderId: string;
  attempt: PaymentAttempt;
  title: string;
  statusLabel: string;
  heading: string;
  description: string;
  noticeTitle: string;
  noticeBody: string;
  children?: ReactNode;
}) {
  const t = useT();
  const { timeZone } = useOutletClock();
  const cancel = useCancelAttempt();
  const [releasing, setReleasing] = useState(false);
  const now = useNow(true);
  const remainingMs = remainingMsOf(attempt.expiresAt, now);
  const cancelling = attempt.status === "cancelling";
  const lapsed = remainingMs === 0;
  const shown = !cancelling && !lapsed && attempt.qrShown !== false;
  const opensAt = releaseOpensAt(attempt.expiresAt);
  const canRelease =
    opensAt !== undefined && now !== null && now >= Date.parse(opensAt);
  const method = attempt.method === "va" ? "va" : "ewallet";

  return (
    <LiveRegion>
      <WaitingPanel
        orderId={orderId}
        attempt={attempt}
        title={title}
        statusLabel={
          cancelling || lapsed
            ? t("posKasirGateway.code.cancellingStatus")
            : statusLabel
        }
        heading={
          cancelling
            ? t("posKasirGateway.code.cancellingHeading")
            : lapsed || !shown
              ? t("posKasirGateway.code.lapsedHeading")
              : heading
        }
        description={
          cancelling
            ? t("posKasirGateway.code.cancellingBody")
            : lapsed
              ? t("posKasirGateway.code.lapsedBody")
              : shown
                ? description
                : t("posKasirGateway.code.hiddenBody")
        }
        remainingMs={shown ? remainingMs : undefined}
        noticeTitle={
          shown ? noticeTitle : t("posKasirGateway.code.oneCodeTitle")
        }
        noticeBody={
          shown ? noticeBody : t("posKasirGateway.code.oneCodeBody")
        }
        action={
          canRelease ? (
            <Button variant="outline" onClick={() => setReleasing(true)}>
              {t("posKasirGateway.code.release")}
            </Button>
          ) : (
            attempt.cancellable && (
              <Button
                variant="outline"
                loading={cancel.isPending}
                onClick={() =>
                  cancel.mutate({ orderId, attemptId: attempt.id, method })
                }
              >
                {t("posKasirGateway.code.cancel")}
              </Button>
            )
          )
        }
      >
        {shown && children}
        {!shown && opensAt !== undefined && !canRelease && (
          <p className="text-base text-muted-foreground">
            {t("posKasirGateway.code.releaseAfter", {
              time: formatClock(opensAt, timeZone),
            })}
          </p>
        )}
        {cancel.error != null && (
          <BlockNotice>
            <ErrorNotice
              error={cancel.error}
              title={t("posKasirGateway.code.cancelError")}
            />
          </BlockNotice>
        )}
      </WaitingPanel>
      <ReleaseCodeDialog
        orderId={orderId}
        amountIdr={attempt.amountIdr}
        open={releasing}
        onOpenChange={setReleasing}
      />
    </LiveRegion>
  );
}

/**
 * The manager's PIN approves a void of exactly the held amount on this bill;
 * the server then releases the code (or refuses: paid meanwhile, too early,
 * customer money still parked). The bill opens only on its answer.
 */
function ReleaseCodeDialog({
  orderId,
  amountIdr,
  open,
  onOpenChange,
}: {
  orderId: string;
  amountIdr: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const approvers = useResolveApprovers("void", open);
  const release = useReleaseOnlineCode();
  const [pickedId, setPickedId] = useState<string>();
  const [formError, setFormError] = useState<string | null>(null);
  const options = approvers.data ?? [];
  const approverUserId = (
    options.find((option) => option.userId === pickedId) ?? options[0]
  )?.userId;

  return (
    <SupervisorPinDialog
      open={open}
      onOpenChange={(next) => {
        // Stay open while the server decides.
        if (!next && release.isPending) return;
        setFormError(null);
        release.reset();
        onOpenChange(next);
      }}
      title={t("posKasirGateway.code.releaseTitle")}
      summary={t("posKasirGateway.code.releaseSummary", {
        amount: formatRupiah(amountIdr),
      })}
      details={
        <div className="grid gap-3">
          {(approvers.isError || approvers.data?.length === 0) && (
            <Notice
              tone="warning"
              title={t(
                approvers.isError
                  ? "posCorrection.approval.supervisorsError"
                  : "posCorrection.approval.supervisorsEmpty",
              )}
            />
          )}
          <FormField
            label={t("posCorrection.approval.supervisorLabel")}
            hint={t("posCorrection.approval.supervisorHint")}
            required
          >
            <Select
              value={approverUserId ?? ""}
              onValueChange={(next) => setPickedId(next || undefined)}
              disabled={release.isPending}
            >
              <SelectTrigger className="h-control">
                <SelectValue
                  placeholder={t(
                    "posCorrection.approval.supervisorPlaceholder",
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.userId} value={option.userId}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>
      }
      onSubmit={({ reason, pin }) => {
        if (release.isPending) return;
        if (!approverUserId)
          return setFormError(
            t("posCorrection.approval.supervisorPlaceholder"),
          );
        setFormError(null);
        // Each try is a new approval, so a new key. After a lost answer the
        // server finds the code already released and the bill reads open.
        const key = `release:${crypto.randomUUID()}`;
        release.mutate(
          { orderId, amountIdr, reason, approverUserId, pin, key },
          { onSuccess: () => onOpenChange(false) },
        );
      }}
      pending={release.isPending}
      error={
        formError ??
        (release.error
          ? `${t("posKasirGateway.code.releaseError")}: ${release.error.message}`
          : null)
      }
      minReasonLength={4}
    />
  );
}
