import { useEffect, useRef, useState } from "react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  isContractPending,
  useApplyVoucher,
  useValidateVoucher,
} from "../../hooks";
import { Notice, PosPanel } from "../shared";
import type { AdjustmentPanelProps } from "./adjustment-types";

// Voucher at the cashier (brief 936): key in or scan a code, check it, then
// apply it. The discount shown is the server's preview; the server prices the
// real discount when the voucher is applied. Scanners act as a keyboard, so
// Enter checks the code.
export function VoucherPanel({
  orderId,
  onDone,
  onCancel,
}: AdjustmentPanelProps) {
  const t = useT();
  const validate = useValidateVoucher(orderId);
  const apply = useApplyVoucher(orderId);
  const [code, setCode] = useState("");

  const normalized = code.trim().toUpperCase();
  const busy = validate.isPending || apply.isPending;
  const check = validate.data;
  // The result belongs to the code that was checked, not to later keystrokes.
  const current = check && check.code === normalized ? check : undefined;

  // A failed call (not "not connected yet") gets "Coba lagi" as the main action.
  const retryApply = apply.error != null && !isContractPending(apply.error);
  const retryCheck =
    !retryApply && validate.error != null && !isContractPending(validate.error);
  const failed = retryApply || retryCheck;

  // The footer is sticky and covers the end of the panel at narrow widths:
  // bring a new result into view (the `scroll-mb` below keeps it above the
  // footer). Reduced motion jumps instead of gliding.
  const resultRef = useRef<HTMLDivElement>(null);
  const resultKey = `${current?.valid}:${validate.error ? 1 : 0}:${apply.error ? 1 : 0}`;
  useEffect(() => {
    if (resultKey === "undefined:0:0") return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    resultRef.current?.scrollIntoView({
      block: "nearest",
      behavior: reduced.matches ? "auto" : "smooth",
    });
  }, [resultKey]);

  function runCheck() {
    if (busy || normalized === "") return;
    apply.reset();
    validate.mutate({ code: normalized });
  }

  function runApply() {
    if (busy || !current?.valid) return;
    apply.mutate({ code: current.code }, { onSuccess: () => onDone() });
  }

  return (
    <PosPanel
      title={t("posKasirVoucher.title")}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={apply.isPending}
            onClick={onCancel}
          >
            {t("posKasirVoucher.cancel")}
          </Button>
          {failed ? (
            <Button
              type="button"
              disabled={busy}
              aria-busy={busy}
              onClick={retryApply ? runApply : runCheck}
            >
              {t("posKasirVoucher.retry")}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={busy || !current?.valid}
              aria-busy={apply.isPending}
              onClick={runApply}
            >
              {apply.isPending
                ? t("posKasirVoucher.applying")
                : t("posKasirVoucher.apply")}
            </Button>
          )}
        </>
      }
    >
      <form
        className="mx-auto grid max-w-xl gap-4 pb-28"
        onSubmit={(event) => {
          event.preventDefault();
          runCheck();
        }}
      >
        <div className="grid gap-2">
          <Label htmlFor={`voucher-code-${orderId}`}>
            {t("posKasirVoucher.codeLabel")}
          </Label>
          <div className="flex gap-2">
            <Input
              id={`voucher-code-${orderId}`}
              value={code}
              name="voucher"
              // The scanner is the main way to enter a code and types into the
              // focused field, so the field takes focus when the panel opens.
              autoFocus
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder={t("posKasirVoucher.codePlaceholder")}
              aria-describedby={`voucher-hint-${orderId}`}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={busy || normalized === ""}
              aria-busy={validate.isPending}
            >
              {validate.isPending
                ? t("posKasirVoucher.checking")
                : t("posKasirVoucher.check")}
            </Button>
          </div>
          <p
            id={`voucher-hint-${orderId}`}
            className="text-base text-muted-foreground"
          >
            {t("posKasirVoucher.scanHint")}
          </p>
        </div>

        <div ref={resultRef} className="grid scroll-mb-28 gap-4">
          {/* Only the valid result sits in the live region. Danger notices carry
            role="alert" and are announced by themselves; nesting them in a polite
            region would read them twice. */}
          <div aria-live="polite">
            {current?.valid === true && (
              <Notice tone="info" title={t("posKasirVoucher.valid.title")}>
                <p className="font-semibold">
                  {t("posKasirVoucher.valid.discount", {
                    amount: formatRupiah(current.discountPreviewIdr),
                  })}
                </p>
                <p>{t("posKasirVoucher.valid.estimateHint")}</p>
              </Notice>
            )}
          </div>
          {validate.error && (
            <VoucherError
              error={validate.error}
              title={t("posKasirVoucher.checkError")}
              hint={t("posKasirVoucher.checkErrorHint")}
            />
          )}
          {apply.error && (
            <VoucherError
              error={apply.error}
              title={t("posKasirVoucher.applyError")}
              hint={t("posKasirVoucher.applyErrorHint")}
            />
          )}
          {current?.valid === false && (
            <Notice tone="danger" title={t("posKasirVoucher.invalid.title")}>
              {t(`posKasirVoucher.invalid.reason.${current.reason}`)}
            </Notice>
          )}
        </div>
      </form>
    </PosPanel>
  );
}

// A failed call, in catalog words only: the server's raw message is never shown.
function VoucherError({
  error,
  title,
  hint,
}: {
  error: unknown;
  title: string;
  hint: string;
}) {
  const t = useT();
  if (isContractPending(error))
    return (
      <Notice
        tone="warning"
        role="status"
        title={t("posKasirVoucher.contractPending")}
      >
        {t("posKasirVoucher.contractPendingHint")}
      </Notice>
    );
  return (
    <Notice tone="danger" title={title}>
      {hint}
    </Notice>
  );
}
