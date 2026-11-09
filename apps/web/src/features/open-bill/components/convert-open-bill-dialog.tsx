// "Jadikan open bill" on the POS table panel: a supervisor turns a running
// pay-first session into an open bill with a reason and PIN (bead legend-8cm4).
// The outlet limit shows first; at or over it the dialog refuses without a PIN
// pad. The server decides again on submit (step 2).
import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
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
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { cn } from "cn";
import { formatRupiah } from "@starter/shared/i18n";
import type {
  FloorBoard,
  OpenBillPolicy,
  TableLiveStatus,
} from "@starter/shared/qr-order";
import { SupervisorPinDialog } from "../../ws04-pos-kasir/components/shared/supervisor-pin-dialog";
import { useConvertToOpenBill, useOpenBillPolicy } from "../hooks";
import { isOverOpenBillLimit, openBillErrorKey } from "../lib";

type Props = {
  row: TableLiveStatus;
  outletId: FloorBoard["outletId"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The session became an open bill: the parent closes the table panel. */
  onDone: () => void;
};

function LimitRow({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular">{children}</dd>
    </div>
  );
}

// The "Batas outlet" block: the numbers the approval is judged against.
function LimitsBlock({
  policy,
  outstandingIdr,
}: {
  policy: OpenBillPolicy;
  outstandingIdr: number;
}) {
  const t = useT();
  return (
    <section
      aria-label={t("openBillConvert.limits.title")}
      className="grid gap-2 rounded-lg border border-border bg-muted/40 p-3"
    >
      <h3 className="text-sm font-semibold text-foreground">
        {t("openBillConvert.limits.title")}
      </h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <LimitRow label={t("openBillConvert.limits.max")}>
          <Money amount={policy.maxBillValueIdr} size="sm" />
        </LimitRow>
        <LimitRow label={t("openBillConvert.limits.outstanding")}>
          <Money amount={outstandingIdr} size="sm" />
        </LimitRow>
        <LimitRow
          label={t("openBillConvert.limits.idle")}
          className="col-span-2 sm:col-span-1"
        >
          {t("openBillConvert.limits.idleValue", {
            minutes: policy.inactivityMinutes,
          })}
        </LimitRow>
      </dl>
    </section>
  );
}

// A plain dialog for the states that never show the PIN pad.
function NoPinDialog({
  title,
  open,
  onOpenChange,
  description,
  children,
  footer,
}: {
  title: string;
  /** Only when it fits the state; these states never show the success summary. */
  description?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        {...(description ? {} : { "aria-describedby": undefined })}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        <DialogFooter>
          {footer}
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
          >
            {t("openBillConvert.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AlertBlock({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg bg-warning-subtle p-3 text-sm text-foreground"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="grid gap-1">
        {title && <p className="font-semibold">{title}</p>}
        <p>{children}</p>
      </div>
    </div>
  );
}

export function ConvertOpenBillDialog({
  row,
  outletId,
  open,
  onOpenChange,
  onDone,
}: Props) {
  const t = useT();
  const toast = useToast();
  const policyQuery = useOpenBillPolicy(outletId);
  const convert = useConvertToOpenBill();
  const session = row.session;
  if (!session) return null;
  const title = t("openBillConvert.title", { code: row.table.code });
  const policy = policyQuery.data;

  if (!policy && policyQuery.isError) {
    return (
      <NoPinDialog
        title={title}
        open={open}
        onOpenChange={onOpenChange}
        footer={
          <Button
            type="button"
            loading={policyQuery.isFetching}
            onClick={() => void policyQuery.refetch()}
          >
            {t("openBillConvert.retry")}
          </Button>
        }
      >
        <AlertBlock>{t("openBillConvert.policyError")}</AlertBlock>
      </NoPinDialog>
    );
  }

  if (!policy) {
    return (
      <NoPinDialog title={title} open={open} onOpenChange={onOpenChange}>
        <div
          aria-busy="true"
          className="grid gap-2 rounded-lg border border-border bg-muted/40 p-3"
        >
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
        </div>
      </NoPinDialog>
    );
  }

  if (isOverOpenBillLimit(row.outstandingIdr, policy)) {
    return (
      <NoPinDialog title={title} open={open} onOpenChange={onOpenChange}>
        <LimitsBlock policy={policy} outstandingIdr={row.outstandingIdr} />
        <AlertBlock title={t("openBillConvert.over.title")}>
          {t("openBillConvert.over.body", {
            outstanding: formatRupiah(row.outstandingIdr),
            limit: formatRupiah(policy.maxBillValueIdr),
          })}
        </AlertBlock>
      </NoPinDialog>
    );
  }

  return (
    <SupervisorPinDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      summary={t("openBillConvert.summary")}
      details={
        <div className="grid gap-3">
          <LimitsBlock policy={policy} outstandingIdr={row.outstandingIdr} />
          <p className="text-sm text-muted-foreground">
            {t("openBillConvert.who")}
          </p>
        </div>
      }
      minReasonLength={3}
      pending={convert.isPending}
      error={convert.error ? t(openBillErrorKey(convert.error)) : null}
      onSubmit={({ reason, pin }) =>
        convert.mutate(
          { sessionId: session.id, reason, pin },
          {
            onSuccess: () => {
              toast({
                title: t("openBillConvert.success", { code: row.table.code }),
                tone: "success",
              });
              onOpenChange(false);
              onDone();
            },
          },
        )
      }
    />
  );
}
