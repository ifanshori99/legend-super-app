// The question box. The label is always visible (not a placeholder); Enter
// sends; while an answer is on its way or typing in, "Kirim" becomes
// "Hentikan".
import { useId } from "react";
import { AI_QUESTION_MAX } from "@starter/shared/ai";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  busy,
  disabled,
  quota,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  /** An answer is pending or typing in. */
  busy: boolean;
  /** Asking is paused (quota, budget, feature off, offline). */
  disabled: boolean;
  quota: { left: number; limit: number } | null;
}) {
  const t = useT();
  const id = useId();
  const noteId = `${id}-note`;
  const canSend = !disabled && value.trim().length > 0;
  return (
    <form
      className="grid gap-2 border-t-(length:--border-w) pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend && !busy) onSubmit();
      }}
    >
      <Label htmlFor={id} className="font-semibold">
        {t("aiChat.composer.label")}
      </Label>
      <div className="flex gap-2.5">
        <Input
          id={id}
          value={value}
          maxLength={AI_QUESTION_MAX}
          disabled={disabled}
          autoComplete="off"
          aria-describedby={noteId}
          placeholder={t("aiChat.composer.placeholder")}
          className="min-h-11 flex-1"
          onChange={(event) => onChange(event.target.value)}
        />
        {busy ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 shrink-0"
            onClick={onStop}
          >
            {t("aiChat.answer.stop")}
          </Button>
        ) : (
          <Button
            type="submit"
            className="min-h-11 shrink-0"
            disabled={!canSend}
          >
            {t("aiChat.composer.send")}
          </Button>
        )}
      </div>
      <p id={noteId} className="text-sm text-muted-foreground">
        {t("aiChat.composer.note")}
        {quota &&
          ` ${t("aiChat.composer.remaining", { left: quota.left, limit: quota.limit })}`}
      </p>
    </form>
  );
}
