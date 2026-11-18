// "Jurnalkan penerimaan" confirmation (bead legend-efdx6; API legend-7e0q4).
// Books the accepted stock value of one goods receipt into the ledger. The
// journal cannot be deleted, and a receipt whose stock already sits in a
// manual opening journal would count inventory twice, so the reviewer must
// tick that they checked before the button enables. Refusals stay inside the
// dialog in plain words; the server never writes anything on a refusal.
import * as React from "react";
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { ApiError } from "@/lib/api/errors";
import type { MessageKey } from "@starter/shared/i18n";
import {
  goodsReceiptValueIdr,
  type GoodsReceipt,
} from "@starter/shared/inventory";
import {
  useGoodsReceipt,
  useJournalizeGoodsReceipt,
} from "../receiving-hooks.ts";
import { formatBusinessDate } from "../receiving-lib.ts";

const P = "inventoryReceiving.journalize";
const key = (suffix: string) => `${P}.${suffix}` as MessageKey;

/**
 * The server names the cause in parentheses, e.g. "(PERIOD_CLOSED)". Known
 * causes get their own sentence; an unreadable one keeps the general text.
 */
function parkedKey(message: string): MessageKey {
  const code = /\(([A-Z_]+)\)/.exec(message)?.[1];
  if (
    code === "ACCOUNT_MAPPING_MISSING" ||
    code === "ACCOUNT_INACTIVE" ||
    code === "ACCOUNT_NOT_POSTABLE" ||
    code === "ACCOUNT_ENTITY_MISMATCH"
  )
    return key("errors.parkedMapping");
  if (code === "PERIOD_CLOSED") return key("errors.parkedPeriod");
  if (code === "OUTLET_LEGAL_ENTITY_MISSING") return key("errors.parkedEntity");
  return key("errors.parked");
}

/** Refusal of the journalize call → the sentence the user must read. */
export function journalizeErrorKey(error: unknown): MessageKey {
  if (error instanceof ApiError) {
    if (error.status === 0 || error.code === "NETWORK_ERROR")
      return key("errors.network");
    if (error.code === "SUPPLIER_INVOICE_POSTING_DISABLED")
      return key("errors.postingDisabled");
    if (error.code === "GOODS_RECEIPT_JOURNAL_PARKED")
      return parkedKey(error.message);
    if (error.status === 422) return key("errors.zeroValue");
    if (error.status === 404 || error.code === "NOT_FOUND")
      return key("errors.notFound");
    if (error.status === 403 || error.code === "FORBIDDEN")
      return key("errors.forbidden");
  }
  return key("errors.generic");
}

export function JournalizeReceiptDialog({
  receipt,
  supplierName,
  onClose,
}: {
  receipt: Pick<GoodsReceipt, "id" | "number" | "receivedOn">;
  supplierName: string;
  onClose: () => void;
}) {
  const t = useT();
  const journalize = useJournalizeGoodsReceipt();
  // Accepted-only stock value, shown so the reviewer sees what will book.
  const detail = useGoodsReceipt(receipt.id);
  const valueIdr = detail.data
    ? goodsReceiptValueIdr(detail.data.data.lines, "half_up")
    : null;
  const [confirmed, setConfirmed] = React.useState(false);
  const [error, setError] = React.useState<MessageKey | null>(null);
  const [result, setResult] = React.useState<
    "posted" | "already_posted" | null
  >(null);
  const checkId = React.useId();
  const doneRef = React.useRef<HTMLButtonElement>(null);
  // The form is replaced by the result: move focus to its only button so a
  // keyboard or screen reader user lands on the outcome, not on <body>.
  React.useEffect(() => {
    if (result) doneRef.current?.focus();
  }, [result]);
  const valueReady = valueIdr !== null && valueIdr > 0;

  const send = async () => {
    if (journalize.isPending) return;
    setError(null);
    try {
      const response = await journalize.mutateAsync(receipt.id);
      setResult(response.data.status);
    } catch (caught) {
      setError(journalizeErrorKey(caught));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !journalize.isPending) onClose();
      }}
    >
      <DialogContent
        data-testid="journalize-receipt-dialog"
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>
            {t(key("title"), { number: receipt.number })}
          </DialogTitle>
          <DialogDescription>{t(key("description"))}</DialogDescription>
        </DialogHeader>

        {result ? (
          <>
            <div
              role="status"
              aria-live="polite"
              data-testid="journalize-receipt-success"
              className="grid gap-1 rounded-container border-(length:--border-w) border-success bg-success-subtle p-3 text-sm text-foreground"
            >
              <p className="flex items-center gap-2 font-semibold">
                <CircleCheck className="size-4 shrink-0" aria-hidden="true" />
                {t(
                  key(result === "posted" ? "successTitle" : "alreadyTitle"),
                )}{" "}
                · {receipt.number}
              </p>
              <p>
                {t(key(result === "posted" ? "successBody" : "alreadyBody"))}
              </p>
            </div>
            <DialogFooter>
              <Button
                ref={doneRef}
                type="button"
                className="min-h-11"
                onClick={onClose}
              >
                {t(key("done"))}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <section
              aria-label={t(key("summary"))}
              className="grid gap-1 rounded-container bg-surface-2 p-3 text-sm"
            >
              <p className="font-semibold">{receipt.number}</p>
              <p className="text-muted-foreground">
                {supplierName} · {formatBusinessDate(receipt.receivedOn)}
              </p>
              {detail.isPending ? (
                <div aria-busy="true">
                  <span className="sr-only">{t("common.loading")}</span>
                  <Skeleton className="h-row" />
                </div>
              ) : valueIdr !== null ? (
                <p className="flex flex-wrap items-center gap-x-2">
                  <span className="text-muted-foreground">
                    {t(key("valueLabel"))}
                  </span>
                  <Money amount={valueIdr} size="sm" />
                </p>
              ) : null}
            </section>

            {detail.isError && (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-2 text-sm font-medium text-danger"
              >
                <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
                <span>{t(key("detailError"))}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void detail.refetch()}
                >
                  {t("common.retry")}
                </Button>
              </div>
            )}

            {valueIdr === 0 && (
              <p
                role="alert"
                data-testid="journalize-receipt-zero"
                className="flex items-start gap-2 text-sm font-medium text-danger"
              >
                <CircleAlert
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                {t(key("zeroValueNotice"))}
              </p>
            )}

            <div
              role="note"
              className="flex items-start gap-2 rounded-container border-(length:--border-w) border-warning bg-warning-subtle p-3 text-sm text-foreground"
            >
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              <div className="grid gap-1">
                <p className="font-semibold">{t(key("warningTitle"))}</p>
                <p>{t(key("warning"))}</p>
              </div>
            </div>

            <label
              htmlFor={checkId}
              className="flex min-h-11 items-start gap-3 py-2"
            >
              <Checkbox
                id={checkId}
                checked={confirmed}
                disabled={journalize.isPending}
                onCheckedChange={(next) => setConfirmed(next === true)}
              />
              <span className="text-sm leading-5 font-medium">
                {t(key("confirmCheck"))}
              </span>
            </label>

            {error && (
              <p
                role="alert"
                data-testid="journalize-receipt-error"
                className="flex items-start gap-2 text-sm font-medium text-danger"
              >
                <CircleAlert
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                {t(error)}
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={journalize.isPending}
                onClick={onClose}
              >
                {t(key("back"))}
              </Button>
              <Button
                type="button"
                className="min-h-11"
                loading={journalize.isPending}
                disabled={!confirmed || !valueReady}
                onClick={() => void send()}
              >
                {t(key("submit"))}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
