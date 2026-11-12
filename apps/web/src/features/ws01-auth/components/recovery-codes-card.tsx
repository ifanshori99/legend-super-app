import * as React from "react";
import { Check, Copy } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { recoveryCodesClipboardText } from "../recovery-state";

/**
 * The ten codes, shown once (mockup platform/mfa-recovery-sw980, state
 * "codes"). The plaintext exists only in the generate response, so the person
 * must confirm that they saved it before the card goes away.
 */
export function RecoveryCodesCard({
  codes,
  onSaved,
  saving = false,
  showTips = true,
}: {
  codes: readonly string[];
  onSaved: () => void;
  saving?: boolean;
  showTips?: boolean;
}) {
  const t = useT();
  const [copyState, setCopyState] = React.useState<
    "idle" | "copied" | "failed"
  >("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(recoveryCodesClipboardText(codes));
      setCopyState("copied");
    } catch {
      // Clipboard can be blocked; the codes stay selectable on screen.
      setCopyState("failed");
    }
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="type-heading">{t("staffAuth.recovery.saveTitle")}</h2>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("staffAuth.recovery.saveDescription")}
        </p>
      </div>

      <p
        role="note"
        className="rounded-container border-l-4 border-warning bg-warning-subtle p-3 text-sm leading-5 text-warning"
      >
        <strong>{t("staffAuth.recovery.onceTitle")}</strong>{" "}
        {t("staffAuth.recovery.onceBody")}
      </p>

      <ul
        aria-label={t("staffAuth.recovery.codesLabel")}
        className="grid grid-cols-1 gap-2 rounded-container border-(length:--border-w) bg-surface-2 p-4 font-mono text-sm font-semibold tracking-wider select-all min-[420px]:grid-cols-2"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <p className="text-xs leading-4 text-muted-foreground">
        {t("staffAuth.recovery.singleUse")}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className="flex-1 sm:flex-none"
          onClick={() => void copy()}
        >
          {copyState === "copied" ? (
            <Check aria-hidden="true" />
          ) : (
            <Copy aria-hidden="true" />
          )}
          {t("staffAuth.recovery.copy")}
        </Button>
        <Button
          type="button"
          className="flex-1 sm:flex-none"
          loading={saving}
          onClick={onSaved}
        >
          {t("staffAuth.recovery.saved")}
        </Button>
      </div>
      {/* The live region exists before the message appears, so it is announced. */}
      <p
        role="status"
        aria-live="polite"
        className="text-xs leading-4 text-muted-foreground empty:hidden"
      >
        {copyState === "copied"
          ? t("staffAuth.recovery.copied")
          : copyState === "failed"
            ? t("staffAuth.recovery.copyFailed")
            : null}
      </p>

      {showTips && (
        <div className="grid gap-3 border-t-(length:--border-w) pt-4">
          <h3 className="type-heading">{t("staffAuth.recovery.tipsTitle")}</h3>
          <div className="grid gap-0.5">
            <p className="text-sm leading-5 font-semibold">
              {t("staffAuth.recovery.tipPrivateTitle")}
            </p>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("staffAuth.recovery.tipPrivateBody")}
            </p>
          </div>
          <div className="grid gap-0.5">
            <p className="text-sm leading-5 font-semibold">
              {t("staffAuth.recovery.tipUseTitle")}
            </p>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("staffAuth.recovery.tipUseBody")}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
