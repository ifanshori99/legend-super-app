// The two choices of ORD-08 (PRD §3 F10): "Ganti menu" (price difference paid
// or credited) or "Kredit ke voucher". Nothing else is ever offered. The
// difference and the voucher value come from the server (ORD-03).
import { useState } from "react";
import { cn } from "cn";
import { CircleAlert } from "lucide-react";
import { RadioGroup } from "radix-ui";
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
import { ApiError } from "@/lib/api/errors";
import { QrFooter } from "../glass/qr-primitives";
import type { GuestOrderIssue } from "@starter/shared/qr-order";

type Choice = "swap" | "voucher";

export type IssueChoicesSubmit = {
  choice: Choice;
  replacementItemId?: string;
};

type IssueChoicesProps = {
  issue: GuestOrderIssue;
  pending: boolean;
  /** Set once the choice was saved; the page re-renders from the refreshed issue. */
  saved: boolean;
  error: unknown;
  offline: boolean;
  onSubmit: (input: IssueChoicesSubmit) => void;
  onClearError: () => void;
  onReload: () => void;
};

function DifferenceText({ amountIdr }: { amountIdr: number }) {
  const t = useT();
  if (amountIdr === 0)
    return <span>{t("qrRecovery.issue.choices.swap.diffEven")}</span>;
  return (
    <span>
      {amountIdr > 0
        ? t("qrRecovery.issue.choices.swap.diffPay")
        : t("qrRecovery.issue.choices.swap.diffCredit")}{" "}
      <Money amount={Math.abs(amountIdr)} size="sm" />
    </span>
  );
}

function Indicator() {
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border-(length:--border-w) border-input bg-card group-data-[state=checked]:border-primary"
    >
      <RadioGroup.Indicator className="size-2.5 rounded-full bg-primary" />
    </span>
  );
}

const ITEM_CLASS =
  "group flex w-full min-h-14 items-start gap-3 p-4 text-left disabled:cursor-not-allowed disabled:opacity-60";

function errorMessageKey(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 409 || error.code.includes("CONFLICT"))
      return "conflict" as const;
    if (error.status === 422) return "notAllowed" as const;
    if (error.status === 0 || error.code === "NETWORK_ERROR")
      return "network" as const;
  }
  return "generic" as const;
}

export function IssueChoices({
  issue,
  pending,
  saved,
  error,
  offline,
  onSubmit,
  onClearError,
  onReload,
}: IssueChoicesProps) {
  const t = useT();
  const [choice, setChoice] = useState<Choice | "">("");
  const [replacementId, setReplacementId] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const { swap, voucher } = issue.options;
  const swapAvailable = swap.allowed && swap.items.length > 0;
  const selected = swap.items.find((item) => item.menuItemId === replacementId);
  const valid =
    (choice === "voucher" && voucher.allowed) ||
    (choice === "swap" && swapAvailable && selected !== undefined);
  // A swap with a payable difference asks once more, with the amount (ORD-03).
  const needsConfirm =
    choice === "swap" && selected !== undefined && selected.differenceIdr > 0;

  function submit() {
    setConfirmOpen(false);
    if (choice === "voucher") onSubmit({ choice });
    else if (choice === "swap" && selected)
      onSubmit({ choice, replacementItemId: selected.menuItemId });
  }

  function pickChoice(next: string) {
    onClearError();
    setChoice(next as Choice);
  }

  const errorKey = error ? errorMessageKey(error) : null;

  // A fragment: the page grid spaces the parts and QrFooter stays its last
  // child, so the sticky footer is not clipped by a wrapper.
  return (
    <>
      <RadioGroup.Root
        value={choice}
        onValueChange={pickChoice}
        aria-label={t("qrRecovery.issue.choices.label")}
        className="grid gap-3"
        disabled={pending || saved}
      >
        <div
          className={cn(
            "rounded-qr-media border-(length:--border-w)",
            choice === "swap"
              ? "border-primary bg-qr-selection"
              : "border-border bg-card",
          )}
        >
          <RadioGroup.Item
            value="swap"
            disabled={!swapAvailable}
            aria-describedby="issue-swap-hint"
            className={cn(ITEM_CLASS, "rounded-qr-media")}
          >
            <Indicator />
            <span className="grid gap-0.5">
              <span className="font-semibold">
                {t("qrRecovery.issue.choices.swap.title")}
              </span>
              <span
                id="issue-swap-hint"
                className="text-sm text-muted-foreground"
              >
                {swapAvailable
                  ? t("qrRecovery.issue.choices.swap.hint")
                  : t("qrRecovery.issue.choices.swap.unavailable")}
              </span>
            </span>
          </RadioGroup.Item>

          {choice === "swap" && swapAvailable && (
            <div className="border-t-(length:--border-w) border-border px-4 pt-3 pb-2">
              <RadioGroup.Root
                value={replacementId}
                onValueChange={(next) => {
                  onClearError();
                  setReplacementId(next);
                }}
                aria-label={t("qrRecovery.issue.choices.swap.listLabel")}
                disabled={pending || saved}
                className="divide-y-(length:--border-w) divide-border"
              >
                {swap.items.map((item) => (
                  <RadioGroup.Item
                    key={item.menuItemId}
                    value={item.menuItemId}
                    className="group flex w-full min-h-14 items-start gap-3 py-3 text-left disabled:opacity-60"
                  >
                    <Indicator />
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="font-semibold">{item.name}</span>
                        <Money amount={item.priceIdr} />
                      </span>
                      <span className="text-sm text-muted-foreground">
                        <DifferenceText amountIdr={item.differenceIdr} />
                      </span>
                    </span>
                  </RadioGroup.Item>
                ))}
              </RadioGroup.Root>
            </div>
          )}
        </div>

        <div
          className={cn(
            "rounded-qr-media border-(length:--border-w)",
            choice === "voucher"
              ? "border-primary bg-qr-selection"
              : "border-border bg-card",
          )}
        >
          <RadioGroup.Item
            value="voucher"
            disabled={!voucher.allowed}
            aria-describedby="issue-voucher-hint"
            className={cn(ITEM_CLASS, "rounded-qr-media")}
          >
            <Indicator />
            <span className="grid gap-0.5">
              <span className="font-semibold">
                {t("qrRecovery.issue.choices.voucher.title")}
              </span>
              <span id="issue-voucher-hint" className="grid text-sm">
                {voucher.allowed ? (
                  <>
                    <span>
                      {t("qrRecovery.issue.choices.voucher.value")}{" "}
                      <Money amount={voucher.valueIdr} size="sm" />
                    </span>
                    <span className="text-muted-foreground">
                      {t("qrRecovery.issue.choices.voucher.hint")}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">
                    {t("qrRecovery.issue.choices.voucher.unavailable")}
                  </span>
                )}
              </span>
            </span>
          </RadioGroup.Item>
        </div>
      </RadioGroup.Root>

      {errorKey && (
        <div
          role="alert"
          className="flex flex-wrap items-start gap-2 rounded-qr-media border-l-[3px] border-danger bg-danger-subtle p-3 text-sm text-foreground"
        >
          <CircleAlert
            className="mt-0.5 size-4 shrink-0 text-danger"
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1 font-medium">
            {t(`qrRecovery.issue.errors.${errorKey}`)}
          </p>
          {errorKey === "conflict" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onReload}
            >
              {t("qrRecovery.issue.errors.reload")}
            </Button>
          )}
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("qrRecovery.issue.confirmDialog.title", {
                name: selected?.name ?? "",
              })}
            </DialogTitle>
            <DialogDescription>
              {t("qrRecovery.issue.confirmDialog.body")}
            </DialogDescription>
          </DialogHeader>
          {selected && <Money amount={selected.differenceIdr} size="stat" />}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="button" onClick={submit}>
              {t("qrRecovery.issue.confirmDialog.action")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <QrFooter className="gap-2">
        <Button
          type="button"
          size="lg"
          disabled={!valid || offline || saved}
          loading={pending}
          onClick={() => (needsConfirm ? setConfirmOpen(true) : submit())}
        >
          {t("qrRecovery.issue.choices.confirm")}
        </Button>
        {!valid && (
          <p className="text-center text-sm text-muted-foreground">
            {t("qrRecovery.issue.choices.pickHint")}
          </p>
        )}
      </QrFooter>
    </>
  );
}
