// The question box: a rounded pill with "Kirim" inside, pinned by the page at
// the bottom of the chat column. The label is always visible (not a
// placeholder); Enter sends; while an answer is on its way or typing in, "Kirim" becomes
// "Hentikan".
import { useId, type Ref } from "react";
import { AI_QUESTION_MAX } from "@starter/shared/ai";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function Composer({
  inputRef,
  value,
  onChange,
  onSubmit,
  onStop,
  busy,
  disabled,
  quota,
}: {
  /** Lets the page move focus here (e.g. after "Tanya ulang"). */
  inputRef?: Ref<HTMLInputElement>;
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
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend && !busy) onSubmit();
      }}
    >
      <Label htmlFor={id} className="font-semibold">
        {t("aiChat.composer.label")}
      </Label>
      <div
        className={cn(
          "flex items-center gap-2 rounded-container border-(length:--border-w) border-input bg-background p-1.5 ps-4 shadow-hairline transition-[border-color,box-shadow] duration-(--duration-fast) focus-within:border-primary focus-within:shadow-focus",
          disabled && "bg-muted opacity-60",
        )}
      >
        <Input
          id={id}
          ref={inputRef}
          value={value}
          maxLength={AI_QUESTION_MAX}
          disabled={disabled}
          autoComplete="off"
          aria-describedby={noteId}
          placeholder={t("aiChat.composer.placeholder")}
          className="h-11 min-h-11 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:border-0 focus-visible:shadow-none disabled:bg-transparent disabled:opacity-100"
          onChange={(event) => onChange(event.target.value)}
        />
        {busy ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 shrink-0 rounded-container"
            onClick={onStop}
          >
            {t("aiChat.answer.stop")}
          </Button>
        ) : (
          <Button
            type="submit"
            className="min-h-11 shrink-0 rounded-container disabled:border-(length:--border-w) disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 disabled:shadow-none"
            disabled={!canSend}
          >
            {t("aiChat.composer.send")}
          </Button>
        )}
      </div>
      <p id={noteId} className="text-center text-sm text-muted-foreground">
        {t("aiChat.composer.note")}
        {quota &&
          ` ${t("aiChat.composer.remaining", { left: quota.left, limit: quota.limit })}`}
      </p>
    </form>
  );
}
