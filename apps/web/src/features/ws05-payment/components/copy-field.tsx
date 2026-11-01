// A value the guest must key into a bank app: large, tabular, and copyable.
// Clipboard access can be refused (insecure context, permissions), so the
// error says to copy by hand instead of failing silently.
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function CopyField({
  label,
  value,
  mono = true,
  className,
}: {
  label: string;
  value: string;
  /** Bank numbers read better in the monospace face. */
  mono?: boolean;
  className?: string;
}) {
  const t = useT();
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div data-slot="copy-field" className={cn("grid gap-1", className)}>
      <p className="text-sm leading-5 text-muted-foreground">{label}</p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className={cn(
            "min-w-0 text-lg leading-7 font-semibold break-all tabular",
            mono && "font-mono",
          )}
        >
          {value}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={copy}
          aria-label={t("payment.copyValue", { label })}
        >
          {status === "copied" ? (
            <Check aria-hidden="true" />
          ) : (
            <Copy aria-hidden="true" />
          )}
          {status === "copied" ? t("payment.copied") : t("payment.copy")}
        </Button>
      </div>
      <p role="status" className="text-sm leading-5 text-danger">
        {status === "error" ? t("payment.copyFailed") : ""}
      </p>
    </div>
  );
}
